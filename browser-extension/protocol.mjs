export const ALLOWED_ORIGINS = new Set(["https://feature-local-draft-sync.zhepagenew.pages.dev"]);
export const PROTOCOL = 1;
export class ProtocolError extends Error {
  constructor(message, status = 400) { super(message); this.name = "ProtocolError"; this.status = status; }
}
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
export function allowedSender(sender) {
  if (sender.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
  try { return ALLOWED_ORIGINS.has(new URL(sender.url).origin) && sender.origin === new URL(sender.url).origin; }
  catch { return false; }
}
export function decodeBody(body) {
  if (body === undefined) return undefined;
  if (!record(body)) throw new ProtocolError("同步数据格式不正确。");
  if (body.kind === "json") {
    if (!record(body.value) || JSON.stringify(body.value).length > 16_384) throw new ProtocolError("同步信息超过大小限制。");
    return body.value;
  }
  if (body.kind !== "form" || !Array.isArray(body.entries) || body.entries.length > 24) throw new ProtocolError("图片数据不完整。");
  const form = new FormData();
  let total = 0;
  for (const entry of body.entries) {
    if (!record(entry) || !["id", "expectedAccountId", "title", "body", "images"].includes(entry.key)) throw new ProtocolError("同步数据字段不正确。");
    if (typeof entry.value === "string" && !entry.file && entry.key !== "images") {
      if (entry.value.length > 30_000) throw new ProtocolError("配文超过大小限制。");
      form.append(entry.key, entry.value); continue;
    }
    const file = entry.file;
    if (entry.key !== "images" || !record(file) || !["image/png", "image/jpeg"].includes(file.type)
      || typeof file.name !== "string" || file.name.length > 255 || typeof file.data !== "string") throw new ProtocolError("请使用 PNG 或 JPG 图片。");
    total += file.data.length;
    if (total > Math.ceil(40 * 1024 * 1024 / 3) * 4 + 80 || (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))) throw new ProtocolError("图片超过大小限制或数据不完整。");
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
    form.append(entry.key, new Blob([bytes], { type: file.type }), file.name);
  }
  return form;
}
export function validateRequest(message) {
  if (!record(message) || message.protocol !== PROTOCOL) throw new ProtocolError("请更新折页插件后重新检测。", 409);
  if (message.type === "pair" && typeof message.nonce === "string" && /^[a-f0-9-]{36}$/i.test(message.nonce)) return;
  if (message.type !== "request" || typeof message.path !== "string" || !/^\/api\/(?:wechat|xiaohongshu)\/[a-zA-Z0-9/_-]+$/.test(message.path)
    || !["GET", "POST"].includes(message.method) || typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token)
    || message.path.includes("publication") || (message.method === "GET" && message.body !== undefined)) throw new ProtocolError("没有此草稿操作。", 404);
}
export function safeError(error) {
  const safe = ["ProtocolError", "RequestError", "WechatApiError", "XhsError", "XhsRequestError"].includes(error?.name);
  return { status: safe && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400,
    body: { error: safe && typeof error.message === "string" ? error.message.slice(0, 600) : "本次操作未能完成，请读取原任务状态并核对草稿箱，勿重复同步。" } };
}
