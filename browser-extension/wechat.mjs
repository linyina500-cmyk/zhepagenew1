import { createWechatApi, WechatApiError, normalizeDraftCoverInfo, normalizeDraftCoverSource, normalizeDraftVerificationMismatches } from "../lib/wechat/api.mjs";

const ACCOUNT_ID = /^[a-f0-9]{20}$/u;
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const encoder = new TextEncoder();
const hash = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.name = "RequestError"; this.status = status; }
}
const reply = (status, body) => ({ status, body });
const publicJob = ({ id, accountId, accountName, title, imageCount, uploadedCount, status, message, draftId, createdAt, updatedAt }) => ({
  id, accountId, accountName, title, imageCount, uploadedCount, status, message, ...(draftId ? { draftId } : {}), createdAt, updatedAt,
});
const plainObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A single slow fetch must finish before the MV3 worker's 30-second fetch limit.
// The page's job polling keeps active work alive; a stopped worker is recovered
// as uncertain, never replayed. Credentials travel only to WeChat's fixed API.
export async function fetchWechatInBrowser(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://api.weixin.qq.com" || parsed.username || parsed.password) throw new Error("Invalid WeChat API destination");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 25_000);
  try { return await fetch(url, { ...options, signal: controller.signal, credentials: "omit", redirect: "error" }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

function imageBytesMatch(bytes, type) {
  if (type === "image/png") return bytes.length > 24
    && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    && [73, 72, 68, 82].every((byte, index) => bytes[12 + index] === byte)
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) > 0
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) > 0;
  return type === "image/jpeg" && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
}

export async function readWechatSubmission(form) {
  if (!(form instanceof FormData)) throw new RequestError("请发送完整的图片与配文");
  const fields = new Set(["id", "title", "body", "images", "expectedAccountId"]);
  if ([...form.keys()].some((key) => !fields.has(key))) throw new RequestError("同步内容包含未知字段");
  const text = (name) => {
    const values = form.getAll(name);
    if (values.length !== 1 || typeof values[0] !== "string") throw new RequestError("同步内容不完整，请重新确认内容");
    return values[0];
  };
  const id = text("id"), title = text("title"), body = text("body").replace(/\r\n?/gu, "\n"), expectedAccountId = text("expectedAccountId");
  if (!ACCOUNT_ID.test(expectedAccountId)) throw new RequestError("请先连接并核对目标公众号");
  if (!JOB_ID.test(id)) throw new RequestError("草稿记录编号无效");
  if (!title.trim() || [...title].length > 20 || /[\r\n\0]/u.test(title)) throw new RequestError("公众号标题需要为 1–20 个字符，且不含换行");
  if ([...body].length > 1000 || encoder.encode(body).length > 2048 || body.includes("\0")) throw new RequestError("公众号配文超过本工具的 1,000 字或 2,048 字节上限，请缩短后同步");
  const files = form.getAll("images");
  if (files.length < 1 || files.length > 20) throw new RequestError("公众号贴图需要 1–20 张图片");
  const images = []; let total = 0;
  for (const file of files) {
    if (!(file instanceof Blob) || !["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 10_000_000) throw new RequestError("请使用单张不超过 10 MB 的 PNG 或 JPEG 图片");
    total += file.size;
    if (total > 40 * 1024 * 1024) throw new RequestError("本次图片总大小超过 40 MiB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!imageBytesMatch(bytes, file.type)) throw new RequestError("图片文件与格式不符，请重新生成或选择图片");
    images.push({ blob: file, name: `poster-${images.length + 1}.${file.type === "image/png" ? "png" : "jpg"}`, hash: await hash(bytes) });
  }
  return { id, title, body, expectedAccountId, images, fingerprint: await hash(JSON.stringify({ title, body, images: images.map((image) => image.hash) })) };
}

export function createWechatHandler({ deviceId, store, apiFactory = (credentials) => createWechatApi({ ...credentials, fetchImpl: fetchWechatInBrowser }) }) {
  if (!/^[a-f0-9]{32}$/u.test(deviceId) || !store || !["get", "set", "list"].every((name) => typeof store[name] === "function")) throw new TypeError("公众号扩展存储配置无效");
  const sessions = new Map(), locks = new Map(), unpersisted = new Map();
  const key = (accountId, id) => `wechat:job:${accountId}:${id}`;
  const session = (id) => {
    const value = sessions.get(id);
    if (!value) throw new RequestError("请在当前浏览器重新连接该公众号", 409);
    return value;
  };
  async function write(record) {
    record.updatedAt = new Date().toISOString();
    await store.set(key(record.accountId, record.id), record);
    unpersisted.delete(key(record.accountId, record.id));
  }
  function retain(record) {
    record.status = "needs_confirmation";
    record.message = "浏览器暂时无法保存同步记录，请先检查公众号草稿箱。请保留当前页面，勿重复同步。";
    unpersisted.set(key(record.accountId, record.id), record);
    return record;
  }
  async function read(accountId, id, { recover = true, optional = false } = {}) {
    const record = unpersisted.get(key(accountId, id)) || await store.get(key(accountId, id));
    if (!record) {
      if (optional) return null;
      throw new RequestError("未找到这次同步记录，请先核对公众号草稿箱，勿重复提交", 404);
    }
    if (record.id !== id || record.accountId !== accountId || !Array.isArray(record.imageMediaIds)) throw new RequestError("同步记录不完整，请先人工核对", 503);
    if (recover && ["uploading", "creating"].includes(record.status)) {
      record.status = "needs_confirmation";
      record.message = "浏览器同步曾中断，请先核对公众号草稿箱。不会重新上传或重复创建。";
      try { await write(record); } catch { retain(record); }
    }
    return record;
  }
  async function verify(record, api) {
    if (!record.draftId) return record;
    delete record.coverInfo; delete record.coverSource; delete record.verificationMismatches;
    try {
      const result = await api.verifyDraft({ draftId: record.draftId, title: record.title, body: record.body, imageMediaIds: record.imageMediaIds });
      const coverInfo = normalizeDraftCoverInfo(result.coverInfo), coverSource = normalizeDraftCoverSource(result.coverSource), mismatches = normalizeDraftVerificationMismatches(result.verificationMismatches);
      if (coverInfo) record.coverInfo = coverInfo;
      if (coverSource) record.coverSource = coverSource;
      if (mismatches) record.verificationMismatches = mismatches;
      record.status = result.verified ? "saved" : "needs_confirmation";
      record.message = result.verified ? "标题、配文和图片顺序已核对。请到公众号草稿箱检查图片，并重新选择封面后发布。" : result.message;
    } catch {
      record.status = "needs_confirmation";
      record.message = "公众号已返回草稿编号，但详情暂未核对完成。请重新核对，勿重复同步。";
    }
    await write(record); return record;
  }
  async function run(record, images, api) {
    let stage = "upload";
    try {
      for (const image of images) {
        record.imageMediaIds.push(await api.uploadImage(image));
        record.uploadedCount = record.imageMediaIds.length;
        record.message = `已上传 ${record.uploadedCount} / ${record.imageCount} 张图片，尚未创建草稿。`;
        await write(record);
      }
      record.status = "creating";
      record.message = "图片已上传，正在保存到公众号草稿箱。";
      await write(record);
      stage = "create";
      record.draftId = await api.createDraft({ title: record.title, body: record.body, imageMediaIds: record.imageMediaIds });
      record.status = "creating";
      record.message = "已保存草稿，正在核对内容。";
      stage = "verify";
      await write(record);
      await verify(record, api);
    } catch (error) {
      record.status = stage === "upload" || (stage === "create" && error?.outcome === "rejected") ? "failed" : "needs_confirmation";
      record.message = stage === "upload" ? "图片上传未完成，未创建草稿。可能有部分图片已进入素材库，请核对后再操作。"
        : stage === "create" && error?.outcome === "rejected" ? "公众号拒绝创建草稿，已上传图片保留在素材库。请检查内容和接口权限。"
          : "草稿结果尚未确认，请先查看公众号草稿箱；不会重复创建。";
      try { await write(record); } catch { retain(record); }
    }
  }
  async function connect(input) {
    if (!plainObject(input) || Object.keys(input).some((name) => !["appId", "appSecret", "name", "deviceId"].includes(name))) throw new RequestError("公众号连接信息不完整");
    if (input.deviceId !== deviceId) throw new RequestError("连接的不是原来绑定的浏览器，请重新连接", 409);
    const { appId, appSecret, name } = input;
    if (typeof appId !== "string" || !/^wx[a-zA-Z0-9]{16}$/u.test(appId) || typeof appSecret !== "string" || !/^[a-zA-Z0-9]{32}$/u.test(appSecret)
      || typeof name !== "string" || !name.trim() || [...name].length > 40 || /[\r\n\0]/u.test(name)) throw new RequestError("请填写有效的 AppID、AppSecret 和公众号名称");
    const id = (await hash(appId)).slice(0, 20);
    if (locks.has(id)) throw new RequestError("该公众号仍在处理中，请稍候再连接", 409);
    if (!sessions.has(id) && new Set([...sessions.keys(), ...locks.keys()]).size >= 30) throw new RequestError("当前浏览器已连接 30 个公众号，请先断开不使用的账号", 409);
    const lock = { kind: "connect" }; locks.set(id, lock);
    try {
      const fingerprint = await hash(`${appId}\0${appSecret}`), previous = sessions.get(id);
      const api = previous?.fingerprint === fingerprint ? previous.api : apiFactory({ appId, appSecret });
      await api.checkConnection();
      const account = { id, name: name.trim() };
      sessions.set(id, { api, account, fingerprint }); return account;
    } finally { if (locks.get(id) === lock) locks.delete(id); }
  }
  async function submit(accountId, form) {
    const input = await readWechatSubmission(form);
    if (input.expectedAccountId !== accountId) throw new RequestError("上传目标与所选公众号不一致", 409);
    const { api, account } = session(accountId), current = locks.get(accountId);
    if (current) {
      if (current.kind !== "draft" || current.id !== input.id || (current.fingerprint && current.fingerprint !== input.fingerprint)) throw new RequestError("该公众号仍在处理上一组内容，请先读取同步状态", 409);
      if (current.reserved) await current.reserved.promise;
      const previous = await read(accountId, input.id, { recover: false });
      if (previous.fingerprint !== input.fingerprint) throw new RequestError("此同步编号对应另一组内容，请先核对已有记录", 409);
      return publicJob(previous);
    }
    const lock = { kind: "draft", id: input.id, fingerprint: input.fingerprint, reserved: deferred() };
    lock.reserved.promise.catch(() => {});
    locks.set(accountId, lock);
    let running = false;
    try {
      const previous = await read(accountId, input.id, { optional: true });
      if (previous) {
        if (previous.fingerprint !== input.fingerprint) throw new RequestError("此同步编号对应另一组内容，请先核对已有记录", 409);
        lock.reserved.resolve(); return publicJob(previous);
      }
      const records = (await store.list(`wechat:job:${accountId}:`)).map(({ value }) => value).concat([...unpersisted.values()]);
      if (records.some((record) => record.accountId === accountId && record.fingerprint === input.fingerprint
        && ["uploading", "creating", "needs_confirmation"].includes(record.status))) {
        throw new RequestError("这组内容已有待核对的同步记录，请先检查原任务和公众号草稿箱，勿重复创建。", 409);
      }
      const now = new Date().toISOString();
      const record = { id: input.id, accountId, accountName: account.name, title: input.title, body: input.body, fingerprint: input.fingerprint,
        imageCount: input.images.length, uploadedCount: 0, imageMediaIds: [], status: "uploading", message: "正在同步图片，请保持折页页面打开。", createdAt: now, updatedAt: now };
      await write(record); // Commit the reservation before any WeChat write.
      lock.reserved.resolve();
      const first = publicJob(record);
      running = true;
      void run(record, input.images, api).catch(() => { retain(record); }).finally(() => { if (locks.get(accountId) === lock) locks.delete(accountId); });
      return first;
    } catch (error) { lock.reserved.reject(error); throw error; }
    finally { if (!running && locks.get(accountId) === lock) locks.delete(accountId); }
  }
  const handle = async ({ path, method = "GET", body }) => {
    if (typeof path !== "string" || !path.startsWith("/api/wechat/")) return null;
    try {
      if (path.includes("?") || path.includes("#")) throw new RequestError("接口不接收网址查询参数");
      if (method === "GET" && path === "/api/wechat/connection") return reply(200, { deviceId, busy: locks.size > 0 });
      if (method === "GET" && path === "/api/wechat/accounts") return reply(200, { accounts: [...sessions.values()].map(({ account }) => account) });
      if (method === "POST" && path === "/api/wechat/accounts/connect") return reply(200, { account: await connect(body) });
      const scoped = /^\/api\/wechat\/accounts\/([a-f0-9]{20})(\/.*)$/u.exec(path);
      if (!scoped) throw new RequestError("没有此公众号草稿操作", 404);
      const accountId = scoped[1], operation = scoped[2];
      if (operation === "/disconnect" && method === "POST") {
        if (locks.has(accountId)) throw new RequestError("该公众号仍在同步，请完成后再断开", 409);
        sessions.delete(accountId); return reply(200, { disconnected: true });
      }
      const { api } = session(accountId);
      if (operation === "/jobs" && method === "POST") return reply(202, { job: await submit(accountId, body) });
      const match = /^\/jobs\/([^/]+)(\/verify)?$/u.exec(operation);
      if (!match || !JOB_ID.test(match[1])) throw new RequestError("没有此公众号草稿操作", 404);
      const id = match[1], current = locks.get(accountId);
      if (!match[2] && method === "GET") return reply(200, { job: publicJob(await read(accountId, id, { recover: current?.id !== id })) });
      if (match[2] === "/verify" && method === "POST") {
        if (current) {
          if (current.id !== id) throw new RequestError("该公众号仍在处理中，请稍候核对", 409);
          return reply(200, { job: publicJob(await read(accountId, id, { recover: false })) });
        }
        const lock = { kind: "verify", id }; locks.set(accountId, lock);
        try {
          const record = await read(accountId, id);
          try { return reply(200, { job: publicJob(await verify(record, api)) }); }
          catch { return reply(200, { job: publicJob(retain(record)) }); }
        } finally { if (locks.get(accountId) === lock) locks.delete(accountId); }
      }
      throw new RequestError("没有此公众号草稿操作", 404);
    } catch (error) {
      return reply(error instanceof RequestError ? error.status : error instanceof WechatApiError ? 424 : 502,
        { error: error instanceof RequestError || error instanceof WechatApiError ? error.message : "公众号同步结果暂未确认，请读取状态并核对草稿箱，勿重复提交。" });
    }
  };
  handle.busy = () => locks.size > 0;
  return handle;
}
