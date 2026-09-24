// WeChat API calls run on the service. Credentials come from browser account
// settings; never reflect submitted secrets or access tokens in responses.
// API references:
// https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken
// https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial
// Draft cover schemas verified from the official pages:
// https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html
// https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_getdraft.html
// Publication schemas verified from the official pages:
// https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_submit.html
// https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_get.html
// Payload cross-checks:
// https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-post-to-wechat/scripts/wechat-api.ts
// https://github.com/binarywang/WxJava/tree/db880bb0da4c74d22ed568aacdf110c56fc836ca/weixin-java-mp/src/main/java/me/chanjar/weixin/mp/bean/draft

import { isIPv4 } from "node:net";

const API_ORIGIN = "https://api.weixin.qq.com";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_MARGIN_MS = 60_000;

export class WechatApiError extends Error {
  constructor(message, { outcome = "uncertain", errcode } = {}) {
    super(message);
    this.name = "WechatApiError";
    this.outcome = outcome;
    if (Number.isSafeInteger(errcode)) this.errcode = errcode;
  }
}

const errorMessages = new Map([
  [40001, "公众号调用凭据无效，请在本机浏览器的公众号设置中检查后重新连接"],
  [40007, "微信未接受图片素材编号，请检查素材后再试"],
  [40013, "公众号 AppID 无效，请在本机浏览器的公众号设置中更新"],
  [40125, "公众号 AppSecret 无效，请在本机浏览器的公众号设置中更新"],
  [40164, "请将同步服务器的出口 IP 加入公众号 IP 白名单"],
  [42001, "公众号调用凭据已过期，请重新发起检查"],
  [45009, "公众号接口今日调用额度已用完，请稍后再试"],
  [45011, "公众号接口调用过于频繁，请稍后再试"],
  [48001, "公众号尚未获得此接口权限"],
  [53503, "此草稿未通过微信发表检查，请到公众号后台检查内容"],
  [53504, "微信要求在公众号后台使用此草稿，请前往后台发表"],
  [53505, "微信要求先在公众号后台手动保存此草稿，再进行发表"],
  [89503, "此次接口调用需要公众号管理员确认"],
]);

function rejection(errcode, errmsg) {
  let message = errorMessages.get(errcode) ?? "微信接口拒绝了本次请求，请检查内容或账号设置";
  if (errcode === 40164 && typeof errmsg === "string") {
    // Extract only the IP immediately identified by WeChat's whitelist error.
    // Never copy arbitrary text, an address in a URL, or the full upstream error.
    const candidate = errmsg.slice(0, 4096).match(/\binvalid ip\s+((?:\d{1,3}\.){3}\d{1,3})(?=[\s,]|$)/iu)?.[1];
    if (candidate && isIPv4(candidate)) {
      message = `微信检测到本次接口调用的出口 IPv4 为 ${candidate}，请将其加入公众号 IP 白名单`;
    }
  }
  // Do not retain WeChat's raw errmsg: it can contain request URLs or credentials.
  return new WechatApiError(`${message}（错误码 ${errcode}）。`, { outcome: "rejected", errcode });
}

function unknownResult() {
  return new WechatApiError("微信接口结果未能确认，请先检查草稿箱；本次请求不会自动重试。");
}

function validMediaIds(imageMediaIds) {
  return Array.isArray(imageMediaIds) && imageMediaIds.length >= 1 && imageMediaIds.length <= 20
    && imageMediaIds.every((id) => typeof id === "string" && id.trim().length > 0);
}

const validIdentifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/\s/u.test(value);

