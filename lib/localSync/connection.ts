import { createWechatClient } from "../wechat/client";
import type { Binding } from "../wechat/deviceVault";

const LOCAL_ORIGIN = "http://127.0.0.1:8789";
const notRunning = () => new Error("尚未连接到本机助手。请先打开“折页同步助手”，再点击连接这台电脑。");

// Open synchronously in the button's user gesture. Only the exact local popup
// may return credentials; neither credentials nor the challenge enter a URL.
export function beginLocalSyncConnection(): { connect(signal: AbortSignal): Promise<Binding>; close(): void } {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  let popup: Window | null = null;
  let started = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let resolvePair!: (binding: Binding) => void;
  let rejectPair!: (error: unknown) => void;
  const pairing = new Promise<Binding>((resolve, reject) => { resolvePair = resolve; rejectPair = reject; });
  // The popup may be blocked before the caller enters its async operation.
  void pairing.catch(() => {});
  function cleanup() {
    window.removeEventListener("message", receive);
    clearTimeout(timer); clearInterval(watch);
  }
  function fail(error: unknown) {
    if (settled) return;
    settled = true; cleanup(); rejectPair(error);
  }
  function receive(event: MessageEvent) {
    if (!popup || event.source !== popup || event.origin !== LOCAL_ORIGIN || settled) return;
    const data: unknown = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (message.type === "zhepage-local-ready") {
      popup.postMessage({ type: "zhepage-local-connect", nonce }, LOCAL_ORIGIN);
      return;
    }
    if (message.type !== "zhepage-local-connected" || message.nonce !== nonce) return;
    if (typeof message.deviceId !== "string" || !/^[a-f0-9]{32}$/.test(message.deviceId)
      || typeof message.connectionToken !== "string" || message.connectionToken.length < 32 || message.connectionToken.length > 256
      || /\s/.test(message.connectionToken) || [...message.connectionToken].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      fail(new Error("本机助手的连接信息不完整，请重新打开助手后再试。")); return;
    }
    settled = true; cleanup();
    resolvePair({ deviceId: message.deviceId, connectionToken: message.connectionToken });
  }
  window.addEventListener("message", receive);
  try { popup = window.open(`${LOCAL_ORIGIN}/connect`, "_blank", "popup,width=440,height=360"); }
  catch { /* Browsers may either return null or throw when blocking a popup. */ }
  if (!popup) fail(new Error("请允许此网站打开连接窗口，再点击连接这台电脑。"));
  else {
    timer = setTimeout(() => fail(notRunning()), 12_000);
    watch = setInterval(() => { if (popup?.closed) fail(new Error("连接窗口已关闭，请重新点击连接这台电脑。")); }, 300);
  }
  const close = () => {
    controller.abort(new DOMException("连接已取消", "AbortError"));
    fail(controller.signal.reason); cleanup(); popup?.close();
  };
  return {
    async connect(signal) {
      if (started) throw new Error("连接正在处理中，请稍候。");
      started = true;
      const abort = () => { controller.abort(signal.reason); fail(signal.reason); popup?.close(); };
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        controller.signal.throwIfAborted();
        const binding = await pairing;
        controller.signal.throwIfAborted();
        let connection;
        try { connection = await createWechatClient(binding.connectionToken).getConnection(controller.signal); }
        catch {
          controller.signal.throwIfAborted();
          throw new Error("已找到本机助手，但同步连接暂时不可用。请保持助手打开，稍后重试。");
        }
        controller.signal.throwIfAborted();
        if (connection.deviceId !== binding.deviceId) throw new Error("网页连接的电脑与本机助手不一致，请检查同步服务后重试。");
        return binding;
      } finally { signal.removeEventListener("abort", abort); }
    },
    close,
  };
}
