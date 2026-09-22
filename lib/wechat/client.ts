import type { DraftContent, DraftImage } from "../draftSync/types";

export type WechatAccount = { id: string; name: string };
export type WechatPublication = {
  jobId: string; status: "submitting" | "publishing" | "published" | "failed" | "needs_confirmation" | "removed" | "blocked";
  publishId?: string; articleId?: string; urls: string[]; message: string; createdAt: string; updatedAt: string;
};
export type WechatJob = {
  id: string;
  accountId: string;
  accountName: string;
  title: string;
  imageCount: number;
  uploadedCount: number;
  status: "uploading" | "creating" | "saved" | "needs_confirmation" | "failed";
  message: string;
  draftId?: string;
  createdAt: string;
  updatedAt: string;
};
export class WechatUnconfirmedError extends Error {}
export class WechatRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const terminal = (job: WechatJob) => !["uploading", "creating"].includes(job.status);
function accountPath(id: string) {
  if (!/^[a-f0-9]{20}$/u.test(id)) throw new Error("公众号账号标识不一致，请重新连接。");
  return `/accounts/${id}`;
}
function jobPath(id: string, accountId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) throw new Error("公众号任务标识无效。");
  return `${accountPath(accountId)}/jobs/${id}`;
}
function parsePublication(value: unknown, jobId: string): WechatPublication {
  if (!record(value) || value.jobId !== jobId || !["submitting", "publishing", "published", "failed", "needs_confirmation", "removed", "blocked"].includes(String(value.status))
    || typeof value.message !== "string" || !nonempty(value.createdAt) || !nonempty(value.updatedAt)
    || (value.publishId !== undefined && !nonempty(value.publishId)) || (value.articleId !== undefined && !nonempty(value.articleId))
    || !Array.isArray(value.urls) || value.urls.some((url) => {
      if (typeof url !== "string") return true;
      try { const parsed = new URL(url); return !["http:", "https:"].includes(parsed.protocol) || parsed.hostname !== "mp.weixin.qq.com" || Boolean(parsed.username || parsed.password || parsed.port); }
      catch { return true; }
    })) throw new Error("公众号发表结果不完整，请读取原任务状态，勿重复发表。");
  return value as WechatPublication;
}