// Keep only bounded crop diagnostics. These values do not establish whether
// WeChat displays a cover correctly, and must never carry thumbnail URLs.
export function normalizeDraftCoverInfo(value) {
  const crops = value?.crop_percent_list;
  if (!Array.isArray(crops) || crops.length > 8) return undefined;
  const normalized = [];
  for (const crop of crops) {
    if (typeof crop?.ratio !== "string" || !/^[a-z0-9_.:/-]{1,32}$/iu.test(crop.ratio)) return undefined;
    const { ratio } = crop;
    const [x1, y1, x2, y2] = [crop.x1, crop.y1, crop.x2, crop.y2].map((coordinate) => {
      if (typeof coordinate !== "string") return coordinate;
      return coordinate.length <= 32 && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(coordinate) ? Number(coordinate) : undefined;
    });
    if (![x1, y1, x2, y2].every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
      || x1 >= x2 || y1 >= y2) return undefined;
    normalized.push({ ratio, x1, y1, x2, y2 });
  }
  return { crop_percent_list: normalized };
}

async function publicationResult(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof WechatApiError && error.outcome === "rejected") throw error;
    throw new WechatApiError("微信发表结果尚未确认，请到公众号后台核对；本次请求不会自动重试。");
  }
}

function publicationStatus(data, publishId) {
  if (data.publish_id !== publishId || !Number.isInteger(data.publish_status)) throw unknownResult();
  const states = [
    ["published", "微信已确认发表成功。"],
    ["publishing", "微信正在处理发表任务，请稍后读取结果。"],
    ["failed", "微信原创检查未通过，请到公众号后台核对。"],
    ["failed", "微信发表失败，请到公众号后台核对。"],
    ["failed", "微信平台审核未通过，请到公众号后台核对。"],
    ["removed", "此内容发表后已被删除。"],
    ["blocked", "此内容发表后已被微信封禁。"],
  ];
  const state = states[data.publish_status];
  if (!state) throw unknownResult();
  const [status, message] = state;
  if (status !== "published") return { status, urls: [], message };
  const detail = data.article_detail;
  if (!validIdentifier(data.article_id) || !Number.isSafeInteger(detail?.count) || detail.count < 1
    || !Array.isArray(detail.item) || detail.item.length !== detail.count) throw unknownResult();
  const seen = new Set();
  const urls = detail.item.map((item) => {
    if (!Number.isSafeInteger(item?.idx) || item.idx < 1 || seen.has(item.idx) || typeof item.article_url !== "string") throw unknownResult();
    seen.add(item.idx);
    const url = new URL(item.article_url);
    if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password) throw unknownResult();
    return url.href;
  });
  return { status, articleId: data.article_id, urls, message };
}

