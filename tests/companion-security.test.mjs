import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { crc32 } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createCompanion } from "../companion/server.mjs";
import { authorizeRequest, DEFAULT_ORIGINS, requireLocalOrigin } from "../companion/security.mjs";
import { decodeImages } from "../companion/imageInput.mjs";
import { loginXiaohongshu } from "../companion/providers/xiaohongshu.mjs";

const token = "test-only-pairing-token-never-a-real-secret";
const origin = "http://localhost:5173";
const appId = "wx1234567890abcdef";
const appSecret = "test-secret-must-never-be-written-or-reflected";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const jpeg = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgAkgf/9k=", "base64");
const image = { name: "poster.png", mime: "image/png", base64: png.toString("base64"), width: 1, height: 1 };
const content = { title: "本机测试草稿", body: "测试文案不会发往真实平台" };

test("helper rejects untrusted Origin, Host, unauthenticated calls and non-JSON mutations", () => {
  const config = { port: 47831, token, allowedOrigins: DEFAULT_ORIGINS };
  const headers = { host: "127.0.0.1:47831", origin, authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal(authorizeRequest({ method: "POST", headers }, config), null);
  for (const hostileOrigin of [undefined, "null", "https://evil.example", "http://localhost:5173.evil.example", "https://zhepagenew.pages.dev"]) {
    assert.equal(authorizeRequest({ method: "GET", headers: { ...headers, origin: hostileOrigin } }, config).status, 403);
  }
  for (const host of ["evil.example:47831", "localhost:47831", "127.0.0.1:1234"]) assert.equal(authorizeRequest({ method: "GET", headers: { ...headers, host } }, config).status, 403);
  for (const authorization of [undefined, "Bearer wrong", `bearer ${token}`]) assert.equal(authorizeRequest({ method: "GET", headers: { ...headers, authorization } }, config).status, 401);
  assert.equal(authorizeRequest({ method: "POST", headers: { ...headers, "content-type": "text/plain" } }, config).status, 415);
  assert.equal(authorizeRequest({ method: "OPTIONS", headers: { ...headers, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } }, config), null);
  assert.equal(authorizeRequest({ method: "OPTIONS", headers: { ...headers, "access-control-request-method": "DELETE" } }, config).status, 403);
  assert.equal(authorizeRequest({ method: "OPTIONS", headers: { ...headers, "access-control-request-method": "POST", "access-control-request-headers": "x-arbitrary-header" } }, config).status, 403);
  for (const invalid of ["https://zhepagenew.pages.dev", "http://127.0.0.1:5173/", "http://user@localhost:5173", "http://192.168.1.10:5173"]) assert.throws(() => requireLocalOrigin(invalid));
});

test("image boundary uses the file bytes and rejects remote URLs, MIME mismatches and oversized metadata", () => {
  assert.equal(decodeImages([image])[0].bytes.equals(png), true);
  for (const change of [{ base64: "https://evil.example/image.png" }, { mime: "image/jpeg" }, { width: 1080 }, { height: 0 }, { base64: "abcd====" }, { base64: "" }]) assert.throws(() => decodeImages([{ ...image, ...change }]));
  assert.throws(() => decodeImages(Array.from({ length: 21 }, () => image)));
  assert.equal(decodeImages([{ ...image, name: "../../private/image.png" }])[0].name.includes("/"), false);
  // A complete PNG with a large ancillary chunk exercises multi-megabyte
  // base64 validation without relying on a repeated regex or corrupt padding.
  const chunk = Buffer.alloc(5_000_012, "x");
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("tEXtnote\0", 4, "latin1");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  assert.equal(decodeImages([{ ...image, base64: large.toString("base64") }])[0].bytes.length, large.length);
  assert.equal(decodeImages([{ ...image, mime: "image/jpeg", base64: jpeg.toString("base64") }])[0].bytes.equals(jpeg), true);
});

async function fixture(context, changes = {}, existingDirectory, options = {}) {
  const dataDir = existingDirectory || await mkdtemp(path.join(os.tmpdir(), "zhepage-helper-test-"));
  const calls = [];
  const profiles = [];
  const closedProfiles = [];
  const providers = {
    verifyWechatAccount: async ({ appId: id }) => ({ remoteId: id, displayName: id }),
    saveWechatDraft: async (args) => { calls.push(args); return { status: "saved", draftId: "mock-draft", message: "mock confirmed" }; },
    loginXiaohongshu: async () => ({ remoteId: "creator-123", displayName: "mock creator" }),
    saveXiaohongshuDraft: async () => ({ status: "needs_confirmation", message: "mock pending" }),
    ...changes,
  };
  const companion = await createCompanion({ dataDir, port: 0, token, providers, browserFactory: async (profile) => {
    profiles.push(profile);
    await writeFile(path.join(profile, "mock-cookie"), "test-only-local-cookie", { mode: 0o600 });
    let onClose;
    const browser = { on(_event, listener) { onClose = listener; }, async close() { closedProfiles.push(profile); onClose?.(); } };
    return options.createBrowser ? options.createBrowser({ profile, browser }) : browser;
  } });
  const port = await companion.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await companion.close(); } };
  context.after(async () => { await close(); if (!existingDirectory) await rm(dataDir, { recursive: true, force: true }); });
  async function request(endpoint, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  function rawRequest(endpoint, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request(`http://127.0.0.1:${port}/api${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      outgoing.on("error", reject);
      if (Array.isArray(body)) { for (const chunk of body) outgoing.write(chunk); outgoing.end(); }
      else outgoing.end(body);
    });
  }
  const add = async () => (await request("/accounts/wechat", { appId, appSecret, displayName: "我的公众号" })).data.account;
  const job = (accountId, requestId = randomUUID()) => ({ accountId, requestId, content, images: [image] });
  async function waitJob(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/jobs/${id}`);
      if (result.data.state === "finished") return result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Mock job did not finish");
  }
  return { companion, port, request, rawRequest, add, job, waitJob, calls, profiles, closedProfiles, dataDir, close };
}

