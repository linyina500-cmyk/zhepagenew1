import { createXhsBrowser, XhsError } from "./xhs-browser.mjs";

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ACCOUNT_ID = /^[a-f0-9]{20}$/u;
const PREFIX = "xhs:job:";
const pending = new Set(["uploading", "creating", "needs_confirmation"]);
export async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function readXhsSubmission(form) {
  if (!(form instanceof FormData)) throw new XhsError("请发送完整图片和配文。", 400);
  const known = new Set(["id", "title", "body", "images", "expectedAccountId"]);
  if ([...form.keys()].some((key) => !known.has(key))) throw new XhsError("同步内容包含未知字段。", 400);
  const text = (key) => {
    const values = form.getAll(key);
    if (values.length !== 1 || typeof values[0] !== "string") throw new XhsError("同步内容不完整。", 400);
    return values[0];
  };
  const id = text("id"), title = text("title"), body = text("body").replace(/\r\n?/gu, "\n"), accountId = text("expectedAccountId");
  if (!JOB_ID.test(id) || !ACCOUNT_ID.test(accountId)) throw new XhsError("请先连接并核对小红书账号。", 400);
  if (!title.trim() || [...title].length > 20 || /[\r\n\0]/u.test(title)) throw new XhsError("小红书标题需为 1–20 个字符，不能换行。", 400);
  if ([...body].length > 1000 || body.includes("\0")) throw new XhsError("小红书配文不能超过 1,000 字。", 400);
  const files = form.getAll("images");
  if (files.length < 1 || files.length > 18) throw new XhsError("小红书需要 1–18 张图片。", 400);
  const images = []; let total = 0;
  for (const file of files) {
    if (!(file instanceof Blob) || !["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 10_000_000) throw new XhsError("请使用单张不超过 10 MB 的 PNG 或 JPEG 图片。", 400);
    total += file.size;
    if (total > 40 * 1024 * 1024) throw new XhsError("图片总大小超过 40 MiB。", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const png = file.type === "image/png" && bytes.length > 44 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      && view.getUint32(12) === 0x49484452 && view.getUint32(16) > 0 && view.getUint32(20) > 0
      && [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((byte, index) => bytes[bytes.length - 12 + index] === byte);
    const jpeg = file.type === "image/jpeg" && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    if (!png && !jpeg) throw new XhsError("图片数据不完整，请重新生成。", 400);
    images.push({ blob: new Blob([bytes], { type: file.type }), mime: file.type, name: `poster-${images.length + 1}.${png ? "png" : "jpg"}`, hash: await sha256(bytes) });
  }
  return { id, title, body, accountId, images, fingerprint: await sha256(JSON.stringify({ title, body, images: images.map((image) => image.hash) })) };
}
const publicJob = (record) => ({ id: record.id, accountId: record.accountId, accountName: record.accountName,
  title: record.title, imageCount: record.imageCount, uploadedCount: record.uploadedCount, status: record.status,
  message: record.message, acknowledged: record.acknowledged === true, ...(record.draftId ? { draftId: record.draftId } : {}) });

// One service worker owns the serialized submission queue. Browser restart or
// MV3 suspension never resumes a mutation from storage. Its last durable intent
// becomes an explicit uncertainty that must be checked before a new task.
export function createXhsHandler({ store, driver = createXhsBrowser({ store }) }) {
  if (!store || ["get", "set", "list"].some((key) => typeof store[key] !== "function")) throw new TypeError("扩展存储不可用");
  let active = null, queue = Promise.resolve(), initialization;
  const write = async (record) => { record.updatedAt = new Date().toISOString(); await store.set(`${PREFIX}${record.id}`, record); };
  const unknown = async (record, message) => { record.status = "needs_confirmation"; record.message = message; await write(record); return record; };
  async function initialize() {
    initialization ||= (async () => {
      for (const { value: record } of await store.list(PREFIX)) if (["uploading", "creating"].includes(record?.status)) {
        await unknown(record, "浏览器或扩展曾中断，请先核对小红书草稿箱。本任务不会重新上传或重复保存。");
      }
    })();
    return initialization;
  }
  const exclusive = (operation) => {
    const task = queue.catch(() => {}).then(async () => { await initialize(); return operation(); });
    queue = task; return task;
  };
  const get = async (id) => {
    if (!JOB_ID.test(id)) throw new XhsError("草稿记录编号无效。", 400);
    const record = await store.get(`${PREFIX}${id}`);
    if (!record) throw new XhsError("没有找到这条同步记录。", 404);
    if (record.id !== id || !ACCOUNT_ID.test(record.accountId) || !Array.isArray(record.images) || record.images.length !== record.imageCount
      || !["uploading", "creating", "saved", "needs_confirmation", "failed"].includes(record.status)) throw new XhsError("同步记录不完整，请先核对小红书草稿箱。", 503);
    if (["uploading", "creating"].includes(record.status) && active !== id) return unknown(record, "同步已中断，请核对原任务。不会恢复上传或重复保存。");
    return record;
  };
  const checkIdle = () => { if (active) throw new XhsError("正在处理小红书草稿，请稍候查看结果。"); };
  async function verify(record) {
    const result = await driver.verify(record, () => write(record));
    if (result?.verified === true && result.draftId && result.draftRef) {
      record.status = "saved"; record.draftId = result.draftId; record.draftRef = result.draftRef;
      record.message = "已存入小红书草稿箱，标题、配文和图片顺序已核对。";
    } else { record.status = "needs_confirmation"; record.message = result?.message || "草稿结果需要核对，请检查小红书同步标签页。"; }
    await write(record); return record;
  }
  async function run(record) {
    try {
      record.prepared = await driver.prepare(record, () => write(record));
      if (record.uploadedCount !== record.imageCount || record.prepared?.jobId !== record.id || record.prepared.images?.length !== record.imageCount) throw new XhsError("图片尚未完整导入，请检查同步标签页。");
      record.status = "creating"; record.message = "正在暂存到小红书草稿箱"; await write(record);
      const saved = await driver.save(record, () => write(record));
      record.draftId = saved?.draftId; record.draftRef = saved?.draftRef;
      record.message = "正在重新打开草稿核对内容"; await write(record);
      await verify(record);
    } catch (error) {
      await unknown(record, error instanceof XhsError ? error.message : "本次同步结果尚未确认，请检查小红书同步标签页。不要重复提交。");
    }
  }
  async function submit(form) {
    const input = await readXhsSubmission(form);
    const previous = await store.get(`${PREFIX}${input.id}`);
    if (previous) {
      if (previous.fingerprint !== input.fingerprint || previous.accountId !== input.accountId) throw new XhsError("此同步编号对应另一组内容或账号。", 409);
      return publicJob(await get(input.id));
    }
    checkIdle();
    for (const { value: record } of await store.list(PREFIX)) if (pending.has(record.status) && record.acknowledged !== true) throw new XhsError("上次草稿结果还没核对，请先处理原任务。", 409);
    const state = await driver.accountState();
    if (state.status !== "connected" || state.account.id !== input.accountId) throw new XhsError("当前小红书账号与选择的账号不一致，请先重新核对。", 409);
    const record = { ...input, accountName: state.account.name, imageCount: input.images.length, uploadedCount: 0,
      status: "uploading", message: "已接收图片，正在打开小红书同步标签页", createdAt: new Date().toISOString() };
    await write(record);
    const initial = publicJob(record);
    // Return 202 immediately. Subsequent Chrome API calls plus the website's
    // status polling keep progress observable without one long RPC response.
    active = record.id;
    void run(record).catch(() => {}).finally(() => { active = null; });
    return initial;
  }
  const handle = async ({ path, method = "GET", body }) => {
    if (typeof path !== "string" || !path.startsWith("/api/xiaohongshu/")) return null;
    try {
      await initialize();
      if (method === "GET" && path === "/api/xiaohongshu/account") return await exclusive(async () => {
        checkIdle(); const state = await driver.accountState();
        if (state.status !== "connected") throw new XhsError(state.message);
        return { status: 200, body: { account: state.account } };
      });
      if (method === "POST" && path === "/api/xiaohongshu/login") return await exclusive(async () => {
        checkIdle(); return { status: 200, body: await driver.openLogin() };
      });
      if (method === "POST" && path === "/api/xiaohongshu/jobs") return await exclusive(async () => ({ status: 202, body: { job: await submit(body) } }));
      const match = /^\/api\/xiaohongshu\/jobs\/([a-f0-9-]+)(\/verify|\/acknowledge)?$/iu.exec(path);
      if (!match || !JOB_ID.test(match[1])) throw new XhsError("没有此小红书草稿操作。", 404);
      if (method === "GET" && !match[2]) return { status: 200, body: { job: publicJob(await get(match[1])) } };
      if (method === "POST" && match[2] === "/acknowledge") return await exclusive(async () => {
        checkIdle();
        if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true || Object.keys(body).length !== 1) throw new XhsError("请先在小红书核对并结束本次任务。", 400);
        const record = await get(match[1]);
        if (record.status !== "needs_confirmation") throw new XhsError("此任务不需要人工结束。", 409);
        record.acknowledged = true; record.message = "你已核对并结束本次任务，原编号不会重复上传或保存。"; await write(record);
        return { status: 200, body: { job: publicJob(record) } };
      });
      if (method === "POST" && match[2] === "/verify") return await exclusive(async () => {
        checkIdle(); const record = await get(match[1]); active = record.id;
        try { await verify(record); }
        catch (error) { await unknown(record, error instanceof XhsError ? error.message : "暂时无法重新核对，请检查同步标签页。不会重新上传或保存。"); }
        finally { active = null; }
        return { status: 200, body: { job: publicJob(record) } };
      });
      throw new XhsError("没有此小红书草稿操作。", 404);
    } catch (error) {
      return { status: error instanceof XhsError ? error.status : 503, body: { error: error instanceof XhsError ? error.message : "扩展暂时未能处理同步，请保留原记录并核对草稿箱。" } };
    }
  };
  handle.busy = () => Boolean(active);
  return handle;
}
