import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCompanion } from "../companion/server.mjs";
import { authorizeRequest, DEFAULT_ORIGINS, requireLocalOrigin } from "../companion/security.mjs";
import { decodeImages } from "../companion/imageInput.mjs";

const token = "test-only-pairing-token-never-a-real-secret";
const origin = "http://localhost:5173";
const appId = "wx1234567890abcdef";
const appSecret = "test-secret-must-never-be-written-or-reflected";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
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
  const large = Buffer.alloc(5_000_000);
  png.copy(large);
  assert.equal(decodeImages([{ ...image, base64: large.toString("base64") }])[0].bytes.length, large.length);
});

async function fixture(context, changes = {}, existingDirectory) {
  const dataDir = existingDirectory || await mkdtemp(path.join(os.tmpdir(), "zhepage-helper-test-"));
  const calls = [];
  const providers = {
    verifyWechatAccount: async ({ appId: id }) => ({ remoteId: id, displayName: id }),
    saveWechatDraft: async (args) => { calls.push(args); return { status: "saved", draftId: "mock-draft", message: "mock confirmed" }; },
    loginXiaohongshu: async () => ({ remoteId: "creator-123", displayName: "mock creator" }),
    saveXiaohongshuDraft: async () => ({ status: "needs_confirmation", message: "mock pending" }),
    ...changes,
  };
  const companion = await createCompanion({ dataDir, port: 0, token, providers, browserFactory: async () => ({ on() {}, async close() {} }) });
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
  return { companion, request, add, job, waitJob, calls, dataDir, close };
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
  assert.equal((await second.request("/jobs/acknowledge", { accountId: account.id, confirmedNotSaved: true })).status, 200);
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
  assert.equal((await request("/jobs/acknowledge", { accountId: account.id, confirmedNotSaved: true })).status, 409);
  finish({ status: "saved", message: "mock confirmed" });
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
