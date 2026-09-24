import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validDraftRef } from "./driver.mjs";

export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const MAX_REQUEST_BYTES = 60 * 1024 * 1024 + 64 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ACCOUNT_ID = /^[a-f0-9]{20}$/;
const pending = new Set(["uploading", "creating", "needs_confirmation"]);

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function readSubmission(form) {
  const known = new Set(["id", "title", "body", "images", "expectedAccountId"]);
  if ([...form.keys()].some((key) => !known.has(key))) throw new RequestError("同步内容包含未知字段");
  const text = (key) => {
    const values = form.getAll(key);
    if (values.length !== 1 || typeof values[0] !== "string") throw new RequestError("同步内容不完整");
    return values[0];
  };
  const id = text("id"), title = text("title"), body = text("body").replace(/\r\n?/g, "\n"), expectedAccountId = text("expectedAccountId");
  if (!JOB_ID.test(id)) throw new RequestError("草稿记录编号无效");
  if (!ACCOUNT_ID.test(expectedAccountId)) throw new RequestError("请先连接并核对小红书账号");
  if (!title.trim() || [...title].length > 20 || /[\r\n\0]/u.test(title)) throw new RequestError("小红书标题需为 1–20 个字符且不含换行");
  if ([...body].length > 1000 || body.includes("\0")) throw new RequestError("小红书配文需在 1,000 字以内");
  const files = form.getAll("images");
  if (files.length < 1 || files.length > 18) throw new RequestError("小红书需要 1–18 张图片");
  const images = [];
  let total = 0;
  for (const file of files) {
    if (typeof file === "string" || !["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 10_000_000) throw new RequestError("请使用单张不超过 10 MB 的 PNG 或 JPEG 图片");
    total += file.size;
    if (total > 60 * 1024 * 1024) throw new RequestError("图片总大小超过 60 MiB");
    const bytes = Buffer.from(await file.arrayBuffer());
    const valid = file.type === "image/png"
      ? bytes.length > 44 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.subarray(12, 16).toString() === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
        && bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
      : bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    if (!valid) throw new RequestError("图片数据不完整或与格式不符，请重新生成");
    images.push({ bytes, mime: file.type, name: `poster-${images.length + 1}.${file.type === "image/png" ? "png" : "jpg"}`, hash: hash(bytes) });
  }
  return { id, title, body, expectedAccountId, images,
    fingerprint: hash(JSON.stringify({ title, body, images: images.map((image) => image.hash) })) };
}

const publicJob = (record) => {
  const { id, accountId, accountName, title, imageCount, uploadedCount, status, message, draftId, createdAt, updatedAt } = record;
  return { id, accountId, accountName, title, imageCount, uploadedCount, status, message, acknowledged: record.acknowledged === true, ...(draftId ? { draftId } : {}), createdAt, updatedAt };
};
async function syncDirectory(path) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function atomicJson(path, value, directory) {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); await syncDirectory(directory); }
  finally { await rm(temporary, { force: true }); }
}

// The lock covers the service's single browser profile as well as all account
// operations. Stale locks require manual recovery after closing the dedicated
// browser. Automatically removing one races another service's startup.
async function acquireLock(dataDir) {
  const path = join(dataDir, "service.lock"), token = randomUUID();
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.sync(); }
      finally { await file.close(); }
      await syncDirectory(dataDir);
      return async () => {
        const lock = JSON.parse(await readFile(path, "utf8"));
        if (lock.token === token) { await rm(path); await syncDirectory(dataDir); }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new RequestError("同一小红书浏览器的服务锁仍存在，请先关闭原服务；异常退出后需核对专用浏览器再恢复服务锁", 409);
    }
}

