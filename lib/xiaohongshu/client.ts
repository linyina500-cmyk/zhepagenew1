import type { DraftContent, DraftImage } from "../draftSync/types";
import { localSyncFetch } from "../localSync/transport";
export type XhsAccount = { id: string; name: string };
export type XhsLoginState = { status: "connected"; account: XhsAccount }
  | { status: "login_required" | "needs_attention"; message: string };
export type XhsJob = {
  id: string; accountId: string; accountName: string; title: string;
  imageCount: number; uploadedCount: number; draftId?: string;
  status: "uploading" | "creating" | "saved" | "needs_confirmation" | "failed";
  message: string; acknowledged?: boolean;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function parseLoginState(value: Record<string, unknown>): XhsLoginState {
  if (value.status === "connected" && Object.keys(value).every((key) => ["status", "account"].includes(key))) {
    const account = value.account;
    if (record(account) && Object.keys(account).every((key) => ["id", "name"].includes(key))
      && typeof account.id === "string" && /^[a-f0-9]{20}$/u.test(account.id)
      && typeof account.name === "string" && account.name.trim() && account.name.length <= 100 && !/[\r\n\0]/u.test(account.name)) {
      return { status: "connected", account: { id: account.id, name: account.name } };
    }
  }
  if ((value.status === "login_required" || value.status === "needs_attention")
    && Object.keys(value).every((key) => ["status", "message"].includes(key))
    && typeof value.message === "string" && value.message.trim() && value.message.length <= 500 && !value.message.includes("\0")) {
    return { status: value.status, message: value.message };
  }
  throw new Error("小红书登录结果未能确认，请检查专用窗口后重试。");
}
function parseJob(value: unknown, id: string, accountId: string): XhsJob {
  if (!record(value) || value.id !== id || value.accountId !== accountId || typeof value.accountName !== "string"
    || typeof value.title !== "string" || typeof value.message !== "string"
    || !Number.isInteger(value.imageCount) || Number(value.imageCount) < 1 || Number(value.imageCount) > 18
    || !Number.isInteger(value.uploadedCount) || Number(value.uploadedCount) < 0 || Number(value.uploadedCount) > Number(value.imageCount)
    || !["uploading", "creating", "saved", "needs_confirmation", "failed"].includes(String(value.status))
    || (value.acknowledged !== undefined && typeof value.acknowledged !== "boolean")
    || (value.status === "saved" && (typeof value.draftId !== "string" || !value.draftId || value.uploadedCount !== value.imageCount))) {
    throw new Error("小红书返回的账号或任务内容不一致，请先核对专用窗口和草稿箱。");
  }
  return value as XhsJob;
}
export function createXhsClient(token: string, fetcher: typeof fetch = localSyncFetch) {
  async function request(path: string, signal: AbortSignal, method = "GET", body?: FormData | string, timeoutMs = 90_000) {
    signal.throwIfAborted();
    if (!token.trim()) throw new Error("请先连接本机服务。");
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetcher(`/api/xiaohongshu${path}`, {
      method, body, headers: { Authorization: `Bearer ${token.trim()}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
      signal: combined, cache: "no-store", credentials: "same-origin", redirect: "error",
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !record(data)) throw new Error(record(data) && typeof data.error === "string" ? data.error : "本机服务暂未回应，请保留原记录并核对草稿箱。");
    return data;
  }
  async function getJob(id: string, accountId: string, signal: AbortSignal, timeoutMs = 15_000) {
    return parseJob((await request(`/jobs/${encodeURIComponent(id)}`, signal, "GET", undefined, timeoutMs)).job, id, accountId);
  }
  return {
    async getAccount(signal: AbortSignal): Promise<XhsAccount> {
      const value = (await request("/account", signal)).account;
      if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name) throw new Error("尚未识别到可核对的小红书账号，请在专用窗口完成登录。");
      return { id: value.id, name: value.name };
    },
    async openLogin(signal: AbortSignal): Promise<XhsLoginState> { return parseLoginState(await request("/login", signal, "POST")); },
    getJob,
    async createJob(input: { id: string; accountId: string; content: DraftContent; images: DraftImage[] }, signal: AbortSignal) {
      const body = new FormData();
      body.set("id", input.id); body.set("expectedAccountId", input.accountId); body.set("title", input.content.title); body.set("body", input.content.body);
      for (const image of input.images) body.append("images", image.blob, image.name);
      try { return parseJob((await request("/jobs", signal, "POST", body)).job, input.id, input.accountId); }
      catch {
        signal.throwIfAborted();
        try { return await getJob(input.id, input.accountId, signal); }
        catch { signal.throwIfAborted(); throw new Error("本次结果尚未确认，请读取原任务状态并核对小红书草稿箱，不要重复提交。"); }
      }
    },
    async verifyJob(id: string, accountId: string, signal: AbortSignal) {
      return parseJob((await request(`/jobs/${encodeURIComponent(id)}/verify`, signal, "POST")).job, id, accountId);
    },
    async acknowledgeJob(id: string, accountId: string, signal: AbortSignal) {
      return parseJob((await request(`/jobs/${encodeURIComponent(id)}/acknowledge`, signal, "POST", JSON.stringify({ confirm: true }))).job, id, accountId);
    },
    async waitForJob(initial: XhsJob, signal: AbortSignal, progress: (job: XhsJob) => void) {
      signal.throwIfAborted();
      let job = initial;
      while (["uploading", "creating"].includes(job.status)) {
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
          signal.addEventListener("abort", abort, { once: true });
        });
        job = await getJob(job.id, job.accountId, signal); signal.throwIfAborted(); progress(job);
      }
      return job;
    },
  };
}
