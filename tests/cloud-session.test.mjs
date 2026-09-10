import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { ACCOUNT_TTL_SECONDS, SESSION_TTL_SECONDS, MAX_ACCOUNT_SEAL_BYTES, SESSION_COOKIE_NAME, createSessionSecurity } from "../cloud/session.mjs";

const firstKey = "test-only-first-encryption-key-never-use-in-production";
const secondKey = "test-only-second-encryption-key-never-use-in-production";
const accessPassword = "test-only-private-service-access-password";
const account = { id: "test-account", platform: "wechat", appId: "wx0123456789abcdef", appSecret: "test-only-platform-secret" };
const options = { passwords: { 1: firstKey }, accessPassword };
const cookieHeader = (cookie) => cookie.split(";")[0];
const cookieSeal = (cookie) => decodeURIComponent(cookieHeader(cookie).slice(SESSION_COOKIE_NAME.length + 1));
const tamperedCiphertext = (sealed) => {
  const parts = sealed.split("*");
  parts[4] = `${parts[4][0] === "A" ? "B" : "A"}${parts[4].slice(1)}`;
  return parts.join("*");
};

test("configuration rejects absent, empty, short and invalid keyrings without exposing secrets", () => {
  for (const changes of [undefined, {}, { ...options, passwords: {} }, { ...options, passwords: [] }, { ...options, passwords: { 1: "short" } }, { ...options, passwords: { invalid: firstKey } }, { ...options, passwords: { 0: firstKey } }, { ...options, accessPassword: "" }, { ...options, ownerId: "" }, { ...options, now: () => NaN }]) {
    assert.throws(() => createSessionSecurity(changes), (error) => !error.message.includes(firstKey) && !error.message.includes(accessPassword));
  }
});

test("login requires the exact access password and emits the configured secure cookie", async () => {
  const now = Date.now();
  const security = createSessionSecurity({ ...options, now: () => now });
  for (const password of [undefined, "", "wrong", `${accessPassword} `, 123]) await assert.rejects(security.login(password), (error) => error.statusCode === 401 && error.publicMessage === "同步服务访问口令不正确");
  const { cookie, session } = await security.login(accessPassword, { remember: true });
  assert.deepEqual(session, { ownerId: "owner", csrf: session.csrf, expiresAt: now + ACCOUNT_TTL_SECONDS * 1000 });
  assert.match(cookie, /^__Host-zhepage_sync=/);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", `Max-Age=${ACCOUNT_TTL_SECONDS}`]) assert.ok(cookie.includes(attribute));
  assert.equal(cookie.includes("Domain="), false);
  assert.ok(Buffer.byteLength(cookie) < 4096);
  assert.equal(cookie.includes(accessPassword), false);
  assert.deepEqual(await security.readSession(cookieHeader(cookie)), session);
  await assert.rejects(security.login(accessPassword, { remember: "yes" }), { statusCode: 400 });
});

test("unremembered sessions expire after eight hours despite having no persistent cookie expiry", async () => {
  let now = Date.now();
  const security = createSessionSecurity({ ...options, now: () => now });
  const { cookie, session } = await security.login(accessPassword, { remember: false });
  assert.equal(session.expiresAt, now + SESSION_TTL_SECONDS * 1000);
  assert.doesNotMatch(cookie, /Max-Age|Expires/i);
  now = session.expiresAt - 1;
  assert.deepEqual(await security.readSession(cookieHeader(cookie)), session);
  now++;
  assert.equal(await security.readSession(cookieHeader(cookie)), null);
  const remembered = await security.login(accessPassword, { remember: true });
  now = remembered.session.expiresAt;
  assert.equal(await security.readSession(cookieHeader(remembered.cookie)), null);
});

test("malformed, tampered, duplicate and wrong-owner sessions fail closed", async () => {
  const security = createSessionSecurity(options);
  const { cookie } = await security.login(accessPassword);
  const header = cookieHeader(cookie);
  const modified = `${SESSION_COOKIE_NAME}=${encodeURIComponent(tamperedCiphertext(cookieSeal(cookie)))}`;
  for (const value of [undefined, "", "another=cookie", `${SESSION_COOKIE_NAME}=%`, `${SESSION_COOKIE_NAME}=forged`, modified, `${header}x`, `${header}~2`, `${header}; ${header}`, "x".repeat(16385)]) assert.equal(await security.readSession(value), null);
  assert.equal(await createSessionSecurity({ ...options, ownerId: "other-owner" }).readSession(header), null);
});