test("only account metadata is persisted, secrets and payloads stay out of responses and disk", async (context) => {
  const fixtureData = await fixture(context);
  const { request, add, job, waitJob, calls, dataDir } = fixtureData;
  const account = await add();
  assert.equal(account.remoteId, appId);
  assert.equal(account.ready, true);
  assert.equal(JSON.stringify(account).includes(appSecret), false);
  const input = job(account.id);
  assert.equal((await request("/jobs", input)).status, 200);
  const result = await waitJob(input.requestId);
  assert.equal(result.data.receipt.status, "saved");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].draft.images[0].bytes.equals(png), true);
  const files = await readdir(dataDir);
  assert.deepEqual(files, ["accounts.json"]);
  const saved = await readFile(path.join(dataDir, "accounts.json"), "utf8");
  for (const privateValue of [appSecret, content.title, content.body, image.base64, token]) assert.equal(saved.includes(privateValue), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dataDir, "accounts.json"))).mode & 0o777, 0o600);
  }
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("access-control-allow-origin"), origin);
});

test("same job is idempotent, changed payload cannot reuse an id, and invalid jobs never reach providers", async (context) => {
  const { request, add, job, waitJob, calls } = await fixture(context);
  const account = await add();
  const input = job(account.id);
  await request("/jobs", input);
  await waitJob(input.requestId);
  assert.equal((await request("/jobs", input)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal((await request("/jobs", { ...input, content: { title: "changed", body: "" } })).status, 409);
  for (const change of [{ accountId: randomUUID() }, { requestId: "../../etc" }, { content: { title: "x".repeat(33), body: "" } }, { images: [{ ...image, width: 900 }] }]) assert.notEqual((await request("/jobs", { ...job(account.id), ...change })).status, 200);
  assert.equal(calls.length, 1);
});

test("ambiguous and interrupted writes remain blocked after restart until explicit review", async (context) => {
  const first = await fixture(context, { saveWechatDraft: async () => ({ status: "needs_confirmation", message: "mock lost response" }) });
  const account = await first.add();
  const input = first.job(account.id);
  await first.request("/jobs", input);
  assert.equal((await first.waitJob(input.requestId)).data.receipt.status, "needs_confirmation");
  assert.equal((await first.request("/jobs", first.job(account.id))).status, 409);
  await first.close();
  const second = await fixture(context, {}, first.dataDir);
  const restored = (await second.request("/accounts")).data.accounts[0];
  assert.equal(restored.ready, false);
  assert.equal(restored.syncBlocked, true);
  assert.equal((await second.add()).id, account.id);
  assert.equal((await second.request("/jobs", second.job(account.id))).status, 409);
  assert.equal((await second.request("/jobs/acknowledge", { accountId: account.id })).status, 400);
  assert.equal((await second.request("/accounts/remove", { accountId: account.id })).status, 409);
  assert.equal((await second.request("/jobs/acknowledge", { accountId: account.id, confirmedNotSaved: true })).status, 400);
  assert.equal((await second.request("/jobs/acknowledge", { accountId: account.id, outcome: "not_saved" })).status, 200);
  const nextJob = second.job(account.id);
  assert.equal((await second.request("/jobs", nextJob)).status, 200);
  await second.waitJob(nextJob.requestId);
});

test("in-flight writes cannot be duplicated, unlocked or have their account removed", async (context) => {
  let finish;
  const { request, add, job, waitJob } = await fixture(context, { saveWechatDraft: () => new Promise((resolve) => { finish = resolve; }) });
  const account = await add();
  const input = job(account.id);
  await request("/jobs", input);
  assert.equal((await request("/jobs", job(account.id))).status, 409);
  assert.equal((await request("/accounts/remove", { accountId: account.id })).status, 409);
  assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "saved" })).status, 409);
  finish({ status: "saved", draftId: "mock-draft", message: "mock confirmed" });
  assert.equal((await waitJob(input.requestId)).data.receipt.status, "saved");
});

