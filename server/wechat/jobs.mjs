import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { WechatApiError, normalizeDraftCoverInfo, normalizeDraftCoverSource, normalizeDraftVerificationMismatches } from "../../lib/wechat/api.mjs";

export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const MAX_REQUEST_BYTES = 60 * 1024 * 1024 + 64 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Check the actual bytes, not only the browser-supplied MIME type or filename.
function isImage(bytes, type) {
  if (type === "image/png") return bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.subarray(12, 16).toString() === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  return type === "image/jpeg" && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
}

export async function readSubmission(form) {
  const fields = new Set(["id", "title", "body", "images", "expectedAccountId"]);
  if ([...form.keys()].some((key) => !fields.has(key))) throw new RequestError("同步内容包含未知字段");
  const text = (name) => {
    const values = form.getAll(name);
    if (values.length !== 1 || typeof values[0] !== "string") throw new RequestError("同步内容不完整，请重新确认内容");
    return values[0];
  };
  // Multipart encoders normalize textarea newlines to CRLF. Restore the
  // editor's LF representation before limits, fingerprints, and API readback.
  const id = text("id"), title = text("title"), body = text("body").replace(/\r\n?/g, "\n");
  const expectedAccountId = text("expectedAccountId");
  if (!/^[a-f0-9]{20}$/.test(expectedAccountId)) throw new RequestError("请先连接并核对目标公众号");
  if (!JOB_ID.test(id)) throw new RequestError("草稿记录编号无效");
  if (!title.trim() || [...title].length > 20 || /[\r\n]/u.test(title) || title.includes("\0")) throw new RequestError("公众号标题需要为 1–20 个字符，且不含换行");
  if ([...body].length > 1000 || Buffer.byteLength(body, "utf8") > 2048 || body.includes("\0")) throw new RequestError("公众号配文超过本工具的 1,000 字或 2,048 字节上限，请缩短后同步");
  const files = form.getAll("images");
  if (files.length < 1 || files.length > 20) throw new RequestError("公众号贴图需要 1–20 张图片");
  const images = [];
  let total = 0;
  for (const file of files) {
    if (typeof file === "string" || !["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 10_000_000) throw new RequestError("请使用单张不超过 10 MB 的 PNG 或 JPEG 图片");
    total += file.size;
    if (total > 60 * 1024 * 1024) throw new RequestError("本次图片总大小超过 60 MiB");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!isImage(bytes, file.type)) throw new RequestError("图片文件与格式不符，请重新生成或选择图片");
    images.push({ blob: new Blob([bytes], { type: file.type }), name: `poster-${images.length + 1}.${file.type === "image/png" ? "png" : "jpg"}`, hash: hash(bytes) });
  }
  const fingerprint = hash(JSON.stringify({ title, body, images: images.map((image) => image.hash) }));
  return { id, title, body, images, fingerprint, expectedAccountId };
}

function publicJob(record) {
  const { id, accountId, accountName, title, imageCount, uploadedCount, status, message, draftId, createdAt, updatedAt } = record;
  return { id, accountId, accountName, title, imageCount, uploadedCount, status, message, ...(draftId ? { draftId } : {}), createdAt, updatedAt };
}

// A directory reservation is durable before the first platform write. Existing
// IDs are never replayed, including after a process crash or a lost HTTP reply.
export function createJobService({ dataDir, appId, accountName, api }) {
  const account = { id: hash(appId).slice(0, 20), name: accountName };
  const root = join(dataDir, account.id);
  const active = new Map();
  const unpersisted = new Map();
  const publicationAttempts = new Map();
  let reservation = Promise.resolve();
  let pending = 0;
  let resolving = false;
  function reserve(action) {
    pending++;
    const task = reservation.catch(() => {}).then(action).finally(() => { pending--; });
    reservation = task;
    return task;
  }
  function retainAfterStorageFailure(record) {
    if (record.draftId || record.status !== "failed") record.status = "needs_confirmation";
    const notice = "同步记录暂时无法写入磁盘，已知结果保留在当前服务内存中。请恢复存储后再操作；此时不要重启服务或重复创建。";
    if (!record.message.includes(notice)) record.message += notice;
    unpersisted.set(record.id, record);
    return record;
  }
  const directory = (id) => {
    if (!JOB_ID.test(id)) throw new RequestError("草稿记录编号无效");
    return join(root, id);
  };
  async function syncDirectory(path) {
    const dir = await open(path, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async function write(record) {
    record.updatedAt = new Date().toISOString();
    const path = directory(record.id), temporary = join(path, `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temporary, join(path, "job.json"));
      await syncDirectory(path);
      unpersisted.delete(record.id);
    } finally { await rm(temporary, { force: true }); }
  }
  async function read(id) {
    const path = directory(id);
    if (unpersisted.has(id)) return unpersisted.get(id);
    let value;
    try { value = JSON.parse(await readFile(join(path, "job.json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") {
        // An interrupted initial write leaves its reservation in place.
        throw new RequestError("尚未找到完整同步记录。请先核对公众号草稿箱，不要直接重复提交", 404);
      }
      throw new RequestError("同步记录无法读取，请先在公众号草稿箱核对结果", 503);
    }
    if (!value || value.id !== id || value.accountId !== account.id) throw new RequestError("同步记录不完整，请先人工核对", 503);
    if (value.resolution === "confirmed_absent" && !Array.isArray(value.imageMediaIds)) {
      throw new RequestError("此同步记录已确认未创建草稿并结束，请使用新的同步记录", 410);
    }
    if (!Array.isArray(value.imageMediaIds)) throw new RequestError("同步记录不完整，请先人工核对", 503);
    if (["uploading", "creating"].includes(value.status) && !active.has(id)) {
      const notCreated = value.status === "uploading" && !value.draftId;
      value.status = notCreated ? "failed" : "needs_confirmation";
      value.message = notCreated
        ? "图片上传阶段的同步服务曾中断，尚未创建草稿；已上传的素材可能保留在素材库。"
        : "同步服务曾中断，结果需要核对。不会重新上传或重复创建草稿。";
      await write(value);
    }
    return value;
  }
  async function verify(record) {
    if (!record.draftId) return record;
    delete record.coverInfo;
    delete record.coverSource;
    delete record.verificationMismatches;
    try {
      const result = await api.verifyDraft({ draftId: record.draftId, title: record.title, body: record.body, imageMediaIds: record.imageMediaIds });
      const coverInfo = normalizeDraftCoverInfo(result.coverInfo);
      if (coverInfo) record.coverInfo = coverInfo;
      const coverSource = normalizeDraftCoverSource(result.coverSource);
      if (coverSource) record.coverSource = coverSource;
      const verificationMismatches = normalizeDraftVerificationMismatches(result.verificationMismatches);
      if (verificationMismatches) record.verificationMismatches = verificationMismatches;
      record.status = result.verified ? "saved" : "needs_confirmation";
      record.message = result.verified ? "公众号接口已确认草稿的标题、配文和全部图片顺序。请打开草稿箱检查实际图片显示。" : result.message;
    } catch (error) {
      record.status = "needs_confirmation";
      record.message = "公众号已返回草稿编号，但详情暂未核对完成。"
        + (error instanceof WechatApiError ? error.message : "请读取核对，不要重复创建。");
    }
    await write(record);
    return record;
  }
  async function run(record, images) {
    let stage = "upload";
    try {
      for (const image of images) {
        record.imageMediaIds.push(await api.uploadImage(image));
        record.uploadedCount = record.imageMediaIds.length;
        record.message = `已上传 ${record.uploadedCount} / ${record.imageCount} 张图片，尚未创建草稿。`;
        await write(record);
      }
      record.status = "creating";
      record.message = "图片已全部上传，正在创建公众号贴图草稿。";
      await write(record);
      stage = "create";
      record.draftId = await api.createDraft({ title: record.title, body: record.body, imageMediaIds: record.imageMediaIds });
      record.status = "needs_confirmation";
      record.message = "公众号已返回草稿编号，正在读取详情核对。";
      stage = "verify";
      await write(record);
      await verify(record);
    } catch (error) {
      const controlled = error instanceof WechatApiError;
      const notSubmitted = controlled && error.outcome === "not_submitted";
      const rejected = controlled && error.outcome === "rejected";
      record.status = !record.draftId && (stage === "upload" || (stage === "create" && (rejected || notSubmitted))) ? "failed" : "needs_confirmation";
      record.message = stage === "upload"
        ? `图片上传未完成，未创建草稿；已确认 ${record.uploadedCount} / ${record.imageCount} 张素材。可能有部分素材已进入素材库，请核对后再操作。`
        : stage === "create" && notSubmitted
          ? "公众号草稿创建请求尚未发出；已上传的图片保留在素材库。"
        : stage === "create" && rejected
          ? "公众号拒绝创建本次草稿；已上传的图片保留在素材库。请检查内容与接口配置后再操作。"
          : record.draftId
            ? "公众号已返回草稿编号，但核对或记录保存尚未完成。请读取原记录核对，不要重复创建。"
            : "草稿创建结果尚未确认。请先查看公众号草稿箱；服务不会重复创建。";
      if (controlled) record.message += error.message;
      // If storage itself fails, the last durable stage still blocks replay.
      try { await write(record); }
      catch { retainAfterStorageFailure(record); }
    }
  }
  return {
    account,
    busy: () => pending > 0 || active.size > 0 || publicationAttempts.size > 0,
    beginPublication(id) {
      directory(id);
      if (resolving) throw new RequestError("正在确认公众号草稿结果，请完成后再发表", 409);
      publicationAttempts.set(id, (publicationAttempts.get(id) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = publicationAttempts.get(id) - 1;
        if (remaining) publicationAttempts.set(id, remaining);
        else publicationAttempts.delete(id);
      };
    },
    async checkConnection() { await api.checkConnection(); return account; },
    submit(input) {
      return reserve(async () => {
        if (input.expectedAccountId !== account.id) throw new RequestError("公众号配置已变化，请重新连接并核对目标账号后再同步", 409);
        try { await mkdir(root, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        await syncDirectory(dataDir);
        if (active.size && !active.has(input.id)) throw new RequestError("上一组公众号内容仍在处理中，请先读取同步状态", 409);
        const entries = await readdir(root, { withFileTypes: true });
        if (entries.some((entry) => entry.name === input.id)) {
          const previous = await read(input.id);
          if (previous.fingerprint !== input.fingerprint) throw new RequestError("此同步编号对应另一组内容，请先核对已有记录", 409);
          return publicJob(previous);
        }
        // A same-ID request above remains read-only, even during a storage
        // outage. Before admitting new work, persist the retained terminal
        // result so an older durable stage cannot keep a known failure blocked.
        for (const record of [...unpersisted.values()]) await write(record);
        for (const entry of entries) {
          if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
          let previous;
          try { previous = await read(entry.name); }
          catch (error) {
            if (error instanceof RequestError && [404, 410].includes(error.status)) continue;
            throw error;
          }
          if (previous.fingerprint === input.fingerprint && ["uploading", "creating", "needs_confirmation"].includes(previous.status)) {
            throw new RequestError("这组内容已有待核对的同步记录，请先检查原任务和公众号草稿箱，勿重复创建。", 409);
          }
        }
        try { await mkdir(directory(input.id), { mode: 0o700 }); await syncDirectory(root); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const previous = await read(input.id);
          if (previous.fingerprint !== input.fingerprint) throw new RequestError("此同步编号对应另一组内容，请先核对已有记录", 409);
          return publicJob(previous);
        }
        const now = new Date().toISOString();
        const record = { id: input.id, accountId: account.id, accountName: account.name, title: input.title, body: input.body, fingerprint: input.fingerprint,
          imageCount: input.images.length, uploadedCount: 0, imageMediaIds: [], status: "uploading", message: "已接收全部图片，正在上传到公众号素材库。", createdAt: now, updatedAt: now };
        // Install the in-process lock before the first async write or readback.
        active.set(input.id, null);
        try { await write(record); }
        catch (error) { active.delete(input.id); throw error; }
        const first = publicJob(record);
        const task = run(record, input.images).catch(() => {}).finally(() => { active.delete(input.id); });
        active.set(input.id, task);
        return first;
      });
    },
    get(id) { return reserve(async () => publicJob(await read(id))); },
    verify(id) {
      return reserve(async () => {
        const record = await read(id);
        if (active.has(id) || !record.draftId) return publicJob(record);
        const task = verify(record);
        active.set(id, task);
        try { return publicJob(await task); }
        catch { return publicJob(retainAfterStorageFailure(record)); }
        finally { active.delete(id); }
      });
    },
    async resolve(id) {
      const path = directory(id);
      if (active.size || publicationAttempts.size) throw new RequestError("该公众号仍在处理任务，请完成后再确认草稿结果", 409);
      return reserve(async () => {
        if (active.size || publicationAttempts.size) throw new RequestError("该公众号仍在处理任务，请完成后再确认草稿结果", 409);
        resolving = true;
        try {
          try {
            await lstat(join(path, "publication.json"));
            throw new RequestError("此草稿已有发表记录，不能确认未创建，请先核对公众号后台", 409);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          let record;
          try { record = await read(id); }
          catch (error) {
            if (error instanceof RequestError && error.status === 410) return { jobId: id, accountId: account.id, confirmedNoDraft: true };
            if (!(error instanceof RequestError && error.status === 404)) throw error;
          }
          if (record?.draftId || record?.status === "saved") throw new RequestError("公众号已返回草稿编号或已确认保存，不能确认未创建，请先核对原草稿", 409);
          if (record && !["failed", "needs_confirmation"].includes(record.status)) throw new RequestError("此同步任务尚未结束，请完成后再确认草稿结果", 409);
          if (record?.resolution !== "confirmed_absent") {
            const now = new Date().toISOString();
            record = record ? { ...record, status: "failed", message: "已由用户确认公众号草稿箱中没有本次草稿，此同步记录已结束。", resolution: "confirmed_absent" }
              : { id, accountId: account.id, resolution: "confirmed_absent", createdAt: now, updatedAt: now };
            try {
              await mkdir(root, { recursive: true, mode: 0o700 });
              await syncDirectory(dataDir);
              await mkdir(path, { recursive: true, mode: 0o700 });
              await syncDirectory(root);
              await write(record);
            } catch {
              throw new RequestError("未能保存草稿确认结果，请恢复本机存储后重新确认，暂勿重新创建", 503);
            }
          }
          return { jobId: id, accountId: account.id, confirmedNoDraft: true };
        } finally { resolving = false; }
      });
    },
    async idle() {
      await reservation.catch(() => {});
      await Promise.allSettled([...active.values()].filter(Boolean));
    },
  };
}
