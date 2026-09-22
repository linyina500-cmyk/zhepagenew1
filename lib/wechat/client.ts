import type { DraftContent, DraftImage } from "../draftSync/types";

export type WechatAccount = { id: string; name: string };
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

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const terminal = (job: WechatJob) => !["uploading", "creating"].includes(job.status);

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

// The connection password only lives in the caller's component and this request
// closure. It is never placed in a URL, local storage, or a draft receipt.
export function createWechatClient(password: string, fetcher: typeof fetch = fetch) {
  const token = password.trim();
  async function request(path: string, signal: AbortSignal, body?: FormData, method = "GET", timeoutMs = 15_000) {
    signal.throwIfAborted();
    if (!token) throw new Error("请填写公众号连接口令。");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("公众号服务响应超时，请稍后读取状态。")), timeoutMs);
    try {
      const response = await fetcher(`/api/wechat${path}`, {
        method, headers: { Authorization: `Bearer ${token}` }, body, signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(record(data) && typeof data.error === "string" ? data.error
        : response.status === 503 ? "公众号同步服务尚未配置，请先完成服务器连接。"
          : response.status === 404 ? "未找到这次同步任务，请先在公众号草稿箱核对，勿重复提交。" : `公众号服务请求未完成（${response.status}）。`);
      if (!record(data)) throw new Error("公众号服务返回了无法识别的结果，请稍后读取状态。");
      return data;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  async function getJob(id: string, accountId: string, signal: AbortSignal, timeoutMs?: number) {
    const data = await request(`/jobs/${encodeURIComponent(id)}`, signal, undefined, "GET", timeoutMs);
    return parseJob(data.job, id, accountId);
  }
  return {
    async getAccount(signal: AbortSignal): Promise<WechatAccount> {
      const data = await request("/account", signal, undefined, "GET", 70_000);
      if (!record(data.account) || !nonempty(data.account.id) || !nonempty(data.account.name)) throw new Error("公众号服务未返回可核对的账号，请检查服务器配置。");
      return { id: data.account.id, name: data.account.name };
    },
    getJob,
    async createJob(input: { id: string; accountId: string; content: DraftContent; images: DraftImage[] }, signal: AbortSignal) {
      const form = new FormData();
      form.append("id", input.id); form.append("expectedAccountId", input.accountId); form.append("title", input.content.title); form.append("body", input.content.body);
      for (const image of input.images) form.append("images", image.blob, image.name);
      try {
        const data = await request("/jobs", signal, form, "POST", 90_000);
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
      const data = await request(`/jobs/${encodeURIComponent(id)}/verify`, signal, undefined, "POST", 70_000);
      return parseJob(data.job, id, accountId);
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
