import type { DraftContent, DraftImage } from "../draftSync/types";
export type XhsAccount = { id: string; name: string };
export type XhsJob = {
  id: string; accountId: string; accountName: string; title: string;
  imageCount: number; uploadedCount: number; draftId?: string;
  status: "uploading" | "creating" | "saved" | "needs_confirmation" | "failed";
  message: string; acknowledged?: boolean;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
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
export function createXhsClient(token: string, fetcher: typeof fetch = fetch) {
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
    async openLogin(signal: AbortSignal) { await request("/login", signal, "POST"); },
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
    async waitForJob(initial: XhsJob, signal: AbortSignal, progress: (job: XhsJob) => void, timeoutMs = 90_000) {
      let job = initial;
      const deadline = Date.now() + timeoutMs;
      while (["uploading", "creating"].includes(job.status) && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(1000, deadline - Date.now()));
          signal.addEventListener("abort", abort, { once: true });
        });
        if (Date.now() >= deadline) break;
        job = await getJob(job.id, job.accountId, signal, Math.min(15_000, deadline - Date.now())); signal.throwIfAborted(); progress(job);
      }
      return job;
    },
  };
}