test("credential-bearing provider exceptions never leak through the local API", async (context) => {
  const { request, job } = await fixture(context, { verifyWechatAccount: async () => { throw new Error(`https://api.weixin.qq.com/?secret=${appSecret}`); } });
  const result = await request("/accounts/wechat", { appId, appSecret, displayName: "mock" });
  assert.equal(result.status, 400);
  assert.equal(JSON.stringify(result.data).includes(appSecret), false);
  const unauthenticated = await request("/jobs", job(randomUUID()), { Authorization: "Bearer wrong" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("access-control-allow-origin"), null);
});

test("HTTP errors expose only explicit public messages and constrain provider status codes", async (context) => {
  let failure;
  const { request } = await fixture(context, { verifyWechatAccount: async () => { throw failure; } });
  for (const statusCode of [403, 503, 200, 600, 99, "401", NaN, Infinity]) {
    failure = Object.assign(new Error(`https://api.weixin.qq.com/?secret=${appSecret}&access_token=${token}`), { statusCode });
    const response = await request("/accounts/wechat", { appId, appSecret, displayName: "mock" });
    assert.equal(response.status, Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 400);
    assert.equal(typeof response.data.error, "string");
    for (const secret of [appSecret, token, "api.weixin.qq.com"]) assert.equal(JSON.stringify(response.data).includes(secret), false);
  }
  failure = Object.assign(new Error(appSecret), { statusCode: 403, publicMessage: "本机测试：缺少接口权限" });
  assert.deepEqual((await request("/accounts/wechat", { appId, appSecret, displayName: "mock" })).data, { error: failure.publicMessage });
  failure = null;
  assert.equal((await request("/accounts/wechat", { appId, appSecret, displayName: "mock" })).status, 400);
  const invalid = await request("/accounts/wechat", { appId: "invalid", appSecret, displayName: "mock" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, "AppID 格式不正确");
});

test("real HTTP boundary rejects hostile callers, query parameters and malformed or oversized bodies", async (context) => {
  const { request, rawRequest, port } = await fixture(context);
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Content-Type": "text/plain" }]) {
    const response = await request("/accounts/wechat", { appId, appSecret, displayName: "mock" }, headers);
    assert.equal(response.status, headers["Content-Type"] ? 415 : 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await rawRequest("/accounts", undefined, { Host: "localhost:" + port })).status, 403);
  assert.equal((await request("/accounts?untrusted=1")).status, 400);
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const malformed = await fetch(`http://127.0.0.1:${port}/api/accounts/wechat`, { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "请求内容不是有效 JSON" });
  const oversized = await fetch(`http://127.0.0.1:${port}/api/accounts/wechat`, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(8192) }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "请求素材过大" });
  assert.deepEqual(await rawRequest("/accounts/wechat", ["{", "x".repeat(8192), "}"]), { status: 413, data: { error: "请求素材过大" } });
  for (const body of [null, [], "text", 12]) assert.equal((await request("/accounts/wechat", body)).status, 400);
  const preflight = await fetch(`http://127.0.0.1:${port}/api/accounts`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
});

test("a saved result requires a valid draft identifier and both reviewed outcomes unlock pending accounts", async (context) => {
  let draftId;
  const { request, add, job, waitJob } = await fixture(context, { saveWechatDraft: async () => ({ status: "saved", draftId, message: "mock claims saved" }) });
  const account = await add();
  assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "saved" })).status, 409);
  for (const [index, invalid] of [undefined, "", " ", 123, "bad\nidentifier", "x".repeat(513)].entries()) {
    draftId = invalid;
    const input = job(account.id);
    assert.equal((await request("/jobs", input)).status, 200);
    const receipt = (await waitJob(input.requestId)).data.receipt;
    assert.equal(receipt.status, "needs_confirmation");
    assert.equal("draftId" in receipt, false);
    assert.equal((await request("/accounts")).data.accounts[0].syncBlocked, true);
    assert.equal((await request("/accounts/remove", { accountId: account.id })).status, 409);
    assert.equal((await request("/jobs", job(account.id))).status, 409);
    assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "unknown" })).status, 400);
    assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: index % 2 ? "saved" : "not_saved" })).status, 200);
    assert.equal((await request("/accounts")).data.accounts[0].syncBlocked, false);
    assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "saved" })).status, 409);
  }
  draftId = "valid-draft_123";
  const input = job(account.id);
  await request("/jobs", input);
  assert.equal((await waitJob(input.requestId)).data.receipt.status, "saved");
  assert.equal((await request("/accounts")).data.accounts[0].syncBlocked, false);
});

