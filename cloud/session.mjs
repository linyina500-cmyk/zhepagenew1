import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sealData, unsealData } from "iron-session";

export const ACCOUNT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_ACCOUNT_SEAL_BYTES = 8 * 1024 * 1024;
export const SESSION_COOKIE_NAME = "__Host-zhepage_sync";
const COOKIE_ATTRIBUTES = "; Path=/; HttpOnly; Secure; SameSite=Strict";
const invalidAccount = () => publicError("账号授权无效或已过期，请重新连接账号", 401);
const invalidSession = () => publicError("同步服务登录已过期，请重新登录", 401);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => createHash("sha256").update(value).digest();
// iron-session ignores the outer marker; accept only complete seals we emit.
const isCurrentSeal = (value) => typeof value === "string" && value.endsWith("~2") && value.indexOf("~") === value.length - 2;
function publicError(message, statusCode) { return Object.assign(new Error(message), { publicMessage: message, statusCode }); }

/**
 * Stateless security for one privately operated service, not multi-user SaaS.
 * The caller must obtain session from login/readSession, never from request JSON.
 * Only the browser holds account seals; this module does not persist credentials.
 */
export function createSessionSecurity({ passwords, accessPassword, ownerId = "owner", now = Date.now } = {}) {
  const keys = record(passwords) ? Object.entries(passwords) : [];
  if (!keys.length || keys.some(([id, value]) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || typeof value !== "string" || Buffer.byteLength(value) < 32)) {
    throw new Error("请配置带正整数版本编号、至少 32 字节的同步加密密钥");
  }
  if (typeof accessPassword !== "string" || !accessPassword.trim() || accessPassword.length > 4096) throw new Error("请配置有效的同步服务访问口令");
  if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 128 || ownerId.trim() !== ownerId) throw new Error("同步服务拥有者标识无效");
  if (typeof now !== "function") throw new Error("同步服务时钟配置无效");
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("同步服务时钟配置无效");
    return value;
  };
  time();
  // Separate purposes cryptographically while rotating one versioned master keyring.
  const keyring = (purpose) => Object.fromEntries(keys.map(([id, key]) => [id, createHmac("sha256", key).update(`zhepage-sync:${purpose}:v1`).digest("base64url")]));
  const sessionKeys = keyring("session");
  const accountKeys = keyring("account");
  const expectedPassword = digest(accessPassword);
  const isSession = (session) => record(session) && session.ownerId === ownerId && typeof session.csrf === "string" && /^[A-Za-z0-9_-]{43}$/.test(session.csrf) && Number.isSafeInteger(session.expiresAt) && session.expiresAt > time();
  const validTimes = (value, maxSeconds) => Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt <= time() && value.expiresAt > time() && value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= maxSeconds * 1000;
  const requireSession = (session) => { if (!isSession(session)) throw invalidSession(); };

  return {
    async login(password, { remember = false } = {}) {
      // Hash first so the constant-time comparison also covers different lengths.
      const supplied = digest(typeof password === "string" ? password : "");
      if (!timingSafeEqual(supplied, expectedPassword)) throw publicError("同步服务访问口令不正确", 401);
      if (typeof remember !== "boolean") throw publicError("记住账号选项无效", 400);
      const ttl = remember ? ACCOUNT_TTL_SECONDS : SESSION_TTL_SECONDS;
      const issuedAt = time();
      const session = { ownerId, csrf: randomBytes(32).toString("base64url"), expiresAt: issuedAt + ttl * 1000 };
      const sealed = await sealData({ version: 1, purpose: "session", issuedAt, ...session }, { password: sessionKeys, ttl });
      const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sealed)}${COOKIE_ATTRIBUTES}${remember ? `; Max-Age=${ttl}` : ""}`;
      return { cookie, session };
    },

    async readSession(cookieHeader) {
      try {
        if (typeof cookieHeader !== "string" || cookieHeader.length > 16384) return null;
        const values = cookieHeader.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
        if (values.length !== 1) return null;
        const sealed = decodeURIComponent(values[0].slice(SESSION_COOKIE_NAME.length + 1));
        if (!isCurrentSeal(sealed) || sealed.length > 4096) return null;
        const value = await unsealData(sealed, { password: sessionKeys, ttl: ACCOUNT_TTL_SECONDS });
        if (!record(value) || value.version !== 1 || value.purpose !== "session" || !validTimes(value, ACCOUNT_TTL_SECONDS) || !isSession(value)) return null;
        return { ownerId: value.ownerId, csrf: value.csrf, expiresAt: value.expiresAt };
      } catch { return null; }
    },

    logoutCookie() { return `${SESSION_COOKIE_NAME}=${COOKIE_ATTRIBUTES}; Max-Age=0`; },

    async sealAccount(account, session) {
      requireSession(session);
      try {
        if (!record(account)) throw invalidAccount();
        const serialized = JSON.stringify(account);
        if (Buffer.byteLength(serialized) > MAX_ACCOUNT_SEAL_BYTES) throw publicError("账号授权资料超过 8 MiB，无法保存", 413);
        const issuedAt = time();
        const sealed = await sealData({ version: 1, purpose: "account", ownerId, issuedAt, expiresAt: issuedAt + ACCOUNT_TTL_SECONDS * 1000, account }, { password: accountKeys, ttl: ACCOUNT_TTL_SECONDS });
        if (sealed.length > MAX_ACCOUNT_SEAL_BYTES) throw publicError("账号授权资料超过 8 MiB，无法保存", 413);
        return sealed;
      } catch (error) {
        if (error?.statusCode === 413) throw publicError("账号授权资料超过 8 MiB，无法保存", 413);
        throw invalidAccount();
      }
    },

    async unsealAccount(sealed, session) {
      try {
        requireSession(session);
        if (!isCurrentSeal(sealed) || sealed.length > MAX_ACCOUNT_SEAL_BYTES) throw invalidAccount();
        const value = await unsealData(sealed, { password: accountKeys, ttl: ACCOUNT_TTL_SECONDS });
        if (!record(value) || value.version !== 1 || value.purpose !== "account" || value.ownerId !== ownerId || !validTimes(value, ACCOUNT_TTL_SECONDS) || !record(value.account)) throw invalidAccount();
        return value.account;
      } catch { throw invalidAccount(); }
    },
  };
}
