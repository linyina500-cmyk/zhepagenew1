// Server only: credentials and access tokens must never be sent to the browser.
// API references (documentation was unavailable during implementation):
// https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken
// https://developers.weixin.qq.com/doc/service/api/material/permanent/api_addmaterial
// https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add
// Payload cross-checks:
// https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-post-to-wechat/scripts/wechat-api.ts
// https://github.com/binarywang/WxJava/tree/db880bb0da4c74d22ed568aacdf110c56fc836ca/weixin-java-mp/src/main/java/me/chanjar/weixin/mp/bean/draft

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
  [40001, "公众号调用凭据无效，请检查服务配置后再试"],
  [40007, "微信未接受图片素材编号，请检查素材后再试"],
  [40013, "公众号 AppID 无效，请检查服务配置"],
  [40125, "公众号 AppSecret 无效，请检查私密配置"],
  [40164, "请将同步服务器的出口 IP 加入公众号 IP 白名单"],
  [42001, "公众号调用凭据已过期，请重新发起检查"],
  [45009, "公众号接口今日调用额度已用完，请稍后再试"],
  [45011, "公众号接口调用过于频繁，请稍后再试"],
  [48001, "公众号尚未获得此接口权限"],
  [89503, "此次接口调用需要公众号管理员确认"],
]);

function rejection(errcode) {
  const message = errorMessages.get(errcode) ?? "微信接口拒绝了本次请求，请检查内容或账号设置";
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

export function createWechatApi({ appId, appSecret, fetchImpl = fetch }) {
  if (typeof appId !== "string" || !appId.trim() || typeof appSecret !== "string" || !appSecret.trim()) {
    throw new TypeError("请先在服务器私密配置中设置公众号 AppID 和 AppSecret。");
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
          if (Number.isSafeInteger(data.errcode) && data.errcode !== 0) throw rejection(data.errcode);
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
      return verified
        ? { verified: true, message: "标题、配文和图片顺序已核对。" }
        : { verified: false, message: "草稿内容尚未通过核对，请到公众号草稿箱检查。" };
    },
  };
}