test("failed account writes preserve committed metadata and credentials while removal clears the local profile first", async (context) => {
  const { request, add, job, waitJob, calls, dataDir } = await fixture(context);
  const account = await add();
  const profile = path.join(dataDir, `profile-${account.id}`);
  await mkdir(profile, { mode: 0o700 });
  await writeFile(path.join(profile, "mock-cookie"), "test-only-local-session", { mode: 0o600 });
  const before = await readFile(path.join(dataDir, "accounts.json"), "utf8");
  const blocked = path.join(dataDir, "accounts.json.tmp");
  await mkdir(blocked);
  assert.equal((await request("/accounts/wechat", { appId, appSecret: "replacement-secret", displayName: "changed" })).status, 400);
  assert.equal((await request("/accounts/wechat", { appId: "wxabcdef1234567890", appSecret, displayName: "new account" })).status, 400);
  assert.deepEqual((await request("/accounts")).data.accounts, [account]);
  assert.equal((await request("/accounts/remove", { accountId: account.id })).status, 400);
  assert.deepEqual((await request("/accounts")).data.accounts, [account]);
  assert.equal(await readFile(path.join(dataDir, "accounts.json"), "utf8"), before);
  await assert.rejects(stat(profile), { code: "ENOENT" });
  await rm(blocked, { recursive: true });
  const input = job(account.id);
  await request("/jobs", input);
  await waitJob(input.requestId);
  assert.equal(calls[0].account.appSecret, appSecret);
  assert.equal((await request("/accounts/remove", { accountId: account.id })).status, 200);
  assert.deepEqual((await request("/accounts")).data.accounts, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "accounts.json"), "utf8")), []);
  await assert.rejects(stat(profile), { code: "ENOENT" });
});

test("profile cleanup failure keeps the account available for removal after restart", async (context) => {
  const first = await fixture(context);
  const account = (await first.request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "my creator account" })).data.account;
  const profile = path.join(first.dataDir, `profile-${account.id}`);
  const metadataPath = path.join(first.dataDir, "accounts.json");
  const metadata = await readFile(metadataPath, "utf8");
  const originalRemove = fs.rm;
  const remove = context.mock.method(fs, "rm", async (target, options) => {
    if (target === profile) throw Object.assign(new Error("simulated profile cleanup failure"), { code: "EACCES" });
    return originalRemove(target, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await first.request("/accounts/remove", { accountId: account.id })).status, 400);
    assert.deepEqual((await first.request("/accounts")).data.accounts, [account]);
    assert.equal(await readFile(metadataPath, "utf8"), metadata);
    assert.equal(await readFile(path.join(profile, "mock-cookie"), "utf8"), "test-only-local-cookie");
  } finally {
    remove.mock.restore();
    syncBuiltinESMExports();
  }
  await first.close();
  const second = await fixture(context, {}, first.dataDir);
  assert.deepEqual((await second.request("/accounts")).data.accounts, [account]);
  assert.equal((await second.request("/accounts/remove", { accountId: account.id })).status, 200);
  assert.deepEqual((await second.request("/accounts")).data.accounts, []);
  assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")), []);
  await assert.rejects(stat(profile), { code: "ENOENT" });
});

test("failed lock persistence never starts a provider and failed acknowledgements preserve restart locks", async (context) => {
  let calls = 0;
  const first = await fixture(context, { saveWechatDraft: async () => { calls++; return { status: "needs_confirmation", message: "mock pending" }; } });
  const account = await first.add();
  const blocked = path.join(first.dataDir, "accounts.json.tmp");
  await mkdir(blocked);
  const input = first.job(account.id);
  assert.equal((await first.request("/jobs", input)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await first.request("/accounts")).data.accounts[0].syncBlocked, false);
  await rm(blocked, { recursive: true });
  assert.equal((await first.request("/jobs", input)).status, 200);
  await first.waitJob(input.requestId);
  assert.equal(calls, 1);
  await mkdir(blocked);
  for (const outcome of ["saved", "not_saved"]) {
    assert.equal((await first.request("/jobs/acknowledge", { accountId: account.id, outcome })).status, 400);
    assert.equal((await first.request("/accounts")).data.accounts[0].syncBlocked, true);
    assert.equal((await first.request("/jobs", first.job(account.id))).status, 409);
  }
  await first.close();
  const second = await fixture(context, {}, first.dataDir);
  assert.equal((await second.request("/accounts")).data.accounts[0].syncBlocked, true);
  assert.equal((await second.request("/accounts/remove", { accountId: account.id })).status, 409);
  await rm(blocked, { recursive: true });
  assert.equal((await second.request("/jobs/acknowledge", { accountId: account.id, outcome: "saved" })).status, 200);
  assert.equal((await second.request("/accounts")).data.accounts[0].syncBlocked, false);
});

