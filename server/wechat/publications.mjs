import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { WechatApiError } from "../../lib/wechat/api.mjs";
import { JOB_ID, RequestError } from "./jobs.mjs";

const statuses = new Set(["submitting", "publishing", "published", "failed", "needs_confirmation", "removed", "blocked"]);
const remoteStatuses = new Set(["publishing", "published", "failed", "removed", "blocked"]);
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/\s/u.test(value);
function articleUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === "string" && url.protocol === "https:" && url.hostname === "mp.weixin.qq.com" && !url.port && !url.username && !url.password;
  } catch { return false; }
}
function publicRecord(record) {
  const { jobId, status, publishId, articleId, urls, message, createdAt, updatedAt } = record;
  return { jobId, status, ...(publishId ? { publishId } : {}), ...(articleId ? { articleId } : {}), urls: [...urls], message, createdAt, updatedAt };
}

// One durable reservation per already-verified draft. Neither process restarts
// nor lost HTTP replies may replay freepublish/submit. There is no timer here.
export function createPublicationService({ dataDir, accountId, api, jobs }) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{20}$/.test(accountId)) throw new TypeError("公众号标识无效。");
  const active = new Map();
  const unpersisted = new Map();
  let reservation = Promise.resolve();
  let pending = 0;
  const verifiedJob = (job, jobId, draftId) => job?.id === jobId && job.accountId === accountId
    && job.status === "saved" && identifier(job.draftId) && (!draftId || job.draftId === draftId)
    && Number.isSafeInteger(job.imageCount) && job.imageCount >= 1 && job.imageCount <= 20 && job.uploadedCount === job.imageCount;
  const directory = (jobId) => {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new RequestError("草稿记录编号无效");
    return join(dataDir, accountId, jobId);
  };
  function reserve(action) {
    pending++;
    const task = reservation.catch(() => {}).then(action).finally(() => { pending--; });
    reservation = task;
    return task;
  }
  async function syncDirectory(path) {
    const dir = await open(path, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  function retain(record) {
    record.status = "needs_confirmation";
    record.message = "发表记录暂时无法写入磁盘，已知任务编号保留在当前服务内存中。请勿重启或重复发表；恢复存储后读取原记录核对。";
    unpersisted.set(record.jobId, record);
    return record;
  }
  async function write(record) {
    record.updatedAt = new Date().toISOString();
    const path = directory(record.jobId);
    const temporary = join(path, `publication-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(path, "publication.json"));
      await syncDirectory(path);
      unpersisted.delete(record.jobId);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function persist(record) {
    try { await write(record); return record; }
    catch { return retain(record); }
  }
  async function read(jobId, optional = false) {
    const path = directory(jobId);
    if (unpersisted.has(jobId)) return unpersisted.get(jobId);
    if (active.has(jobId)) return active.get(jobId).record;
    let record;
    try { record = JSON.parse(await readFile(join(path, "publication.json"), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") {
        if (optional) return null;
        throw new RequestError("尚未找到此草稿的发表记录", 404);
      }
      throw new RequestError("发表记录无法读取，请到公众号后台核对；不会重复发表", 503);
    }
    if (!record || record.jobId !== jobId || record.accountId !== accountId || !identifier(record.draftId)
      || !Array.isArray(record.urls) || !record.urls.every(articleUrl)
      || (record.publishId !== undefined && !identifier(record.publishId))
      || (record.articleId !== undefined && !identifier(record.articleId))
      || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new RequestError("发表记录不完整，请到公众号后台核对；不会重复发表", 503);
    }
    if (!statuses.has(record.status) || typeof record.message !== "string" || record.status === "submitting"
      || (["publishing", "published", "removed", "blocked"].includes(record.status) && !record.publishId)
      || (record.status === "published" && (!record.publishId || !record.articleId || !record.urls.length))) {
      record.status = "needs_confirmation";
      record.message = "发表服务曾中断或记录尚未核对，请在公众号后台检查；不会重新提交发表。";
    }
    return record;
  }
  async function run(record) {
    let submitted = false;
    try {
      // Read WeChat's current draft after reserving. An edit in its own backend
      // must fail the existing content verification before publication begins.
      const verified = await jobs.verify(record.jobId);
      if (!verifiedJob(verified, record.jobId, record.draftId)) throw new Error();
      submitted = true;
      const result = await api.submitPublication({ draftId: record.draftId });
      if (!identifier(result?.publishId)) throw new Error();
      record.publishId = result.publishId;
      record.status = "publishing";
      record.message = "微信已接收发表任务，请读取原记录核对最终结果。";
    } catch (error) {
      const rejected = error instanceof WechatApiError && error.outcome === "rejected";
      record.status = !submitted || rejected ? "failed" : "needs_confirmation";
      record.message = !submitted ? "发表前草稿复核未通过或未能完成，尚未提交发表。请到公众号后台检查原草稿。"
        : rejected ? error.message : "发表提交结果尚未确认，请先在公众号后台核对；不会自动再次发表。";
    }
    return persist(record);
  }
  async function poll(record) {
    try {
      const result = await api.getPublication({ publishId: record.publishId });
      if (!remoteStatuses.has(result?.status) || typeof result.message !== "string" || !Array.isArray(result.urls) || !result.urls.every(articleUrl)
        || (result.status === "published" && (!identifier(result.articleId) || !result.urls.length))) throw new Error();
      record.status = result.status;
      if (result.articleId) record.articleId = result.articleId;
      // Keep previously confirmed links for deleted/blocked posts as evidence.
      if (result.urls.length) record.urls = [...result.urls];
      record.message = result.message;
    } catch (error) {
      record.status = "needs_confirmation";
      record.message = error instanceof WechatApiError && error.outcome === "rejected"
        ? error.message : "暂时无法核对发表结果，原任务编号已保留；请稍后读取，不要重复发表。";
    }
    return persist(record);
  }
  return {
    busy: () => pending > 0 || active.size > 0,
    submit(jobId) {
      return reserve(async () => {
        const previous = await read(jobId, true);
        if (previous) return publicRecord(previous);
        const job = await jobs.get(jobId);
        if (!verifiedJob(job, jobId)) {
          throw new RequestError("请先完整同步并核对本公众号的全部贴图草稿，再立即发表", 409);
        }
        const now = new Date().toISOString();
        const record = { jobId, accountId, draftId: job.draftId, status: "submitting", urls: [],
          message: "发表请求已记录，正在提交微信；请勿重复操作。", createdAt: now, updatedAt: now };
        const path = directory(jobId);
        let file;
        try { file = await open(join(path, "publication.json"), "wx", 0o600); }
        catch (error) {
          if (error.code === "EEXIST") return publicRecord(await read(jobId));
          throw new RequestError("无法保存发表记录，尚未提交微信，请检查本机存储", 503);
        }
        active.set(jobId, { record, task: null });
        try {
          try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
          finally { await file.close(); }
          await syncDirectory(path);
        } catch {
          active.delete(jobId);
          throw new RequestError("发表记录未能完整保存，尚未提交微信，请检查存储并核对记录", 503);
        }
        const first = publicRecord(record);
        const task = run(record).finally(() => { active.delete(jobId); });
        active.set(jobId, { record, task });
        return first;
      });
    },
    async get(jobId) { return publicRecord(await read(jobId)); },
    refresh(jobId) {
      return reserve(async () => {
        const record = await read(jobId);
        if (active.has(jobId) || !record.publishId) return publicRecord(record);
        const task = poll(record);
        active.set(jobId, { record, task });
        try { return publicRecord(await task); }
        finally { active.delete(jobId); }
      });
    },
    async idle() {
      await reservation.catch(() => {});
      await Promise.allSettled([...active.values()].map(({ task }) => task).filter(Boolean));
    },
  };
}
