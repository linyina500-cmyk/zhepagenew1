import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createSessionSecurity } from "./session.mjs";
import { createCloudBrowser, CloudBrowserCleanupError } from "./browser.mjs";
import { readJson } from "./request.mjs";
import { decodeImages } from "./imageInput.mjs";
import { validateDraft } from "../lib/draftSync/validation.ts";

const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_BYTES = 18 * 1024 * 1024;
const reject = (message, statusCode = 400) => Object.assign(new Error(message), { publicMessage: message, statusCode });
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const validId = (id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
function text(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw reject(`${label}无效`);
  return value.trim();
}
function publicAccount(account, pendingJobId) {
  return { id: account.id, platform: account.platform, displayName: account.displayName, remoteId: account.remoteId, ready: true, syncBlocked: Boolean(pendingJobId), ...(pendingJobId ? { pendingJobId } : {}) };
}
function accountId(owner, platform, remoteId) {
  return createHash("sha256").update(JSON.stringify([owner, platform, remoteId])).digest("hex").slice(0, 32);
}

// This private deployment has one configured owner. Platform credentials are
// returned as encrypted browser-held envelopes; no account/profile files or DB.
export function createCloudSync({
  passwords, accessPassword, gatewaySecret, ownerId = "owner", allowedOrigins,
  port = 47832, host = "127.0.0.1", providers, browserFactory = createCloudBrowser,
  now = Date.now, temporarySessionMs = 10 * 60 * 1000, onCleanupFailure = () => {},
}) {
  if (typeof gatewaySecret !== "string" || gatewaySecret.length < 32 || !Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error("同步服务缺少网关密钥或网页来源配置");
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password) throw new Error("网页来源必须是完整 HTTPS origin");
  }
  const security = createSessionSecurity({ passwords, accessPassword, ownerId, now });
  const adapters = providers || {
    verifyWechatAccount: async (input) => (await import("./providers/wechat.mjs")).verifyWechatAccount(input),
    saveWechatDraft: async (input) => (await import("./providers/wechat.mjs")).saveWechatDraft(input),
    loginXiaohongshu: async (input) => (await import("./providers/xiaohongshu.mjs")).loginXiaohongshu(input),
    saveXiaohongshuDraft: async (input) => (await import("./providers/xiaohongshu.mjs")).saveXiaohongshuDraft(input),
  };
  const jobs = new Map();
  const logins = new Map();
  const pendingAccounts = new Map();
  const loginAttempts = new Map();
  let active = null;
  let stopping = false;

  function stopForCleanupFailure() {
    if (!stopping) { stopping = true; onCleanupFailure(); }
  }

  function ensureIdle() {
    if (stopping) throw reject("临时会话未能确认清理，请重启同步服务后核对平台结果", 503);
    if (active) throw reject("请先完成或结束当前连接、同步及临时页面核对", 409);
  }
  async function unseal(envelope, session) {
    if (typeof envelope !== "string" || Buffer.byteLength(envelope) > MAX_ENVELOPE_BYTES) throw reject("浏览器中的授权资料无效，请重新连接账号");
    let account;
    try { account = await security.unsealAccount(envelope, session); }
    catch { throw reject("账号授权无效或已过期，请重新连接该平台账号", 422); }
    if (!record(account) || !["wechat", "xiaohongshu"].includes(account.platform) ||
        typeof account.remoteId !== "string" || typeof account.displayName !== "string" ||
        account.id !== accountId(session.ownerId, account.platform, account.remoteId)) throw reject("账号授权资料不匹配，请重新连接", 422);
    return account;
  }
  async function closeRuntime(operation) {
    clearTimeout(operation.timer);
    if (operation.cleanup) return operation.cleanup;
    const runtime = operation.runtime;
    // A cancelled launch may not have yielded its browser yet. Its own finally
    // will close it after the factory resolves; do not release its active slot.
    if (!runtime) {
      if (!["waiting", "running"].includes(operation.state) && active === operation) active = null;
      return;
    }
    operation.runtime = null;
    operation.cleanup = (async () => {
      try { await runtime.close(); }
      catch {
        stopForCleanupFailure();
        throw reject("临时会话未能确认清理，请重启同步服务后核对平台结果", 503);
      } finally { if (active === operation) active = null; }
    })();
    return operation.cleanup;
  }
  async function startLogin(login, session, displayName) {
    try {
      login.runtime = await browserFactory();
      login.controller.signal.throwIfAborted();
      const identity = await adapters.loginXiaohongshu({ context: login.runtime.context, signal: login.controller.signal });
      login.controller.signal.throwIfAborted();
      if (!identity || typeof identity.remoteId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(identity.remoteId)) throw reject("未能确认小红书创作者身份");
      const account = {
        id: accountId(session.ownerId, "xiaohongshu", identity.remoteId), platform: "xiaohongshu", remoteId: identity.remoteId,
        displayName: `${displayName} · ${identity.displayName || identity.remoteId}`,
        storageState: await login.runtime.snapshot(),
      };
      login.controller.signal.throwIfAborted();
      const envelope = await security.sealAccount(account, session);
      login.controller.signal.throwIfAborted();
      login.result = { account: publicAccount(account, pendingAccounts.get(account.id)), envelope };
      login.state = "complete";
    } catch (error) {
      if (error instanceof CloudBrowserCleanupError) stopForCleanupFailure();
      login.state = "failed";
      login.error = login.controller.signal.aborted ? "本次登录已结束，可以重新连接" : "未能完成小红书登录或安全保存授权，请重新连接";
    } finally {
      await closeRuntime(login).catch(() => {});
      login.finishedAt = now();
    }
  }
  async function executeJob(job, account, draft, session) {
    try {
      let result;
      if (account.platform === "wechat") result = await adapters.saveWechatDraft({ account, draft });
      else {
        job.runtime = await browserFactory({ storageState: account.storageState });
        if (stopping) throw new Error("Service is stopping");
        result = await adapters.saveXiaohongshuDraft({ context: job.runtime.context, account, draft });
      }
      if (!record(result) || !["saved", "needs_confirmation", "failed"].includes(result.status)) throw new Error("Invalid provider result");
      const draftId = typeof result.draftId === "string" && result.draftId.trim() && result.draftId.length <= 512 && [...result.draftId].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) ? result.draftId : undefined;
      job.receipt = {
        accountId: account.id, platform: account.platform,
        status: result.status === "saved" && !draftId ? "needs_confirmation" : result.status,
        message: result.status === "saved" && !draftId ? "平台没有返回可核对的草稿编号，请先核实保存结果" : typeof result.message === "string" ? result.message : "请核对平台草稿结果",
        ...(draftId ? { draftId } : {}),
      };
      if (job.runtime) {
        try {
          job.envelope = await security.sealAccount({ ...account, storageState: await job.runtime.snapshot() }, session);
        } catch {
          job.receipt.status = "needs_confirmation";
          job.receipt.message = "平台处理后未能保存更新的登录资料。请核对草稿并重新连接账号，避免重复发送。";
        }
      } else job.envelope = await security.sealAccount(account, session);
    } catch (error) {
      if (error instanceof CloudBrowserCleanupError) stopForCleanupFailure();
      job.receipt = { accountId: account.id, platform: account.platform, status: "needs_confirmation", message: "同步未取得完整结果，请先在平台核对；系统不会自动重新发送。" };
    } finally {
      job.state = "finished";
      job.finishedAt = now();
      // Neither the job ledger nor its closure retains the original images or
      // plaintext credentials. A pending XHS browser is bounded and explicit.
      if (job.receipt.status === "needs_confirmation" && job.runtime) {
        job.expiresAt = now() + temporarySessionMs;
        job.receipt.message += " 临时页面最多保留10分钟供查看；请及时核对，原始素材仍在当前浏览器。";
        job.timer = setTimeout(() => { void closeRuntime(job).catch(() => {}); }, temporarySessionMs);
        job.timer.unref?.();
      } else {
        await closeRuntime(job).catch(() => {});
      }
      if (job.receipt.status !== "needs_confirmation") pendingAccounts.delete(account.id);
    }
  }
  function findOwned(map, id, session, label) {
    const operation = validId(id) && map.get(id);
    if (!operation || operation.owner !== session.ownerId) throw reject(`没有找到${label}记录，请核对平台结果`, 404);
    return operation;
  }
  async function route(request, response, pathname) {
    const session = await security.readSession(request.headers.cookie || "");
    if (pathname === "/session" && request.method === "GET") return { configured: true, authenticated: Boolean(session), ...(session ? { csrf: session.csrf } : {}) };
    if (request.method === "POST" && pathname === "/session") {
      const ip = String(request.headers["x-sync-client-ip"] || "unknown");
      const attempts = loginAttempts.get(ip) || { count: 0, until: now() + 15 * 60 * 1000 };
      if (attempts.until <= now()) { attempts.count = 0; attempts.until = now() + 15 * 60 * 1000; }
      if (attempts.count >= 10 || loginAttempts.size > 10000) throw reject("登录尝试过多，请15分钟后重试", 429);
      attempts.count += 1;
      loginAttempts.set(ip, attempts);
      const input = await readJson(request, 4096);
      if (!record(input) || typeof input.password !== "string" || input.password.length > 512 || typeof input.remember !== "boolean") throw reject("请填写同步服务口令");
      const logged = await security.login(input.password, { remember: input.remember });
      loginAttempts.delete(ip);
      response.setHeader("Set-Cookie", logged.cookie);
      return { authenticated: true, csrf: logged.session.csrf };
    }
    if (!session) throw reject("请先登录网页同步服务", 401);
    if (request.method === "POST" && !equal(request.headers["x-csrf-token"], session.csrf)) throw reject("网页验证已失效，请刷新后重试", 403);
    if (request.method === "GET" && pathname.startsWith("/logins/")) {
      const login = findOwned(logins, pathname.slice(8), session, "登录");
      const image = login.state === "waiting" ? await login.runtime?.screenshot().catch(() => undefined) : undefined;
      return { state: login.state, ...(login.result || {}), ...(login.error ? { error: login.error } : {}), ...(image ? { image } : {}) };
    }
    if (request.method === "GET" && pathname.startsWith("/jobs/")) {
      const job = findOwned(jobs, pathname.slice(6), session, "同步");
      const image = job.state === "finished" ? await job.runtime?.screenshot().catch(() => undefined) : undefined;
      return { state: job.state, ...(job.receipt ? { receipt: job.receipt } : {}), ...(job.envelope ? { envelope: job.envelope } : {}), ...(image ? { image } : {}), ...(job.runtime && job.expiresAt ? { expiresAt: job.expiresAt } : {}) };
    }
    if (request.method !== "POST") throw reject("此接口不受支持", 404);
    const input = await readJson(request, pathname === "/jobs" ? 94 * 1024 * 1024 : MAX_CONTROL_BYTES);
    if (!record(input)) throw reject("请求格式无效");
    if (pathname === "/logout") {
      if (active) throw reject("请先结束当前任务或登录", 409);
      response.setHeader("Set-Cookie", security.logoutCookie());
      return { authenticated: false };
    }
    if (pathname === "/accounts/inspect") {
      if (!Array.isArray(input.envelopes) || input.envelopes.length > 20) throw reject("账号数量无效");
      const accounts = []; const invalidIndexes = [];
      for (const [index, envelope] of input.envelopes.entries()) {
        try { const account = await unseal(envelope, session); accounts.push(publicAccount(account, pendingAccounts.get(account.id))); }
        catch { invalidIndexes.push(index); }
      }
      return { accounts, invalidIndexes };
    }
    if (pathname === "/accounts/wechat") {
      ensureIdle();
      const displayName = text(input.displayName, "账号备注", 80);
      const appId = text(input.appId, "AppID", 80);
      const appSecret = text(input.appSecret, "AppSecret", 256);
      if (!/^wx[a-zA-Z0-9]{16}$/.test(appId) || /\s/.test(appSecret)) throw reject("公众号 AppID 或 AppSecret 格式不正确");
      const operation = {}; active = operation;
      try {
        const identity = await adapters.verifyWechatAccount({ appId, appSecret });
        if (identity.remoteId !== appId) throw reject("公众号身份核对失败");
        const account = { id: accountId(session.ownerId, "wechat", appId), platform: "wechat", remoteId: appId, displayName, appId, appSecret };
        return { account: publicAccount(account, pendingAccounts.get(account.id)), envelope: await security.sealAccount(account, session) };
      } catch (error) {
        if (error?.name === "WechatApiError" && Number.isSafeInteger(error.code)) throw reject(`微信接口拒绝连接（错误码 ${error.code}）。请核对公众号权限、密钥和同步服务器 IP 白名单。`);
        throw reject("未能验证公众号，请核对密钥、草稿接口权限和同步服务器 IP 白名单");
      } finally { if (active === operation) active = null; }
    }
    if (pathname === "/logins") {
      if (!validId(input.loginRequestId)) throw reject("登录请求编号无效");
      const prior = logins.get(input.loginRequestId);
      if (prior && prior.owner === session.ownerId) return { id: prior.id };
      ensureIdle();
      const displayName = text(input.displayName, "账号备注", 80);
      const login = { id: input.loginRequestId, owner: session.ownerId, state: "waiting", runtime: null, controller: new AbortController() };
      active = login; logins.set(login.id, login);
      login.timer = setTimeout(() => login.controller.abort(), 3 * 60 * 1000);
      login.timer.unref?.();
      login.finished = startLogin(login, session, displayName);
      return { id: login.id };
    }
    if (/^\/logins\/[^/]+\/cancel$/.test(pathname)) {
      const id = pathname.split("/")[2];
      if (!validId(id)) throw reject("登录请求编号无效");
      const login = logins.get(id);
      if (!login || login.owner !== session.ownerId || login.state !== "waiting") return { cancelled: false };
      login.controller.abort();
      await closeRuntime(login).catch(() => {});
      await login.finished;
      return { cancelled: true };
    }
    if (pathname === "/accounts/remove") {
      ensureIdle();
      let account;
      try { account = await unseal(input.envelope, session); } catch { return { removed: true }; }
      if (pendingAccounts.has(account.id)) throw reject("此账号仍有待核实草稿，请先核对并记录结果", 409);
      return { removed: true };
    }
    if (pathname === "/jobs/acknowledge") {
      if (!["saved", "not_saved"].includes(input.outcome) || !validId(input.requestId)) throw reject("请先核对对应任务的实际保存结果");
      const account = await unseal(input.envelope, session);
      const id = pendingAccounts.get(account.id);
      if (id && id !== input.requestId) throw reject("此账号已有另一次待核对任务，请刷新结果后核对，旧操作不会关闭新任务", 409);
      const job = id && jobs.get(id);
      if (active && active !== job) throw reject("请先完成当前任务", 409);
      if (job?.state === "running") throw reject("同步仍在执行，请等待结果", 409);
      if (job) await closeRuntime(job);
      if (pendingAccounts.get(account.id) !== id) throw reject("待核对任务已经变化，请刷新账号后核对", 409);
      pendingAccounts.delete(account.id);
      return { acknowledged: true, ...(job?.envelope ? { envelope: job.envelope } : {}) };
    }
    if (pathname === "/jobs") {
      if (!validId(input.requestId)) throw reject("同步请求编号无效");
      const account = await unseal(input.envelope, session);
      const fingerprint = createHash("sha256").update(JSON.stringify({ accountId: account.id, content: input.content, images: input.images })).digest("hex");
      const prior = jobs.get(input.requestId);
      if (prior) {
        if (prior.owner !== session.ownerId || prior.fingerprint !== fingerprint) throw reject("同一请求不能更换账号或素材", 409);
        return { id: prior.id, state: prior.state };
      }
      ensureIdle();
      if (pendingAccounts.has(account.id)) throw reject("请先核实此账号上次草稿的保存结果", 409);
      if (jobs.size >= 500) throw reject("本次服务会话任务已达上限，请稍后再试", 429);
      if (!record(input.content) || typeof input.content.title !== "string" || typeof input.content.body !== "string") throw reject("标题或文案格式不正确");
      const images = decodeImages(input.images);
      const blocking = validateDraft(account.platform, input.content, images.map((image) => ({ ...image, size: image.bytes.length }))).find((issue) => issue.severity === "error");
      if (blocking) throw reject(blocking.message);
      const job = { id: input.requestId, owner: session.ownerId, accountId: account.id, fingerprint, state: "running", runtime: null };
      jobs.set(job.id, job); pendingAccounts.set(account.id, job.id); active = job;
      job.finished = executeJob(job, account, { title: input.content.title, body: input.content.body, images }, session);
      return { id: job.id, state: job.state };
    }
    throw reject("此接口不受支持", 404);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (!equal(request.headers["x-sync-gateway"], gatewaySecret)) throw reject("请求来源未获授权", 403);
      if (!["GET", "POST"].includes(request.method)) throw reject("此请求方法不受支持", 405);
      if (request.method === "POST" && !allowedOrigins.includes(request.headers.origin)) throw reject("网页来源未获授权", 403);
      if (request.method === "POST" && request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw reject("只接受 JSON 请求", 415);
      const url = new URL(request.url, "https://sync.internal");
      if (url.search || !url.pathname.startsWith("/api/sync/")) throw reject("同步路径无效", 404);
      const result = await route(request, response, url.pathname.slice("/api/sync".length));
      response.writeHead(200); response.end(JSON.stringify(result));
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 400;
      response.writeHead(status);
      // Never reflect provider/network errors, request content or credential URLs.
      response.end(JSON.stringify({ error: error?.publicMessage || "操作未完成，请检查账号及网页同步服务后重试" }));
    }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  const reap = setInterval(() => {
    for (const [id, login] of logins) if (login.finishedAt && now() - login.finishedAt > 5 * 60 * 1000) logins.delete(id);
    for (const [id, job] of jobs) if (job.finishedAt && !job.runtime && now() - job.finishedAt > 24 * 60 * 60 * 1000) jobs.delete(id);
    for (const [id, attempt] of loginAttempts) if (attempt.until <= now()) loginAttempts.delete(id);
  }, 60000);
  reap.unref?.();
  return {
    server,
    async listen() {
      await new Promise((resolve, fail) => { server.once("error", fail); server.listen(port, host, () => { server.off("error", fail); resolve(); }); });
      return server.address().port;
    },
    async close() {
      stopping = true; clearInterval(reap);
      for (const login of logins.values()) login.controller.abort();
      await Promise.allSettled([...logins.values(), ...jobs.values()].map(closeRuntime));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