test("a confirmed platform write retains its lock when local completion cannot be persisted", async (context) => {
  let finish;
  const first = await fixture(context, { saveWechatDraft: () => new Promise((resolve) => { finish = resolve; }) });
  const account = await first.add();
  const input = first.job(account.id);
  await first.request("/jobs", input);
  await mkdir(path.join(first.dataDir, "accounts.json.tmp"));
  finish({ status: "saved", draftId: "confirmed-remote-draft", message: "mock confirmed" });
  const receipt = (await first.waitJob(input.requestId)).data.receipt;
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(receipt.draftId, "confirmed-remote-draft");
  assert.equal((await first.request("/accounts")).data.accounts[0].syncBlocked, true);
  await first.close();
  const second = await fixture(context, {}, first.dataDir);
  assert.equal((await second.request("/accounts")).data.accounts[0].syncBlocked, true);
});

test("truncated PNG and JPEG containers are rejected before calling a platform provider", async (context) => {
  const { request, add, job, waitJob, calls } = await fixture(context);
  const account = await add();
  const invalidChunk = Buffer.from(png);
  invalidChunk.writeUInt32BE(0xffffffff, 33);
  const emptyScanEnd = jpeg.indexOf(Buffer.from([255, 218])) + 2;
  const emptyScan = Buffer.concat([jpeg.subarray(0, emptyScanEnd + jpeg.readUInt16BE(emptyScanEnd)), Buffer.from([255, 217])]);
  for (const [mime, bytes] of [
    ["image/png", png.subarray(0, 33)],
    ["image/png", png.subarray(0, -5)],
    ["image/png", Buffer.concat([png.subarray(0, 33), png.subarray(-12)])],
    ["image/png", invalidChunk],
    ["image/jpeg", Buffer.from("ffd8ffc00008080001000101", "hex")],
    ["image/jpeg", jpeg.subarray(0, -2)],
    ["image/jpeg", emptyScan],
  ]) {
    const result = await request("/jobs", { ...job(account.id), images: [{ ...image, mime, base64: bytes.toString("base64") }] });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /PNG|JPEG/);
    assert.equal(calls.length, 0);
    assert.equal((await request("/accounts")).data.accounts[0].syncBlocked, false);
  }
  const valid = { ...job(account.id), images: [{ ...image, mime: "image/jpeg", base64: jpeg.toString("base64") }] };
  assert.equal((await request("/jobs", valid)).status, 200);
  await waitJob(valid.requestId);
  assert.equal(calls.length, 1);
});

test("creator sessions use separate local profiles and failed account saves close and remove new profiles", async (context) => {
  let nextCreator = 0;
  const { request, profiles, closedProfiles, dataDir } = await fixture(context, { loginXiaohongshu: async () => ({ remoteId: `creator-${++nextCreator}`, displayName: "mock creator" }) });
  const first = (await request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "first" })).data.account;
  const second = (await request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "second" })).data.account;
  assert.deepEqual(profiles, [path.join(dataDir, `profile-${first.id}`), path.join(dataDir, `profile-${second.id}`)]);
  assert.notEqual(profiles[0], profiles[1]);
  for (const profile of profiles) {
    assert.equal(await readFile(path.join(profile, "mock-cookie"), "utf8"), "test-only-local-cookie");
    if (process.platform !== "win32") assert.equal((await stat(profile)).mode & 0o777, 0o700);
  }
  assert.equal((await readFile(path.join(dataDir, "accounts.json"), "utf8")).includes("test-only-local-cookie"), false);
  assert.equal(JSON.stringify((await request("/accounts")).data).includes("test-only-local-cookie"), false);
  const blocked = path.join(dataDir, "accounts.json.tmp");
  await mkdir(blocked);
  assert.equal((await request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "third" })).status, 400);
  assert.equal((await request("/accounts")).data.accounts.length, 2);
  assert.deepEqual(closedProfiles, [profiles[2]]);
  await assert.rejects(stat(profiles[2]), { code: "ENOENT" });
  await rm(blocked, { recursive: true });
  assert.equal((await request("/accounts/remove", { accountId: first.id })).status, 200);
  await assert.rejects(stat(profiles[0]), { code: "ENOENT" });
  assert.equal(await readFile(path.join(profiles[1], "mock-cookie"), "utf8"), "test-only-local-cookie");
});