export function createWechatApi({ appId, appSecret, fetchImpl = fetch }) {
  if (typeof appId !== "string" || !appId.trim() || typeof appSecret !== "string" || !appSecret.trim()) {
    throw new TypeError("请先在本机浏览器的公众号设置中填写 AppID 和 AppSecret。");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("公众号请求服务配置无效。");

  let cachedToken;
  let tokenExpiresAt = 0;
  let tokenRequest;

  async function request(path, { accessToken, json, form, method = "POST" } = {}) {
    const url = new URL(path, API_ORIGIN);
    if (accessToken) url.searchParams.set("access_token", accessToken);
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url.toString(), {
            method,
            redirect: "error",
            signal: controller.signal,
            ...(json !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) } : { body: form }),
          });
          if (!response.ok) throw unknownResult();
          const data = await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data)) throw unknownResult();
          if (Number.isSafeInteger(data.errcode) && data.errcode !== 0) throw rejection(data.errcode, data.errmsg);
          // An unrecognised errcode is not evidence that the operation succeeded.
          if (data.errcode !== undefined && data.errcode !== 0) throw unknownResult();
          return data;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(unknownResult());
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof WechatApiError) throw error;
      // Network errors can include the token-bearing URL. Never propagate them.
      throw unknownResult();
    } finally {
      clearTimeout(timer);
    }
  }

  async function accessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    if (!tokenRequest) {
      tokenRequest = (async () => {
        const startedAt = Date.now();
        const data = await request("/cgi-bin/stable_token", {
          json: { grant_type: "client_credential", appid: appId, secret: appSecret, force_refresh: false },
        });
        if (typeof data.access_token !== "string" || !data.access_token.trim()
          || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw unknownResult();
        cachedToken = data.access_token;
        tokenExpiresAt = startedAt + data.expires_in * 1_000 - TOKEN_MARGIN_MS;
        return cachedToken;
      })();
    }
    try {
      return await tokenRequest;
    } finally {
      tokenRequest = undefined;
    }
  }

  function mediaId(data) {
    if (typeof data.media_id !== "string" || !data.media_id.trim()) throw unknownResult();
    return data.media_id;
  }

  return {
    async checkConnection() {
      const token = await accessToken();
      const data = await request("/cgi-bin/draft/count", { accessToken: token, method: "GET" });
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) throw unknownResult();
    },

    async uploadImage({ blob, name }) {
      if (!(blob instanceof Blob) || !["image/png", "image/jpeg"].includes(blob.type) || blob.size === 0
        || typeof name !== "string" || !name.trim()) {
        throw new TypeError("上传图片必须是有效的 PNG 或 JPEG 文件。");
      }
      const form = new FormData();
      form.set("media", blob, name);
      const token = await accessToken();
      return mediaId(await request("/cgi-bin/material/add_material?type=image", { accessToken: token, form }));
    },

    async createDraft({ title, body, imageMediaIds }) {
      if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !validMediaIds(imageMediaIds)) {
        throw new TypeError("草稿标题、配文或图片素材编号无效。");
      }
      const token = await accessToken();
      const data = await request("/cgi-bin/draft/add", {
        accessToken: token,
        json: {
          articles: [{
            article_type: "newspic",
            title,
            content: body,
            // newspic takes its cover from the first permanent image. Do not
            // substitute a news thumbnail or invent a 4_5 cover_info ratio:
            // the API only documents square / landscape cover crop formats.
            image_info: { image_list: imageMediaIds.map((id) => ({ image_media_id: id })) },
            need_open_comment: 0,
            only_fans_can_comment: 0,
          }],
        },
      });
      return mediaId(data);
    },

    async verifyDraft({ draftId, title, body, imageMediaIds }) {
      if (typeof draftId !== "string" || !draftId.trim() || typeof title !== "string"
        || typeof body !== "string" || !validMediaIds(imageMediaIds)) {
        throw new TypeError("草稿核对信息无效。");
      }
      const token = await accessToken();
      const data = await request("/cgi-bin/draft/get", { accessToken: token, json: { media_id: draftId } });
      const articles = data.news_item;
      const article = Array.isArray(articles) && articles.length === 1 ? articles[0] : null;
      const images = article?.image_info?.image_list;
      const verified = article?.article_type === "newspic" && article.title === title && article.content === body
        && Array.isArray(images) && images.length === imageMediaIds.length
        && images.every((image, index) => image?.image_media_id === imageMediaIds[index]);
      const coverInfo = normalizeDraftCoverInfo(article?.cover_info);
      return {
        verified,
        message: verified ? "标题、配文和图片顺序已核对。" : "草稿内容尚未通过核对，请到公众号草稿箱检查。",
        ...(coverInfo ? { coverInfo } : {}),
      };
    },

    async submitPublication({ draftId }) {
      if (!validIdentifier(draftId)) throw new TypeError("发表草稿编号无效。");
      return publicationResult(async () => {
        const token = await accessToken();
        // The public API accepts media_id only; it has no scheduled-time field.
        const data = await request("/cgi-bin/freepublish/submit", { accessToken: token, json: { media_id: draftId } });
        if (!validIdentifier(data.publish_id)) throw unknownResult();
        return { publishId: data.publish_id };
      });
    },

    async getPublication({ publishId }) {
      if (!validIdentifier(publishId)) throw new TypeError("发表任务编号无效。");
      return publicationResult(async () => {
        const token = await accessToken();
        const data = await request("/cgi-bin/freepublish/get", { accessToken: token, json: { publish_id: publishId } });
        return publicationStatus(data, publishId);
      });
    },
  };
}
