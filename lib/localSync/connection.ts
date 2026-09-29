import { createWechatClient } from "../wechat/client";
import type { Binding } from "../wechat/deviceVault";
import { assertLocalSyncBrowser, sendExtensionMessage } from "./transport";

export function beginLocalSyncConnection(): { connect(signal: AbortSignal): Promise<Binding>; close(): void } {
  const controller = new AbortController();
  let started = false;
  return {
    async connect(signal) {
      assertLocalSyncBrowser();
      const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(9_000)]);
      combined.throwIfAborted();
      if (started) throw new Error("连接正在处理中，请稍候。");
      started = true;
      const nonce = crypto.randomUUID();
      const data = await sendExtensionMessage({ type: "pair", nonce }, combined);
      combined.throwIfAborted();
      const message = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
      if (!message || message.nonce !== nonce
        || typeof message.deviceId !== "string" || !/^[a-f0-9]{32}$/.test(message.deviceId)
        || typeof message.connectionToken !== "string" || !/^[a-f0-9]{64}$/.test(message.connectionToken)) {
        throw new Error("插件连接信息不完整，请更新插件后重新检测。");
      }
      const binding = { deviceId: message.deviceId, connectionToken: message.connectionToken };
      const connection = await createWechatClient(binding.connectionToken).getConnection(combined);
      combined.throwIfAborted();
      if (connection.deviceId !== binding.deviceId) throw new Error("插件身份不一致，请重新检测插件。");
      return binding;
    },
    close() { controller.abort(new DOMException("连接已取消", "AbortError")); },
  };
}
