import type { DraftContent, DraftImage, DraftPlatform } from "../draftSync/types";
import { imageMetadata, validateDraft } from "../draftSync/validation";

export const BROWSER_SYNC_VERSION = "0.2.1";
export const BROWSER_SYNC_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const CHANNEL = "zhepage-browser-sync-v1";
const ID = /^[a-zA-Z0-9-]{1,80}$/;

export type BrowserSyncJob = {
  id: string;
  status: "ready" | "filling" | "filled" | "needs_confirmation";
  message: string;
  title: string;
  imageCount: number;
};
export type BrowserSyncPrepareInput = { id: string; platform: DraftPlatform; content: DraftContent; images: DraftImage[] };
type Response = { ok: boolean; message?: string; version?: string; job?: unknown };
type Pending = { settle: (error?: Error, response?: Response) => void };

export class BrowserSyncUnconfirmedError extends Error {
  constructor(message: string) {
    super(`扩展中的内容尚未完成核对：${message}。请读取传图状态，不要重复传入。`);
    this.name = "BrowserSyncUnconfirmedError";
  }
}
class ResponseTimeout extends Error {}
const cancelled = () => new DOMException("已停止等待浏览器扩展", "AbortError");
const messageOf = (error: unknown) => error instanceof Error ? error.message : "未收到完整回应";

function readJob(value: unknown): BrowserSyncJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("扩展返回的传图记录不完整");
  const job = value as BrowserSyncJob;
  if (typeof job.id !== "string" || !ID.test(job.id)
    || !["ready", "filling", "filled", "needs_confirmation"].includes(job.status)
    || typeof job.title !== "string" || !job.title.trim() || [...job.title].length > 20
    || typeof job.message !== "string" || job.message.length > 4000
    || !Number.isSafeInteger(job.imageCount) || job.imageCount < 1 || job.imageCount > 20) throw new Error("扩展返回的传图记录不完整");
  return { id: job.id, status: job.status, message: job.message, title: job.title, imageCount: job.imageCount };
}

