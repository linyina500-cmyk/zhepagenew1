import { createStore } from "./store.mjs";
import { allowedSender, validateRequest, decodeBody, safeError, ProtocolError } from "./protocol.mjs";
import { createWechatHandler } from "./wechat.mjs";
import { createXhsHandler } from "./xiaohongshu.mjs";

const store = createStore();
const ready = (async () => {
  let identity = await store.get("identity");
  if (!identity) {
    const random = (size) => [...crypto.getRandomValues(new Uint8Array(size))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    identity = { deviceId: random(16), connectionToken: random(32) };
    await store.set("identity", identity);
  }
  return { identity, wechat: createWechatHandler({ deviceId: identity.deviceId, store }), xhs: createXhsHandler({ store }) };
})();

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (!allowedSender(sender)) { respond({ status: 403, body: { error: "此网页无权连接折页插件。" } }); return false; }
  (async () => {
    validateRequest(message);
    const { identity, wechat, xhs } = await ready;
    if (message.type === "pair") return { ...identity, nonce: message.nonce };
    if (message.token !== identity.connectionToken) throw new ProtocolError("插件连接已变化，请重新检测。", 401);
    const request = { path: message.path, method: message.method, body: decodeBody(message.body) };
    if (request.path === "/api/wechat/connection" && request.method === "GET") {
      return { status: 200, body: { deviceId: identity.deviceId, busy: wechat.busy() || xhs.busy() } };
    }
    return await wechat(request) ?? await xhs(request) ?? { status: 404, body: { error: "没有此草稿操作。" } };
  })().then(respond, (error) => respond(safeError(error)));
  return true;
});
chrome.action.onClicked.addListener(() => { void chrome.tabs.create({ url: "https://feature-local-draft-sync.zhepagenew.pages.dev/" }); });
