import { Buffer } from "node:buffer";
import { countCharacters, countHashtags, DRAFT_LIMITS } from "../../lib/draftSync/validation.ts";

const API_ORIGIN = "https://api.weixin.qq.com";
const DRAFTS_URL = "https://mp.weixin.qq.com/";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

class WechatProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "WechatProviderError";
    this.publicMessage = message;
  }
}

class WechatApiError extends WechatProviderError {
  constructor(code) {
    const descriptions = {
      40001: "公众号凭证无效，请重新连接账号。",
      40013: "公众号 AppID 不正确。",
      40125: "公众号 AppSecret 不正确。",
      40164: "请在公众号后台把同步服务的固定出口 IP 加入接口 IP 白名单。",
      61004: "同步服务的出口 IP 尚未加入公众号接口 IP 白名单。",
      42001: "公众号凭证已过期，请重新连接账号。",
      45009: "公众号接口调用次数已达上限，请稍后再试。",
      48001: "当前公众号没有此接口权限，请检查账号的接口权限。",
      89503: "此次连接需要公众号管理员确认，请在公众号后台处理。",
    };
    super(descriptions[code] ?? `微信接口拒绝了请求（错误码 ${code}）。`);
    this.name = "WechatApiError";
    this.code = code;
  }
}

function credentials(account) {
  const appId = typeof account?.appId === "string" ? account.appId.trim() : "";
  const appSecret = typeof account?.appSecret === "string" ? account.appSecret.trim() : "";
  if (!/^wx[a-zA-Z0-9]{16}$/.test(appId) || !appSecret || appSecret.length > 256 || /\s/.test(appSecret)) {
    throw new WechatProviderError("请填写有效的公众号 AppID 和 AppSecret。");
  }
  if (account.remoteId !== undefined && account.remoteId !== appId) {
    throw new WechatProviderError("所选公众号与已验证的 AppID 不一致，请重新连接账号。");
  }
  return { appId, appSecret };
}

