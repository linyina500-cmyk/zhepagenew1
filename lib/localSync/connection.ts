import { createWechatClient } from "../wechat/client";
import type { Binding } from "../wechat/deviceVault";

const LOCAL_ORIGIN = "http://127.0.0.1:8789";
const notRunning = () => new Error("暂时连不上本机助手。请先打开折页同步助手；若 Chrome 提示访问本机，请允许后重试。");

// Pair only after the user's click. The challenge and returned credentials stay
// in request bodies; no popup, return URL, or additional persisted key is needed.
export function beginLocalSyncConnection(): { connect(signal: AbortSignal): Promise<Binding>; close(): void } {
  const controller = new AbortController();
  let started = false;
  return {
    async connect(signal) {
      if (started) throw new Error("连接正在处理中，请稍候。");
      started = true;
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(notRunning()), 9_000);
      let rejectAborted!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAborted, { once: true });
        if (controller.signal.aborted) rejectAborted();
      });
      const pair = async (): Promise<Binding> => {
        controller.signal.throwIfAborted();
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
        let response: Response;
        try {
          response = await fetch(`${LOCAL_ORIGIN}/pair`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }),
            credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal,
          });
        } catch {
          controller.signal.throwIfAborted();
          throw notRunning();
        }
        controller.signal.throwIfAborted();
        if (!response.ok) throw notRunning();
        const data: unknown = await response.json().catch(() => null);
        controller.signal.throwIfAborted();
        const message = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
        if (!message || message.nonce !== nonce
          || typeof message.deviceId !== "string" || !/^[a-f0-9]{32}$/.test(message.deviceId)
          || typeof message.connectionToken !== "string" || message.connectionToken.length < 32 || message.connectionToken.length > 256
          || /\s/.test(message.connectionToken) || [...message.connectionToken].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
          throw new Error("本机助手的连接信息不完整，请重新打开折页同步助手后再试。");
        }
        const binding = { deviceId: message.deviceId, connectionToken: message.connectionToken };
        let connection;
        try { connection = await createWechatClient(binding.connectionToken).getConnection(controller.signal); }
        catch {
          controller.signal.throwIfAborted();
          throw notRunning();
        }
        controller.signal.throwIfAborted();
        if (connection.deviceId !== binding.deviceId) throw new Error("连接的电脑与本机助手不一致，请重新打开折页同步助手后再试。");
        return binding;
      };
      try { return await Promise.race([pair(), aborted]); }
      finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", rejectAborted);
      }
    },
    close() { controller.abort(new DOMException("连接已取消", "AbortError")); },
  };
}