test("account envelopes survive a new login by the same private owner and isolate purposes and owners", async () => {
  const security = createSessionSecurity(options);
  const first = await security.login(accessPassword);
  const sealed = await security.sealAccount(account, first.session);
  assert.equal(sealed.includes(account.appSecret), false);
  assert.equal(sealed.includes(account.appId), false);
  const second = await security.login(accessPassword);
  assert.notEqual(first.session.csrf, second.session.csrf);
  assert.equal(first.session.ownerId, second.session.ownerId);
  assert.deepEqual(await security.unsealAccount(sealed, second.session), account);
  assert.equal(await security.readSession(`${SESSION_COOKIE_NAME}=${encodeURIComponent(sealed)}`), null);
  for (const value of [cookieSeal(first.cookie), tamperedCiphertext(sealed), `${sealed}x`, `${sealed}~2`, `${sealed}\n`, "forged", "", null]) await assert.rejects(security.unsealAccount(value, second.session), (error) => error.statusCode === 401 && error.message === "账号授权无效或已过期，请重新连接账号");
  const other = createSessionSecurity({ ...options, ownerId: "other-owner" });
  const otherLogin = await other.login(accessPassword);
  await assert.rejects(other.unsealAccount(sealed, otherLogin.session), { statusCode: 401 });
});

test("key rotation reads retained old keys but new seals use only the newest version", async () => {
  const old = createSessionSecurity(options);
  const previous = await old.login(accessPassword, { remember: true });
  const sealed = await old.sealAccount(account, previous.session);
  const rotated = createSessionSecurity({ ...options, passwords: { 1: firstKey, 2: secondKey } });
  const next = await rotated.login(accessPassword);
  assert.deepEqual(await rotated.readSession(cookieHeader(previous.cookie)), previous.session);
  assert.deepEqual(await rotated.unsealAccount(sealed, next.session), account);
  const latestOnly = createSessionSecurity({ ...options, passwords: { 2: secondKey } });
  assert.deepEqual(await latestOnly.readSession(cookieHeader(next.cookie)), next.session);
  assert.equal(await latestOnly.readSession(cookieHeader(previous.cookie)), null);
  await assert.rejects(latestOnly.unsealAccount(sealed, next.session), { statusCode: 401 });
  const newestSeal = await rotated.sealAccount(account, next.session);
  assert.deepEqual(await latestOnly.unsealAccount(newestSeal, next.session), account);
  await assert.rejects(old.unsealAccount(newestSeal, previous.session), { statusCode: 401 });
});

test("account seals expire at thirty days and reject oversized or invalid content without leaking raw errors", async () => {
  let now = Date.now();
  const security = createSessionSecurity({ ...options, now: () => now });
  const first = await security.login(accessPassword);
  const sealed = await security.sealAccount(account, first.session);
  now += ACCOUNT_TTL_SECONDS * 1000 - 1;
  const renewed = await security.login(accessPassword);
  assert.deepEqual(await security.unsealAccount(sealed, renewed.session), account);
  now++;
  await assert.rejects(security.unsealAccount(sealed, renewed.session), { statusCode: 401 });
  await assert.rejects(security.unsealAccount("x".repeat(MAX_ACCOUNT_SEAL_BYTES + 1), renewed.session), { statusCode: 401 });
  await assert.rejects(security.sealAccount({ data: "x".repeat(MAX_ACCOUNT_SEAL_BYTES) }, renewed.session), { statusCode: 413 });
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [null, [], cyclic, { secret: 1n }]) await assert.rejects(security.sealAccount(value, renewed.session), (error) => error.statusCode === 401 && !error.message.includes("BigInt"));
  await assert.rejects(security.sealAccount(account, first.session), { statusCode: 401 });
});

test("the security module performs no network or filesystem writes and logout only clears its browser cookie", async (context) => {
  const write = context.mock.method(fsPromises, "writeFile", () => { throw new Error("unexpected write"); });
  const mkdir = context.mock.method(fsPromises, "mkdir", () => { throw new Error("unexpected mkdir"); });
  const syncWrite = context.mock.method(fs, "writeFileSync", () => { throw new Error("unexpected sync write"); });
  const request = context.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network"); });
  syncBuiltinESMExports();
  context.after(() => { write.mock.restore(); mkdir.mock.restore(); syncWrite.mock.restore(); syncBuiltinESMExports(); });
  const security = createSessionSecurity(options);
  const login = await security.login(accessPassword);
  const sealed = await security.sealAccount(account, login.session);
  assert.deepEqual(await security.unsealAccount(sealed, login.session), account);
  assert.equal(await security.readSession(cookieHeader(security.logoutCookie())), null);
  assert.match(security.logoutCookie(), /Max-Age=0/);
  for (const mocked of [write, mkdir, syncWrite, request]) assert.equal(mocked.mock.callCount(), 0);
});