test("a provider interrupted before any result leaves its persisted account lock on restart", async (context) => {
  const first = await fixture(context, { saveWechatDraft: () => new Promise(() => {}) });
  const account = await first.add();
  const input = first.job(account.id);
  assert.equal((await first.request("/jobs", input)).status, 200);
  assert.equal((await first.request(`/jobs/${input.requestId}`)).data.state, "running");
  await first.close();
  const second = await fixture(context, {}, first.dataDir);
  assert.equal((await second.request("/accounts")).data.accounts[0].syncBlocked, true);
  await second.add();
  assert.equal((await second.request("/jobs", second.job(account.id))).status, 409);
  assert.equal((await second.request("/accounts/remove", { accountId: account.id })).status, 409);
});

test("account connection in progress prevents acknowledgements of another pending draft", async (context) => {
  let finishVerification;
  let verificationStarted;
  const started = new Promise((resolve) => { verificationStarted = resolve; });
  const otherAppId = "wxabcdef1234567890";
  const { request, add, job, waitJob } = await fixture(context, {
    verifyWechatAccount: async ({ appId: id }) => {
      if (id === appId) return { remoteId: id };
      verificationStarted();
      return new Promise((resolve) => { finishVerification = resolve; });
    },
    saveWechatDraft: async () => ({ status: "needs_confirmation", message: "mock pending" }),
  });
  const account = await add();
  const input = job(account.id);
  await request("/jobs", input);
  await waitJob(input.requestId);
  const connection = request("/accounts/wechat", { appId: otherAppId, appSecret, displayName: "other" });
  await started;
  assert.deepEqual((await request("/accounts/cancel-login", { loginRequestId: randomUUID() })).data, { cancelled: false });
  assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "not_saved" })).status, 409);
  finishVerification({ remoteId: otherAppId });
  assert.equal((await connection).status, 200);
  assert.equal((await request("/jobs/acknowledge", { accountId: account.id, outcome: "not_saved" })).status, 200);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function expectRemoved(profile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await stat(profile); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Temporary login profile was not removed");
}

test("login and cancellation require a UUID request identity and cancellation rejects additional fields", async (context) => {
  let logins = 0;
  const f = await fixture(context, { loginXiaohongshu: async () => { logins++; return { remoteId: "valid-creator" }; } });
  for (const loginRequestId of [undefined, null, "", 17, [], {}, "not-a-uuid", `${randomUUID()}x`, randomUUID().replaceAll("-", "")]) {
    assert.equal((await f.request("/accounts/xiaohongshu", { displayName: "invalid request", loginRequestId })).status, 400);
    assert.equal((await f.request("/accounts/cancel-login", { loginRequestId })).status, 400);
  }
  assert.equal((await f.request("/accounts/cancel-login", { loginRequestId: randomUUID(), accountId: randomUUID() })).status, 400);
  assert.equal((await f.request("/accounts/cancel-login", { loginRequestId: randomUUID(), displayName: "extra field" })).status, 400);
  assert.equal(logins, 0);
  assert.deepEqual(f.profiles, []);
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: randomUUID() })).data, { cancelled: false });
  const loginRequestId = randomUUID();
  const connected = await f.request("/accounts/xiaohongshu", { displayName: "valid request", loginRequestId });
  assert.equal(connected.status, 200);
  assert.notEqual(connected.data.account.id, loginRequestId);
  assert.equal(logins, 1);
});

test("two pages cannot cancel another page's pending login or a later retry through real HTTP", { timeout: 5000 }, async (context) => {
  const pageA = { loginRequestId: randomUUID(), started: deferred(), identity: deferred() };
  const pageB = { loginRequestId: randomUUID(), started: deferred(), identity: deferred() };
  const pages = [pageA, pageB];
  let logins = 0;
  const f = await fixture(context, { loginXiaohongshu: async ({ signal }) => {
    const page = pages[logins++];
    page.signal = signal;
    page.started.resolve();
    return page.identity.promise;
  } });
  const connectionA = f.request("/accounts/xiaohongshu", { displayName: "page A", loginRequestId: pageA.loginRequestId });
  await pageA.started.promise;
  const requestB = { displayName: "page B", loginRequestId: pageB.loginRequestId };
  assert.equal((await f.request("/accounts/xiaohongshu", requestB)).status, 409);
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: pageB.loginRequestId })).data, { cancelled: false });
  assert.equal(pageA.signal.aborted, false);
  assert.equal(f.closedProfiles.length, 0);
  assert.equal(logins, 1);
  assert.equal((await f.request("/accounts/xiaohongshu", requestB)).status, 409);

  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: pageA.loginRequestId })).data, { cancelled: true });
  assert.equal((await connectionA).status, 409);
  await expectRemoved(f.profiles[0]);
  const connectionB = f.request("/accounts/xiaohongshu", requestB);
  await pageB.started.promise;
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: pageA.loginRequestId })).data, { cancelled: false });
  pageA.identity.resolve({ remoteId: "cancelled-page-A" });
  await nextTurn();
  assert.equal(pageB.signal.aborted, false);
  assert.equal((await f.request("/accounts/xiaohongshu", { displayName: "page C", loginRequestId: randomUUID() })).status, 409);
  assert.deepEqual((await f.request("/accounts")).data.accounts, []);
  pageB.identity.resolve({ remoteId: "current-page-B" });
  assert.equal((await connectionB).status, 200);
  assert.deepEqual((await f.request("/accounts")).data.accounts.map((account) => account.remoteId), ["current-page-B"]);
  assert.equal(f.closedProfiles.includes(f.profiles[1]), false);
  const metadata = await readFile(path.join(f.dataDir, "accounts.json"), "utf8");
  for (const page of pages) assert.equal(metadata.includes(page.loginRequestId), false);
});

