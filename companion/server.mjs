import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAccountStore, publicAccount } from "./accountStore.mjs";
import { authorizeRequest, DEFAULT_ORIGINS, readJson, requireLocalOrigin } from "./security.mjs";
import { decodeImages } from "./imageInput.mjs";
import { localBrowserLaunchOptions } from "./browserRuntime.mjs";
import { validateDraft } from "../lib/draftSync/validation.ts";

const reject = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const validId = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const validDraftId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
function requireText(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw reject(`${name}无效`);
  return value.trim();
}

export async function createCompanion({ dataDir, port = 47831, token = randomBytes(32).toString("base64url"), allowedOrigins = DEFAULT_ORIGINS, providers, browserFactory }) {
  if (!dataDir || token.length < 32) throw new Error("本机助手配置无效");
  allowedOrigins.forEach(requireLocalOrigin);
  const store = await createAccountStore(dataDir);
  const contexts = new Map();
  const jobs = new Map();
  const loginSessions = new Set();
  let activeLogin = null;
  let accountOperation = false;
  let activeJob = null;
  let actualPort = port;

  async function createContext(id, signal) {
    const profilePath = await store.profilePath(id);
    signal?.throwIfAborted();
    const createBrowser = browserFactory || (async (profile) => {
      const { chromium } = await import("@playwright/test");
      const browser = await localBrowserLaunchOptions();
      if (!browser) throw reject("缺少小红书登录组件。请关闭启动窗口，再双击“启动折页”完成首次准备。", 503);
      return chromium.launchPersistentContext(profile, { ...browser, headless: false, acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    });
    return createBrowser(profilePath);
  }

  function registerContext(id, context) {
    contexts.set(id, context);
    context.on?.("close", () => { if (contexts.get(id) === context) contexts.delete(id); });
  }

  async function getContext(id) {
    if (contexts.has(id)) return contexts.get(id);
    const context = await createContext(id);
    registerContext(id, context);
    return context;
  }

  function cleanupLogin(login) {
    login.cleanup ??= (async () => {
      const context = await login.contextPromise.catch(() => undefined);
      // A committed account owns its profile and is never part of cancellation.
      if (store.accounts.has(login.id)) return;
      await context?.close();
      await store.discardProfile(login.id);
    })().finally(() => loginSessions.delete(login));
    return login.cleanup;
  }

  const adapters = providers || {
    verifyWechatAccount: async (args) => (await import("./providers/wechat.mjs")).verifyWechatAccount(args),
    saveWechatDraft: async (args) => (await import("./providers/wechat.mjs")).saveWechatDraft(args),
    loginXiaohongshu: async (args) => (await import("./providers/xiaohongshu.mjs")).loginXiaohongshu(args),
    saveXiaohongshuDraft: async (args) => (await import("./providers/xiaohongshu.mjs")).saveXiaohongshuDraft(args),
  };

  async function executeJob(job, account, draft) {
    try {
      const result = account.platform === "wechat"
        ? await adapters.saveWechatDraft({ account, draft })
        : await adapters.saveXiaohongshuDraft({ context: await getContext(account.id), account, draft });
      if (!["saved", "needs_confirmation", "failed"].includes(result?.status)) throw new Error("适配器未给出有效结果");
      const draftId = validDraftId(result.draftId) ? result.draftId : undefined;
      const status = result.status === "saved" && !draftId ? "needs_confirmation" : result.status;
      const message = result.status === "saved" && !draftId
        ? "平台未返回有效草稿编号，尚不能确认保存结果。请到所选账号核对草稿后解除锁定。"
        : result.message;
      job.receipt = { accountId: account.id, platform: account.platform, status, message, ...(draftId ? { draftId } : {}) };
      if (result.url && /^https:\/\/(?:creator\.xiaohongshu\.com|mp\.weixin\.qq\.com)(?:\/|$)/.test(result.url)) job.receipt.url = result.url;
      if (status !== "needs_confirmation") {
        const unlocked = { ...store.accounts.get(account.id) };
        delete unlocked.pendingJobId;
        try { await store.set(unlocked); }
        catch {
          job.receipt.status = "needs_confirmation";
          job.receipt.message = "平台结果已返回，但本机确认记录未能保存。请到所选账号核对草稿后解除锁定。";
        }
      }
    } catch {
      job.receipt = { accountId: account.id, platform: account.platform, status: "needs_confirmation", message: "同步过程未完成确认。请到对应平台账号核对草稿结果后解除锁定。" };
    } finally { job.state = "finished"; activeJob = null; }
  }

  async function route(request, pathname) {
    if (request.method === "GET" && pathname === "/api/accounts") return { accounts: [...store.accounts.values()].map(publicAccount) };
    if (request.method === "GET" && pathname.startsWith("/api/jobs/")) {
      const id = pathname.slice("/api/jobs/".length);
      const job = validId(id) && jobs.get(id);
      if (!job) throw reject("本机助手没有此任务记录，请到平台核对结果", 404);
      return { state: job.state, ...(job.state === "finished" && job.receipt ? { receipt: job.receipt } : {}) };
    }
    if (request.method !== "POST") throw reject("此接口不受支持", 404);
    const input = await readJson(request, pathname === "/api/jobs" ? undefined : 8192);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw reject("请求格式无效");
    if (pathname === "/api/accounts/cancel-login") {
      if (Object.keys(input).length !== 1 || !validId(input.loginRequestId)) throw reject("取消登录需要有效的登录请求编号，且不接受其他参数");
      const login = activeLogin;
      if (!login || login.requestId !== input.loginRequestId) return { cancelled: false };
      if (login.committing) { await login.finished; return { cancelled: false }; }
      login.controller.abort(reject("已取消小红书登录，可以重新尝试", 409));
      void cleanupLogin(login).catch(() => {});
      await login.finished;
      return { cancelled: true };
    }
    if (pathname === "/api/accounts/wechat" || pathname === "/api/accounts/xiaohongshu") {
      if (accountOperation || activeJob) throw reject("请等待当前账号连接或同步完成", 409);
      const operation = {};
      accountOperation = operation;
      let login;
      try {
        const displayName = requireText(input.displayName, "账号备注", 80);
        if (pathname.endsWith("wechat")) {
          const appId = requireText(input.appId, "AppID", 80);
          const appSecret = requireText(input.appSecret, "AppSecret", 128);
          if (!/^wx[a-zA-Z0-9]{16}$/.test(appId)) throw reject("AppID 格式不正确");
          const verified = await adapters.verifyWechatAccount({ appId, appSecret });
          if (verified.remoteId !== appId) throw reject("公众号账号核对失败");
          const existing = [...store.accounts.values()].find((account) => account.platform === "wechat" && account.remoteId === appId);
          const account = { ...existing, id: existing?.id || randomUUID(), platform: "wechat", remoteId: appId, displayName, appId, appSecret };
          await store.set(account);
          return { account: publicAccount(account) };
        }
        if (!validId(input.loginRequestId)) throw reject("登录请求编号无效");
        const id = randomUUID();
        const controller = new AbortController();
        login = { id, requestId: input.loginRequestId, controller, committing: false };
        login.finished = new Promise((resolve) => { login.finish = resolve; });
        login.contextPromise = createContext(id, controller.signal);
        loginSessions.add(login);
        activeLogin = login;
        let onAbort;
        const cancelled = new Promise((_resolve, fail) => {
          onAbort = () => fail(controller.signal.reason);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const connect = (async () => {
          try {
            const context = await login.contextPromise;
            controller.signal.throwIfAborted();
            const verified = await adapters.loginXiaohongshu({ context, signal: controller.signal });
            controller.signal.throwIfAborted();
            if (!verified?.remoteId || typeof verified.remoteId !== "string") throw reject("未能确认创作者账号，请完成登录后重试");
            if ([...store.accounts.values()].some((account) => account.platform === "xiaohongshu" && account.remoteId === verified.remoteId)) throw reject("该小红书账号已连接，请从已有账号中选择");
            const account = { id, platform: "xiaohongshu", remoteId: verified.remoteId, displayName: `${displayName} · ${verified.displayName || verified.remoteId}` };
            // Cancellation stops before this commit boundary, never during it.
            login.committing = true;
            await store.set(account);
            registerContext(id, context);
            loginSessions.delete(login);
            return { account: publicAccount(account) };
          } catch (error) {
            await cleanupLogin(login).catch(() => {});
            throw error;
          }
        })();
        try { return await Promise.race([connect, cancelled]); }
        finally { controller.signal.removeEventListener("abort", onAbort); }
      } finally {
        if (accountOperation === operation) accountOperation = false;
        if (activeLogin === login) activeLogin = null;
        login?.finish();
      }
    }
    if (pathname === "/api/accounts/remove") {
      if (accountOperation || activeJob) throw reject("请等待当前连接或同步完成后移除账号", 409);
      if (!validId(input.accountId)) throw reject("账号标识无效");
      const account = store.accounts.get(input.accountId);
      if (!account) throw reject("账号不存在", 404);
      if (account.pendingJobId) throw reject("此账号有尚未确认的草稿，请先到平台核对并解除锁定", 409);
      accountOperation = true;
      try {
        await contexts.get(input.accountId)?.close();
        await store.remove(input.accountId);
        return { removed: true };
      } finally { accountOperation = false; }
    }
    if (pathname === "/api/jobs/acknowledge") {
      if (activeJob || accountOperation) throw reject("当前任务仍在处理，暂不能解除锁定", 409);
      if (!validId(input.accountId) || !["saved", "not_saved"].includes(input.outcome)) throw reject("请先在平台核对并选择草稿是否已保存");
      const account = store.accounts.get(input.accountId);
      if (!account) throw reject("账号不存在", 404);
      if (!account.pendingJobId) throw reject("此账号没有待核对的草稿", 409);
      accountOperation = true;
      try {
        const unlocked = { ...account };
        delete unlocked.pendingJobId;
        await store.set(unlocked);
        return { acknowledged: true };
      } finally { accountOperation = false; }
    }
    if (pathname === "/api/jobs") {
      if (!validId(input.requestId)) throw reject("请求标识无效");
      const fingerprint = createHash("sha256").update(JSON.stringify({ accountId: input.accountId, content: input.content, images: input.images })).digest("hex");
      const prior = jobs.get(input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw reject("同一请求不能更换素材", 409);
        return { id: input.requestId, state: prior.state };
      }
      const account = store.accounts.get(input.accountId);
      if (!account || !publicAccount(account).ready) throw reject("账号未连接，请先连接账号");
      if (account.pendingJobId) throw reject("此账号有尚未确认的草稿，请先到平台核对并解除锁定", 409);
      if (activeJob || accountOperation) throw reject("本机助手正在处理另一项任务，请稍后再试", 409);
      if (!input.content || typeof input.content.title !== "string" || typeof input.content.body !== "string") throw reject("标题或文案格式不正确");
      const images = decodeImages(input.images);
      const issues = validateDraft(account.platform, input.content, images.map((image) => ({ ...image, size: image.bytes.length })));
      const blocking = issues.find((issue) => issue.severity === "error");
      if (blocking) throw reject(blocking.message);
      activeJob = input.requestId;
      const locked = { ...account, pendingJobId: input.requestId };
      try { await store.set(locked); }
      catch (error) { activeJob = null; throw error; }
      const job = { state: "running", fingerprint, receipt: null };
      jobs.set(input.requestId, job);
      // Keep the idempotency ledger for this helper session; it contains no text or images.
      void executeJob(job, locked, { title: input.content.title, body: input.content.body, images });
      return { id: input.requestId, state: job.state };
    }
    throw reject("此接口不受支持", 404);
  }

  const server = http.createServer(async (request, response) => {
    const denied = authorizeRequest(request, { port: actualPort, token, allowedOrigins });
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (denied) { response.writeHead(denied.status); response.end(JSON.stringify({ error: denied.error })); return; }
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.writeHead(204); response.end(); return;
    }
    try {
      const parsed = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      if (parsed.search) throw reject("不接受查询参数");
      const result = await route(request, parsed.pathname);
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 400;
      response.writeHead(status);
      // Provider errors are deliberately not reflected: they can contain credential URLs.
      response.end(JSON.stringify({ error: typeof error?.publicMessage === "string" && error.publicMessage.trim() ? error.publicMessage : "操作未完成，请检查账号权限、网络及本机助手设置后重试" }));
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return {
    token, server,
    async listen() {
      await new Promise((resolve, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
      actualPort = server.address().port;
      return actualPort;
    },
    async close() {
      const pendingLogins = [...loginSessions];
      for (const login of pendingLogins) if (!login.committing) login.controller.abort(reject("本机助手已关闭，请重新连接账号", 409));
      await Promise.allSettled(pendingLogins.map((login) => login.committing ? login.finished : cleanupLogin(login)));
      await Promise.allSettled([...contexts.values()].map((context) => context.close()));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