export function createBrowserSyncClient(window: Window) {
  const sourceWindow = window.document.defaultView;
  const isSourcePage = () => window.top === window.self && window.location.origin === BROWSER_SYNC_ORIGIN
    && ["/", "/browser-sync-check"].includes(window.location.pathname);
  if (!sourceWindow || !isSourcePage()) throw new Error("请在折页的草稿同步页面使用浏览器扩展");
  let disposed = false;
  let preparing = false;
  const pending = new Map<string, Pending>();
  function assertActive(signal?: AbortSignal) {
    if (disposed || signal?.aborted) throw cancelled();
    if (!isSourcePage()) throw new Error("请返回折页的草稿同步页面后再操作");
  }
  function onMessage(event: MessageEvent) {
    const data = event.data;
    if (!isSourcePage() || event.source !== sourceWindow || event.origin !== BROWSER_SYNC_ORIGIN || !data || data.channel !== CHANNEL
      || data.kind !== "response" || typeof data.id !== "string") return;
    const item = pending.get(data.id);
    if (!item) return;
    if (data.ok === true) item.settle(undefined, data);
    else item.settle(new Error(typeof data.message === "string" && data.message.length <= 4000 ? data.message : "浏览器扩展未完成本次操作"));
  }
  window.addEventListener("message", onMessage);

  function request(action: "ping" | "prepare" | "status", fields: Record<string, unknown>, timeout: number, signal?: AbortSignal, onSent?: () => void): Promise<Response> {
    return new Promise((resolve, reject) => {
      try { assertActive(signal); } catch (error) { reject(error); return; }
      const id = typeof fields.id === "string" ? fields.id : window.crypto.randomUUID();
      if (pending.has(id)) { reject(new Error("这次传图请求仍在处理中")); return; }
      const abort = () => settle(cancelled());
      const timer = window.setTimeout(() => settle(new ResponseTimeout("没有收到扩展回应，请确认脚本已启用")), timeout);
      function settle(error?: Error, response?: Response) {
        if (pending.get(id)?.settle !== settle) return;
        pending.delete(id);
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(response!);
      }
      pending.set(id, { settle });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        assertActive(signal);
        window.postMessage({ channel: CHANNEL, kind: "request", ...fields, id, action }, BROWSER_SYNC_ORIGIN);
        onSent?.();
      } catch (error) { settle(error instanceof Error ? error : new Error("无法向浏览器扩展传入内容")); }
    });
  }

  async function ping(signal?: AbortSignal): Promise<{ version: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request("ping", {}, 3000, signal);
        if (response.version !== BROWSER_SYNC_VERSION) throw new Error(`请安装或更新折页传图脚本至 ${BROWSER_SYNC_VERSION}，然后刷新本页再检查`);
        return { version: response.version };
      } catch (error) {
        if (!(error instanceof ResponseTimeout) || attempt >= 2) throw error;
      }
    }
  }

  async function getStatus(platform: DraftPlatform, signal?: AbortSignal): Promise<BrowserSyncJob | null> {
    if (!["xiaohongshu", "wechat"].includes(platform)) throw new Error("未知平台");
    const response = await request("status", { platform }, 30000, signal);
    if (response.job === null) return null;
    return readJob(response.job);
  }

  async function prepare(input: BrowserSyncPrepareInput, signal?: AbortSignal): Promise<BrowserSyncJob> {
    if (preparing) throw new Error("上一组内容仍在传入浏览器，请等待完成");
    preparing = true;
    let sent = false;
    let readbackAttempted = false;
    const matches = (job: BrowserSyncJob | null) => Boolean(job && job.id === input.id && job.title === input.content.title && job.imageCount === input.images.length);
    try {
      assertActive(signal);
      if (!ID.test(input.id) || !["xiaohongshu", "wechat"].includes(input.platform)) throw new Error("传图记录格式无效");
      const errors = validateDraft(input.platform, input.content, input.images.map(imageMetadata)).filter((issue) => issue.severity === "error");
      if (errors.length) throw new Error(errors.map((issue) => issue.message).join("\n"));
      if (input.images.some((image) => !image.name.trim() || image.name.length > 200)) throw new Error("图片名称为空或超过200个字符，请重新选择图片");
      await ping(signal);
      const images = [];
      for (const image of input.images) {
        assertActive(signal);
        const bytes = new Uint8Array(await image.blob.arrayBuffer());
        assertActive(signal);
        if (bytes.byteLength !== image.blob.size) throw new Error(`${image.name} 未完整读取，请重新准备图片`);
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
        images.push({ name: image.name, mime: image.blob.type, dataUrl: `data:${image.blob.type};base64,${window.btoa(chunks.join(""))}` });
      }
      assertActive(signal);
      const response = await request("prepare", { id: input.id, platform: input.platform, draft: { ...input.content, images } }, 180000, signal, () => { sent = true; });
      if (!matches(readJob(response.job))) throw new Error("传入回执与本次图片、标题或记录不一致");
      readbackAttempted = true;
      const stored = await getStatus(input.platform, signal);
      if (!matches(stored)) throw new Error("扩展读回的内容与本次传入不一致");
      return stored!;
    } catch (error) {
      if (sent) {
        // A lost acknowledgement is not a failed write. Read once before
        // reporting uncertainty, but never repeat prepare or ignore cancellation.
        if (!readbackAttempted && !signal?.aborted && !disposed) {
          try {
            const stored = await getStatus(input.platform, signal);
            if (matches(stored)) return stored!;
          } catch { /* The durable local record keeps the manual readback path. */ }
        }
        throw new BrowserSyncUnconfirmedError(messageOf(error));
      }
      throw error;
    } finally { preparing = false; }
  }

  return {
    ping, prepare, getStatus,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const item of pending.values()) item.settle(cancelled());
    },
  };
}