function snapshotDraft(draft) {
  if (typeof draft?.title !== "string" || typeof draft?.body !== "string") {
    throw new WechatProviderError("公众号草稿需要标题和正文。");
  }
  const title = draft.title.trim();
  const body = draft.body.replace(/\r\n?/g, "\n");
  const limit = DRAFT_LIMITS.wechat;
  if (!title || countCharacters(draft.title) > limit.title) throw new WechatProviderError(`公众号草稿标题须为 1–${limit.title} 个字符。`);
  // The official content field has conflicting byte/character descriptions.
  // These conservative product limits are shared with the editor validation.
  if (countCharacters(body) > limit.body || Buffer.byteLength(body, "utf8") > 2048) {
    throw new WechatProviderError("本工具的公众号正文上限为 1,000 字且不超过 2,048 UTF-8 字节。");
  }
  if (countHashtags(body) > limit.topics) throw new WechatProviderError(`公众号文案最多 ${limit.topics} 个话题，请减少 #话题 后同步。`);
  if (!Array.isArray(draft.images) || draft.images.length < 1 || draft.images.length > 20) {
    throw new WechatProviderError("公众号图片草稿需要 1–20 张图片。");
  }
  let totalBytes = 0;
  for (const image of draft.images) {
    if (!Buffer.isBuffer(image?.bytes) || !image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES) {
      throw new WechatProviderError("每张公众号图片须为非空文件，且不超过 10 MB。");
    }
    const bytes = image.bytes;
    const png = image.mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = image.mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new WechatProviderError("公众号同步仅支持与文件内容一致的 PNG 或 JPEG 图片。");
    totalBytes += bytes.length;
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new WechatProviderError("本次公众号图片总大小超过 60 MiB。");
  return { title, body, images: draft.images.map(({ mime, bytes }) => ({ mime, bytes: Buffer.from(bytes) })) };
}

async function requestJson(fetchImpl, path, { token, method = "POST", body, image } = {}) {
  // Every endpoint is a module constant; redirects may not forward credentials.
  const url = new URL(path, API_ORIGIN);
  if (token) url.searchParams.set("access_token", token);
  let requestBody;
  const headers = { Accept: "application/json" };
  if (image) {
    url.searchParams.set("type", "image");
    requestBody = new FormData();
    requestBody.append("media", new Blob([image.bytes], { type: image.mime }), image.mime === "image/png" ? "image.png" : "image.jpg");
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  let data;
  try {
    const response = await fetchImpl(url.href, {
      method, headers, body: requestBody, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("HTTP response failed");
    data = await response.json();
  } catch {
    // Fetch errors can include a URL containing access_token. Never expose them.
    throw new WechatProviderError("未能取得微信接口的完整响应，请检查网络后重试。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new WechatProviderError("微信接口返回了无法识别的响应。");
  }
  if (data.errcode !== undefined && data.errcode !== 0) {
    if (!Number.isSafeInteger(data.errcode) || data.errcode <= 0) {
      throw new WechatProviderError("微信接口返回了无法识别的错误。");
    }
    throw new WechatApiError(data.errcode);
  }
  return data;
}

async function getToken(fetchImpl, account) {
  const result = await requestJson(fetchImpl, "/cgi-bin/stable_token", {
    body: { grant_type: "client_credential", appid: account.appId, secret: account.appSecret, force_refresh: false },
  });
  if (typeof result.access_token !== "string" || !result.access_token || result.access_token.length > 4096) {
    throw new WechatProviderError("微信接口未返回有效凭证，请重新连接账号。");
  }
  return result.access_token;
}

export async function verifyWechatAccount({ appId, appSecret, fetchImpl = fetch }) {
  const account = credentials({ appId, appSecret });
  const token = await getToken(fetchImpl, account);
  const result = await requestJson(fetchImpl, "/cgi-bin/draft/count", { token, method: "GET" });
  if (!Number.isSafeInteger(result.total_count) || result.total_count < 0) {
    throw new WechatProviderError("尚未确认公众号的草稿接口权限，请检查账号配置。");
  }
  // The direct official API does not supply an authenticated account nickname.
  // The app may show a user-entered label alongside this verified AppID.
  return { remoteId: account.appId, displayName: account.appId };
}

function needsConfirmation(message, draftId) {
  return { status: "needs_confirmation", ...(draftId ? { draftId } : {}), message, url: DRAFTS_URL };
}

function failed(error, uploadStarted = false) {
  const explanation = error instanceof WechatProviderError ? error.publicMessage : "公众号草稿准备失败，请检查账号和图片后重试。";
  return {
    status: "failed",
    message: `${explanation} 未创建公众号草稿。${uploadStarted ? "已上传的图片可能仍保留在公众号素材库。" : ""}`,
  };
}

export async function saveWechatDraft({ account, draft, fetchImpl = fetch }) {
  let snapshot;
  let token;
  let uploadStarted = false;
  const mediaIds = [];
  try {
    const identity = credentials(account);
    snapshot = snapshotDraft(draft);
    token = await getToken(fetchImpl, identity);
    for (const image of snapshot.images) {
      uploadStarted = true;
      const result = await requestJson(fetchImpl, "/cgi-bin/material/add_material", { token, image });
      if (typeof result.media_id !== "string" || !result.media_id || result.media_id.length > 512) {
        throw new WechatProviderError("图片上传未取得有效素材编号。");
      }
      mediaIds.push(result.media_id);
    }
  } catch (error) {
    return failed(error, uploadStarted);
  }
  const article = {
    article_type: "newspic",
    title: snapshot.title,
    content: snapshot.body,
    need_open_comment: 0,
    only_fans_can_comment: 0,
    image_info: { image_list: mediaIds.map((image_media_id) => ({ image_media_id })) },
  };
  let created;
  try {
    // draft/add is not idempotent. Never retry an ambiguous response.
    created = await requestJson(fetchImpl, "/cgi-bin/draft/add", { token, body: { articles: [article] } });
  } catch (error) {
    if (error instanceof WechatApiError) return failed(error, uploadStarted);
    return needsConfirmation("草稿提交结果待确认。请先到所选公众号草稿箱检查，避免重复提交。");
  }
  const draftId = created.media_id;
  if (typeof draftId !== "string" || !draftId || draftId.length > 512) {
    return needsConfirmation("微信未返回有效草稿编号。请先到所选公众号草稿箱检查，避免重复提交。");
  }
  let saved;
  try {
    saved = await requestJson(fetchImpl, "/cgi-bin/draft/get", { token, body: { media_id: draftId } });
  } catch {
    return needsConfirmation("已取得草稿编号，但未能读回核对。请到所选公众号草稿箱检查。", draftId);
  }
  const entry = Array.isArray(saved.news_item) && saved.news_item.length === 1 ? saved.news_item[0] : undefined;
  const savedImages = entry?.image_info?.image_list;
  const matching = entry?.article_type === "newspic" && entry.title === snapshot.title && entry.content === snapshot.body &&
    Array.isArray(savedImages) && savedImages.length === mediaIds.length &&
    savedImages.every((image, index) => image?.image_media_id === mediaIds[index]);
  if (!matching) {
    return needsConfirmation("草稿已创建，但读回的标题、正文或图片顺序与提交内容不一致，请在公众号草稿箱核对。", draftId);
  }
  return { status: "saved", draftId, message: "已保存到公众号草稿箱，并核对了标题、正文和图片顺序。", url: DRAFTS_URL };
}