test("cancelled login releases its lock, discards only its temporary profile and ignores late identity", async (context) => {
  const firstRequestId = randomUUID();
  const secondRequestId = randomUUID();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstIdentity = deferred();
  const secondIdentity = deferred();
  let reads = 0;
  const f = await fixture(context, { loginXiaohongshu: async ({ signal }) => {
    assert.ok(signal instanceof AbortSignal);
    reads++;
    (reads === 1 ? firstStarted : secondStarted).resolve();
    return reads === 1 ? firstIdentity.promise : secondIdentity.promise;
  } });
  const existing = await f.add();
  const first = f.request("/accounts/xiaohongshu", { loginRequestId: firstRequestId, displayName: "cancelled creator" });
  await firstStarted.promise;
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: firstRequestId })).data, { cancelled: true });
  const cancelled = await first;
  assert.equal(cancelled.status, 409);
  assert.match(cancelled.data.error, /已取消小红书登录/);
  await expectRemoved(f.profiles[0]);
  assert.deepEqual((await f.request("/accounts")).data.accounts, [existing]);
  const second = f.request("/accounts/xiaohongshu", { loginRequestId: secondRequestId, displayName: "current creator" });
  await secondStarted.promise;
  firstIdentity.resolve({ remoteId: "late-cancelled-creator" });
  await nextTurn();
  assert.equal((await f.request("/accounts/wechat", { appId, appSecret, displayName: "must wait" })).status, 409);
  secondIdentity.resolve({ remoteId: "current-creator" });
  assert.equal((await second).status, 200);
  const accounts = (await f.request("/accounts")).data.accounts;
  assert.deepEqual(accounts.map((account) => account.remoteId), [appId, "current-creator"]);
  assert.equal(f.closedProfiles.filter((profile) => profile === f.profiles[0]).length, 1);
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: secondRequestId })).data, { cancelled: false });
  assert.equal(f.closedProfiles.includes(f.profiles[1]), false);
  assert.equal((await f.request("/accounts/cancel-login", { accountId: existing.id })).status, 400);
});

test("cancelling browser creation handles its late context once without unlocking a newer login", async (context) => {
  const firstRequestId = randomUUID();
  const creating = deferred();
  const releaseBrowser = deferred();
  const currentStarted = deferred();
  const currentIdentity = deferred();
  let created = 0;
  let logins = 0;
  const f = await fixture(context, { loginXiaohongshu: async () => {
    logins++;
    currentStarted.resolve();
    return currentIdentity.promise;
  } }, undefined, { createBrowser: async ({ browser }) => {
    if (++created === 1) { creating.resolve(); await releaseBrowser.promise; }
    return browser;
  } });
  const first = f.request("/accounts/xiaohongshu", { loginRequestId: firstRequestId, displayName: "opening" });
  await creating.promise;
  assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: firstRequestId })).data, { cancelled: true });
  assert.equal((await first).status, 409);
  assert.equal(logins, 0);
  const second = f.request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "retry" });
  await currentStarted.promise;
  releaseBrowser.resolve();
  await expectRemoved(f.profiles[0]);
  assert.equal(logins, 1);
  assert.equal((await f.request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "must wait" })).status, 409);
  assert.deepEqual((await f.request("/accounts")).data.accounts, []);
  currentIdentity.resolve({ remoteId: "only-current-creator" });
  assert.equal((await second).status, 200);
  assert.equal(f.closedProfiles.filter((profile) => profile === f.profiles[0]).length, 1);
  assert.equal(f.closedProfiles.includes(f.profiles[1]), false);
});