function parseJob(value: unknown, id: string, accountId: string): WechatJob {
  if (!record(value) || value.id !== id || value.accountId !== accountId || !nonempty(value.accountName)
    || typeof value.title !== "string" || typeof value.message !== "string"
    || !Number.isInteger(value.imageCount) || Number(value.imageCount) < 1 || Number(value.imageCount) > 20
    || !Number.isInteger(value.uploadedCount) || Number(value.uploadedCount) < 0 || Number(value.uploadedCount) > Number(value.imageCount)
    || !["uploading", "creating", "saved", "needs_confirmation", "failed"].includes(String(value.status))
    || !nonempty(value.createdAt) || !nonempty(value.updatedAt)
    || (value.draftId !== undefined && !nonempty(value.draftId))
    || (value.status === "saved" && (!nonempty(value.draftId) || value.uploadedCount !== value.imageCount))) {
    throw new Error("公众号返回的任务或账号信息不一致，请先核对连接账号和草稿箱。");
  }
  return value as WechatJob;
}

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Credentials travel only in the header or explicit account connection body;
// the encrypted device vault owns persistence, never draft records or URLs.
export function createWechatClient(password: string, fetcher: typeof fetch = fetch) {
  const token = password.trim();
  async function request(path: string, signal: AbortSignal, body?: FormData | Record<string, unknown>, method = "GET", timeoutMs = 15_000) {
    signal.throwIfAborted();
    if (!token) throw new Error("请填写公众号连接口令。");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("公众号服务响应超时，请稍后读取状态。")), timeoutMs);
    const json = body !== undefined && !(body instanceof FormData);
    try {
      const response = await fetcher(`/api/wechat${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) }, body: json ? JSON.stringify(body) : body as FormData | undefined, signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new WechatRequestError(record(data) && typeof data.error === "string" ? data.error
        : response.status === 503 ? "公众号同步服务尚未配置，请先完成服务器连接。"
          : response.status === 404 ? "未找到这次同步任务，请先在公众号草稿箱核对，勿重复提交。" : `公众号服务请求未完成（${response.status}）。`, response.status);
      if (!record(data)) throw new Error("公众号服务返回了无法识别的结果，请稍后读取状态。");
      return data;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  async function getJob(id: string, accountId: string, signal: AbortSignal, timeoutMs?: number) {
    const data = await request(jobPath(id, accountId), signal, undefined, "GET", timeoutMs);
    return parseJob(data.job, id, accountId);
  }
  async function getPublication(id: string, accountId: string, signal: AbortSignal): Promise<WechatPublication | null> {
    const data = await request(`${jobPath(id, accountId)}/publication`, signal);
    return data.publication === null ? null : parsePublication(data.publication, id);
  }
  async function refreshPublication(id: string, accountId: string, signal: AbortSignal, timeoutMs = 70_000) {
    const data = await request(`${jobPath(id, accountId)}/publication/refresh`, signal, undefined, "POST", timeoutMs);
    return parsePublication(data.publication, id);
  }
  return {
    async getConnection(signal: AbortSignal): Promise<{ deviceId: string; busy?: boolean }> {
      const data = await request("/connection", signal);
      if (!nonempty(data.deviceId) || (data.busy !== undefined && typeof data.busy !== "boolean")) throw new Error("本机服务未返回有效设备状态，请重新连接。");
      return { deviceId: data.deviceId, ...(typeof data.busy === "boolean" ? { busy: data.busy } : {}) };
    },
    async connectAccount(input: { deviceId: string; appId: string; appSecret: string; name: string }, signal: AbortSignal): Promise<WechatAccount> {
      const expectedId = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.appId))), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 20);
      const data = await request("/accounts/connect", signal, { deviceId: input.deviceId, appId: input.appId, appSecret: input.appSecret, name: input.name }, "POST", 70_000);
      if (!record(data.account) || data.account.id !== expectedId || !nonempty(data.account.name)) throw new Error("公众号连接返回了不同的账号，请先核对。");
      return { id: data.account.id, name: data.account.name };
    },
    async disconnectAccount(id: string, signal: AbortSignal) { await request(`${accountPath(id)}/disconnect`, signal, undefined, "POST"); },
    getJob, getPublication, refreshPublication,
    async createJob(input: { id: string; accountId: string; content: DraftContent; images: DraftImage[] }, signal: AbortSignal) {
      jobPath(input.id, input.accountId);
      const form = new FormData();
      form.append("id", input.id); form.append("expectedAccountId", input.accountId); form.append("title", input.content.title); form.append("body", input.content.body);
      for (const image of input.images) form.append("images", image.blob, image.name);
      try {
        const data = await request(`${accountPath(input.accountId)}/jobs`, signal, form, "POST", 90_000);
        return parseJob(data.job, input.id, input.accountId);
      } catch {
        signal.throwIfAborted();
        // A lost response never authorizes a second create. Read the identity
        // persisted before this POST once; otherwise leave it unconfirmed.
        try { return await getJob(input.id, input.accountId, signal); }
        catch (error) {
          signal.throwIfAborted();
          throw new WechatUnconfirmedError(`尚未确认这次同步结果。请保留本机记录，读取状态或到公众号草稿箱核对；不要重复提交。${error instanceof Error ? error.message : ""}`);
        }
      }
    },
    async verifyJob(id: string, accountId: string, signal: AbortSignal) {
      const data = await request(`${jobPath(id, accountId)}/verify`, signal, undefined, "POST", 70_000);
      return parseJob(data.job, id, accountId);
    },
    async submitPublication(id: string, accountId: string, signal: AbortSignal) {
      try {
        const data = await request(`${jobPath(id, accountId)}/publication`, signal, { confirm: true }, "POST", 90_000);
        return parsePublication(data.publication, id);
      } catch {
        signal.throwIfAborted();
        try { const found = await getPublication(id, accountId, signal); if (found) return found; } catch { signal.throwIfAborted(); }
        throw new WechatUnconfirmedError("发表结果尚未确认，请刷新原任务状态并核对公众号后台，不要再次发表。");
      }
    },
    async waitForPublication(initial: WechatPublication, accountId: string, signal: AbortSignal, onProgress: (publication: WechatPublication) => void, timeoutMs = 90_000) {
      let publication = initial;
      const deadline = Date.now() + timeoutMs;
      while (["submitting", "publishing"].includes(publication.status) && Date.now() < deadline) {
        await pause(Math.min(3000, deadline - Date.now()), signal);
        if (Date.now() >= deadline) break;
        publication = await refreshPublication(publication.jobId, accountId, signal, Math.min(70_000, deadline - Date.now()));
        signal.throwIfAborted(); onProgress(publication);
      }
      return publication;
    },
    async waitForJob(initial: WechatJob, signal: AbortSignal, onProgress: (job: WechatJob) => void, timeoutMs = 90_000) {
      let job = initial;
      const deadline = Date.now() + timeoutMs;
      while (!terminal(job) && Date.now() < deadline) {
        await pause(Math.min(1000, deadline - Date.now()), signal);
        if (Date.now() >= deadline) break;
        job = await getJob(job.id, job.accountId, signal, Math.min(15_000, deadline - Date.now()));
        signal.throwIfAborted(); onProgress(job);
      }
      return job;
    },
  };
}