export async function createXhsService({ dataDir, driver }) {
  if (!dataDir || ["checkConnection", "openLogin", "prepare", "saveDraft", "verifyDraft", "close"].some((key) => typeof driver?.[key] !== "function")) throw new TypeError("小红书服务配置不完整");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(dataDir);
  const root = join(dataDir, "jobs");
  try { await mkdir(root, { recursive: true, mode: 0o700 }); }
  catch (error) { await release(); throw error; }
  let active = null, queue = Promise.resolve(), closed = false;
  const retained = new Map();
  const directory = (id) => {
    if (!JOB_ID.test(id)) throw new RequestError("草稿记录编号无效");
    return join(root, id);
  };
  function exclusive(work) {
    const task = queue.catch(() => {}).then(async () => {
      if (closed) throw new RequestError("小红书服务已关闭", 503);
      return work();
    });
    queue = task;
    return task;
  }
  async function write(record) {
    record.updatedAt = new Date().toISOString();
    await atomicJson(join(directory(record.id), "job.json"), record, directory(record.id));
    retained.delete(record.id);
  }
  async function keepUnknown(record, message) {
    record.status = "needs_confirmation";
    record.message = message;
    try { await write(record); }
    catch {
      record.message = "同步记录暂时无法写入磁盘，请保留服务并核对专用浏览器；不会重复创建草稿";
      retained.set(record.id, record);
    }
    return record;
  }
  async function read(id) {
    if (retained.has(id)) return retained.get(id);
    let record;
    try { record = JSON.parse(await readFile(join(directory(id), "job.json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new RequestError("未找到完整同步记录，请先核对专用浏览器，勿重复提交", 404);
      throw new RequestError("同步记录无法读取，请人工核对", 503);
    }
    if (record.id !== id || !ACCOUNT_ID.test(record.accountId) || !Array.isArray(record.images)
      || !["uploading", "creating", "saved", "needs_confirmation", "failed"].includes(record.status)
      || !Number.isInteger(record.imageCount) || record.imageCount < 1 || record.imageCount > 18 || record.images.length !== record.imageCount
      || typeof record.title !== "string" || typeof record.body !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new RequestError("同步记录不完整，请人工核对", 503);
    if (["uploading", "creating"].includes(record.status) && active?.id !== id) return keepUnknown(record, "同步服务曾中断，结果需要核对；不会恢复上传或重复保存");
    return record;
  }
  async function blockedByPrevious() {
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !JOB_ID.test(item.name)) continue;
      const record = await read(item.name);
      if (pending.has(record.status) && record.acknowledged !== true) throw new RequestError("上一组小红书草稿尚未核对完成，请先读取并核对原任务", 409);
    }
  }
  async function bindConnection(openLogin = false) {
    const state = await (openLogin ? driver.openLogin() : driver.checkConnection());
    if (state?.status === "login_required") return { status: "login_required", message: "小红书专用窗口当前显示登录页，请在该窗口完成扫码登录" };
    if (state?.status !== "connected") return { status: "needs_attention", message: "暂未从专用窗口确认稳定的小红书账号标识；若已登录，请勿重复扫码，需要核对当前页面与账号识别" };
    const account = state.account;
    if (!account || !ACCOUNT_ID.test(account.id) || typeof account.name !== "string" || !account.name.trim()) return { status: "needs_attention", message: "尚未确认小红书账号身份，当前不会上传图片" };
    let bound;
    try { bound = JSON.parse(await readFile(join(dataDir, "account.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new RequestError("本机绑定账号记录无法读取", 503); }
    if (bound && bound.id !== account.id) throw new RequestError("专用浏览器登录账号与本机绑定不一致，请切回原账号", 409);
    if (!bound) await atomicJson(join(dataDir, "account.json"), account, dataDir);
    return { status: "connected", account };
  }
  async function verify(record) {
    if (!validDraftRef(record.draftRef, record.imageCount) || record.draftId !== record.draftRef.id) return keepUnknown(record, "暂存结果缺少可核对的草稿或图片标识，请在专用浏览器检查；不会重复保存");
    const connection = await bindConnection();
    if (connection.status !== "connected" || connection.account.id !== record.accountId) return keepUnknown(record, "请先恢复同一小红书账号的登录，再核对已有草稿");
    const result = await driver.verifyDraft({ draftRef: record.draftRef, account: connection.account, title: record.title, body: record.body, images: record.images });
    record.status = result?.verified === true ? "saved" : "needs_confirmation";
    record.message = result?.verified === true ? "已重新打开同一草稿，标题、配文和全部图片显示及顺序已核对" : "草稿内容或图片尚未通过核对，请在专用浏览器检查";
    await write(record);
    return record;
  }
  async function run(record) {
    try {
      const connection = await bindConnection();
      if (connection.status !== "connected" || connection.account.id !== record.accountId) throw new Error("account changed");
      record.prepared = await driver.prepare({ jobId: record.id, account: connection.account, title: record.title, body: record.body,
        images: record.images, onProgress: async (count) => {
          if (!Number.isInteger(count) || count < record.uploadedCount || count > record.imageCount) throw new Error("invalid progress");
          record.uploadedCount = count;
          record.message = `已确认上传 ${count} / ${record.imageCount} 张图片，尚未暂存`;
          await write(record);
        } });
      if (record.uploadedCount !== record.imageCount || !record.prepared || record.prepared.jobId !== record.id
        || !Array.isArray(record.prepared.images) || record.prepared.images.length !== record.imageCount) throw new Error("incomplete preparation");
      record.status = "creating";
      record.message = "图片与配文已填入，正在暂存草稿";
      await write(record);
      const result = await driver.saveDraft({ prepared: record.prepared });
      record.draftRef = result?.draftRef;
      if (typeof result?.draftId === "string") record.draftId = result.draftId;
      record.status = "needs_confirmation";
      record.message = "暂存操作已结束，正在重新打开草稿核对";
      await write(record);
      await verify(record);
    } catch {
      await keepUnknown(record, "上传、暂存或回读结果尚未确认，请核对专用浏览器；本任务不会重复上传或保存");
    }
  }
  return {
    busy: () => Boolean(active),
    checkConnection: () => exclusive(async () => {
      if (active) throw new RequestError("小红书任务仍在处理中，请先读取状态", 409);
      const state = await bindConnection();
      if (state.status !== "connected") throw new RequestError(state.message, 409);
      return state.account;
    }),
    openLogin: () => exclusive(async () => {
      if (active) throw new RequestError("小红书任务仍在处理中，请先读取状态", 409);
      return bindConnection(true);
    }),
    submit: (input) => exclusive(async () => {
      const path = directory(input.id);
      try {
        const previous = await read(input.id);
        if (previous.fingerprint !== input.fingerprint || previous.accountId !== input.expectedAccountId) throw new RequestError("此同步编号对应另一组内容或账号", 409);
        return publicJob(previous);
      } catch (error) { if (error.status !== 404) throw error; }
      if (active) throw new RequestError("上一组小红书内容仍在处理中", 409);
      await blockedByPrevious();
      const connection = await bindConnection();
      if (connection.status !== "connected" || connection.account.id !== input.expectedAccountId) throw new RequestError("请先连接并核对目标小红书账号", 409);
      try { await mkdir(path, { mode: 0o700 }); await syncDirectory(root); }
      catch (error) { if (error.code === "EEXIST") throw new RequestError("本任务已有持久记录，禁止重复创建，请人工核对", 409); throw error; }
      const now = new Date().toISOString();
      const record = { id: input.id, accountId: connection.account.id, accountName: connection.account.name,
        title: input.title, body: input.body, fingerprint: input.fingerprint, imageCount: input.images.length, uploadedCount: 0,
        images: [], status: "uploading", message: "原图已接收，正在打开小红书编辑器", createdAt: now, updatedAt: now };
      for (const image of input.images) {
        const imagePath = join(path, image.name), file = await open(imagePath, "wx", 0o600);
        try { await file.writeFile(image.bytes); await file.sync(); } finally { await file.close(); }
        record.images.push({ path: imagePath, name: image.name, mime: image.mime, hash: image.hash });
      }
      await write(record);
      const initial = publicJob(record);
      active = { id: record.id, promise: null };
      active.promise = run(record).finally(() => { active = null; });
      return initial;
    }),
    async get(id) { return publicJob(await read(id)); },
    acknowledge: (id) => exclusive(async () => {
      if (active) throw new RequestError("小红书任务仍在处理中，暂时不能结束", 409);
      const record = await read(id);
      if (record.status !== "needs_confirmation") throw new RequestError("只有待核对任务需要人工结束", 409);
      record.acknowledged = true;
      record.message = "你已在专用浏览器核对并结束本次任务；平台保存结果仍未由程序确认，原编号不会重复上传或保存";
      await write(record);
      return publicJob(record);
    }),
    verify: (id) => exclusive(async () => {
      if (active) throw new RequestError("小红书任务仍在处理中", 409);
      const record = await read(id);
      active = { id, promise: null };
      active.promise = verify(record).catch(() => keepUnknown(record, "本次回读暂未确认，请检查专用浏览器；不会重复保存"));
      try { return publicJob(await active.promise); } finally { active = null; }
    }),
    async idle() { await queue.catch(() => {}); await active?.promise; },
    async close() {
      closed = true;
      await queue.catch(() => {});
      await active?.promise;
      try { await driver.close(); } finally { await release(); }
    },
  };
}