test("cancel waits for a committing login to finish on either persistence success or failure", async (context) => {
  for (const failWrite of [false, true]) {
    const f = await fixture(context);
    const committing = deferred();
    const finishCommit = deferred();
    const originalRename = fs.rename;
    const rename = context.mock.method(fs, "rename", async (source, destination) => {
      if (destination === path.join(f.dataDir, "accounts.json")) {
        committing.resolve();
        await finishCommit.promise;
        if (failWrite) throw new Error("simulated metadata failure");
      }
      return originalRename(source, destination);
    });
    syncBuiltinESMExports();
    try {
      const loginRequestId = randomUUID();
      const connection = f.request("/accounts/xiaohongshu", { loginRequestId, displayName: "committing creator" });
      await committing.promise;
      assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId: randomUUID() })).data, { cancelled: false });
      const cancelReceived = new Promise((resolve) => {
        const observe = (request) => {
          if (request.url !== "/api/accounts/cancel-login") return;
          f.companion.server.off("request", observe);
          request.once("end", resolve);
        };
        f.companion.server.on("request", observe);
      });
      let cancelledReturned = false;
      const cancellation = f.request("/accounts/cancel-login", { loginRequestId }).then((value) => { cancelledReturned = true; return value; });
      await cancelReceived;
      await nextTurn();
      assert.equal(cancelledReturned, false);
      finishCommit.resolve();
      assert.equal((await connection).status, failWrite ? 400 : 200);
      assert.deepEqual((await cancellation).data, { cancelled: false });
      assert.equal((await f.request("/accounts")).data.accounts.length, failWrite ? 0 : 1);
      assert.equal(f.closedProfiles.length, failWrite ? 1 : 0);
      assert.deepEqual((await f.request("/accounts/cancel-login", { loginRequestId })).data, { cancelled: false });
      assert.equal(f.closedProfiles.length, failWrite ? 1 : 0);
      if (!failWrite) assert.equal(await readFile(path.join(f.profiles[0], "mock-cookie"), "utf8"), "test-only-local-cookie");
    } finally {
      finishCommit.resolve();
      rename.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("helper shutdown cancels an unregistered login window and never persists its late identity", async (context) => {
  const started = deferred();
  const identity = deferred();
  const f = await fixture(context, { loginXiaohongshu: async () => { started.resolve(); return identity.promise; } });
  const connection = f.request("/accounts/xiaohongshu", { loginRequestId: randomUUID(), displayName: "interrupted creator" }).catch(() => null);
  await started.promise;
  await f.close();
  await connection;
  identity.resolve({ remoteId: "must-not-persist" });
  await nextTurn();
  assert.equal(f.closedProfiles.length, 1);
  await expectRemoved(f.profiles[0]);
  const restarted = await fixture(context, {}, f.dataDir);
  assert.deepEqual((await restarted.request("/accounts")).data.accounts, []);
});

test("real login adapter ends on cancellation, closed page or context, and timeout without listeners or pending waits", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const schedule = globalThis.setTimeout;
  const loginTimers = [];
  context.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 120_000) loginTimers.push(timer);
    return timer;
  });
  const cleared = context.mock.method(globalThis, "clearTimeout");
  for (const reason of ["abort", "page", "context", "timeout"]) {
    const page = Object.assign(new EventEmitter(), { goto: async () => {}, bringToFront: async () => {}, evaluate: async () => null });
    const browser = Object.assign(new EventEmitter(), { newPage: async () => page });
    const controller = new AbortController();
    const pending = loginXiaohongshu({ context: browser, signal: controller.signal });
    const checked = assert.rejects(pending, (error) => {
      if (reason === "abort") return error.message === "test cancellation";
      assert.equal(error.publicMessage, reason === "timeout" ? "扫码等待已超时，请重新打开登录窗口" : "登录窗口已关闭，可以重新尝试连接小红书账号");
      return true;
    });
    await nextTurn();
    if (reason === "abort") controller.abort(new Error("test cancellation"));
    else if (reason === "timeout") context.mock.timers.tick(120_001);
    else (reason === "page" ? page : browser).emit("close");
    await checked;
    assert.equal(page.listenerCount("response"), 0);
    assert.equal(page.listenerCount("close"), 0);
    assert.equal(browser.listenerCount("close"), 0);
  }
  assert.equal(loginTimers.length, 4);
  for (const timer of loginTimers) {
    assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === timer));
  }
  context.mock.timers.tick(120_001);
});

test("login navigation failures provide safe actionable text without browser credentials", async () => {
  const page = Object.assign(new EventEmitter(), { goto: async () => { throw new Error("https://private-account:private-password@example.test/?token=private-token"); } });
  await assert.rejects(loginXiaohongshu({ context: { newPage: async () => page } }), (error) => {
    assert.equal(error.publicMessage, "无法打开小红书登录页，请检查网络后再试");
    assert.equal(error.message.includes("private"), false);
    assert.equal(error.statusCode, 502);
    return true;
  });
  assert.equal(page.listenerCount("response"), 0);
  assert.equal(page.listenerCount("close"), 0);
});
