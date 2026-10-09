// Stable unpacked-extension ID, derived from browser-extension/identity.json.
export const DRAFT_EXTENSION_ID = "embegpbimagclbddlgcnbafnficdpjmi";
export const EXTENSION_PROTOCOL = 1;

export class LocalSyncBrowserError extends Error {
  constructor() {
    super("请在 Windows 或 Mac 电脑的 Chrome 浏览器中加载折页插件。");
    this.name = "LocalSyncBrowserError";
  }
}
export function assertLocalSyncBrowser(): void {
  if (typeof navigator === "undefined") return;
  const agent = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android|Mobile|Firefox/i.test(agent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/AppleWebKit/i.test(agent) && !/Chrome|Chromium|Edg/i.test(agent))) throw new LocalSyncBrowserError();
}
type Runtime = {
  lastError?: { message?: string };
  sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void;
};
const unavailable = () => new Error("尚未检测到折页插件。请在 Chrome 扩展页加载并启用插件，再回到这里检测。");

export function sendExtensionMessage(message: Record<string, unknown>, signal?: AbortSignal | null): Promise<unknown> {
  assertLocalSyncBrowser();
  signal?.throwIfAborted();
  const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  if (!runtime?.sendMessage) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("已取消", "AbortError"));
    const timer = setTimeout(() => finish(new Error("插件暂未回应。请读取原任务状态并核对草稿箱，不要重复同步。")), 90_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      runtime.sendMessage(DRAFT_EXTENSION_ID, { ...message, protocol: EXTENSION_PROTOCOL }, (response) => {
        const failed = runtime.lastError;
        finish(failed ? unavailable() : null, response);
      });
    } catch { finish(unavailable()); }
  });
}

async function encodeBody(body: BodyInit | null | undefined) {
  if (body == null) return undefined;
  if (typeof body === "string") return { kind: "json", value: JSON.parse(body) as unknown };
  if (!(body instanceof FormData)) throw new Error("同步内容格式不正确。");
  let total = 0;
  const entries = [];
  for (const [key, value] of body.entries()) {
    if (typeof value === "string") { entries.push({ key, value }); continue; }
    total += value.size;
    if (total > 40 * 1024 * 1024) throw new Error("本次图片超过 40 MiB，请减少图片或压缩后再同步。");
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32_768) binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
    entries.push({ key, file: { name: value.name, type: value.type, data: btoa(binary) } });
  }
  return { kind: "form", entries };
}

// Browser messaging only: no localhost ports, helper program or cloud relay.
export const localSyncFetch: typeof fetch = (input, init) => {
  assertLocalSyncBrowser();
  if (typeof input !== "string" || !/^\/api\/(?:wechat|xiaohongshu)\/[a-zA-Z0-9/_%-]+$/.test(input)) {
    throw new Error("同步地址无效，请重新检测插件。");
  }
  return (async () => {
    init?.signal?.throwIfAborted();
    const body = await encodeBody(init?.body);
    const result = await sendExtensionMessage({
      type: "request", path: input, method: init?.method ?? "GET",
      token: new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "", body,
    }, init?.signal);
    if (!result || typeof result !== "object" || !("status" in result) || !("body" in result)
      || !Number.isInteger(result.status) || Number(result.status) < 200 || Number(result.status) > 599) {
      throw new Error("插件返回的信息不完整，请更新插件后重新检测。");
    }
    return new Response(JSON.stringify(result.body), { status: Number(result.status), headers: { "Content-Type": "application/json" } });
  })();
};
