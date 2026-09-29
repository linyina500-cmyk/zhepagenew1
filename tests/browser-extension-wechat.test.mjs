import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createWechatHandler, fetchWechatInBrowser, readWechatSubmission } from "../browser-extension/wechat.mjs";
import { WechatApiError } from "../lib/wechat/api.mjs";

const deviceId = "a".repeat(32), appId = "wx1234567890123456", appSecret = "s".repeat(32);
const accountId = createHash("sha256").update(appId).digest("hex").slice(0, 20);
const base = `/api/wechat/accounts/${accountId}`;
const jobKey = (id) => `wechat:job:${accountId}:${id}`;
const deferred = () => Promise.withResolvers();
function memoryStore() {
  const map = new Map(), watchers = new Set();
  return { map, get: async (key) => structuredClone(map.get(key)), set: async (key, value) => { map.set(key, structuredClone(value)); for (const notify of watchers) notify(key, value); },
    async delete(key) { map.delete(key); }, async list(prefix) { return [...map.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); },
    async terminal(id) {
      const ready = deferred();
      const observe = (key, value) => { if (key === jobKey(id) && !["uploading", "creating"].includes(value?.status)) ready.resolve(structuredClone(value)); };
      watchers.add(observe); observe(jobKey(id), map.get(jobKey(id)));
      try { return await ready.promise; } finally { watchers.delete(observe); }
    },
  };
}
function picture(seed = 0) {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, 1080); new DataView(bytes.buffer).setUint32(20, 1350); bytes[31] = seed;
  return new Blob([bytes], { type: "image/png" });
}
function submission(id, options = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries({ id, expectedAccountId: accountId, title: "示例标题", body: "配文\r\n第二行", ...options })) form.set(name, value);
  form.append("images", picture(), "local-sensitive-name.png"); form.append("images", picture(1), "other.png");
  return form;
}
async function fixture(options = {}) {
  const store = options.store || memoryStore(), calls = [];
  const api = { async checkConnection() { calls.push("connect"); }, async uploadImage({ name }) { calls.push(name); return `media-${name}`; },
    async createDraft(input) { calls.push({ create: structuredClone(input) }); return "draft-synthetic"; },
    async verifyDraft(input) { calls.push({ verify: structuredClone(input) }); return { verified: true, message: "已核对", verificationMismatches: [] }; }, ...options.api };
  const handle = createWechatHandler({ deviceId, store, apiFactory: ({ appId: id, appSecret: secret }) => { assert.equal(id, appId); assert.equal(secret, appSecret); return api; } });
  const connect = () => handle({ path: "/api/wechat/accounts/connect", method: "POST", body: { deviceId, appId, appSecret, name: "测试公众号" } });
  if (options.connect !== false) assert.equal((await connect()).status, 200);
  return { store, calls, api, handle, connect };
}

async function waitIdle(handle) {
  for (let turn = 0; turn < 30; turn++) if (!(await handle({ path: "/api/wechat/connection" })).body.busy) return;
  assert.fail("Draft operation did not release its account lock");
}

test("extension draft commits its reservation, uploads in order, and returns the existing client response contract", { timeout: 5000 }, async () => {
  const started = deferred(), release = deferred();
  let upload = 0, f;
  f = await fixture({ api: { async uploadImage({ name }) {
    const durable = await f.store.get(jobKey(id)); assert.equal(durable.status, "uploading"); assert.equal(durable.uploadedCount, upload);
    if (++upload === 1) { started.resolve(); await release.promise; }
    return `image-${name}`;
  } } });
  const id = randomUUID();
  const submitted = await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) });
  assert.equal(submitted.status, 202); assert.equal(submitted.body.job.status, "uploading");
  await started.promise;
  assert.equal((await f.handle({ path: "/api/wechat/connection" })).body.busy, true);
  release.resolve(); await f.store.terminal(id);
  const result = await f.handle({ path: `${base}/jobs/${id}` });
  assert.equal(result.body.job.status, "saved"); assert.equal(result.body.job.uploadedCount, 2);
  assert.equal(result.body.job.draftId, "draft-synthetic");
  assert.deepEqual(f.calls.find((call) => call.create)?.create, { title: "示例标题", body: "配文\n第二行", imageMediaIds: ["image-poster-1.png", "image-poster-2.png"] });
  assert.deepEqual(Object.keys(result.body.job).sort(), ["accountId", "accountName", "createdAt", "draftId", "id", "imageCount", "message", "status", "title", "updatedAt", "uploadedCount"]);
  assert.doesNotMatch(JSON.stringify([...f.store.map.values()]), /AppSecret|access_token|local-sensitive-name|ssssssssssssssssssssssssssssssss/u);
});

test("duplicate IDs never repeat platform writes; changed content, account mismatch and concurrent new work are rejected", { timeout: 5000 }, async () => {
  const release = deferred();
  const f = await fixture({ api: { async uploadImage() { await release.promise; return "media"; } } });
  const id = randomUUID();
  assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) })).status, 202);
  assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) })).status, 202);
  for (const body of [submission(id, { title: "不同内容" }), submission(randomUUID()), submission(id, { expectedAccountId: "b".repeat(20) })]) {
    assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body })).status, 409);
  }
  assert.equal((await f.handle({ path: `${base}/disconnect`, method: "POST" })).status, 409);
  assert.equal((await f.connect()).status, 409);
  release.resolve(); await f.store.terminal(id);
  assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) })).body.job.status, "saved");
  assert.equal(f.calls.filter((call) => call.create).length, 1);
});

test("restarted worker requires browser credentials again and recovers interrupted jobs without uploading or creating", async () => {
  const store = memoryStore(), id = randomUUID(), input = await readWechatSubmission(submission(id));
  for (const stage of ["uploading", "creating"]) {
    await store.set(jobKey(id), { id, accountId, accountName: "测试公众号", title: input.title, body: input.body, fingerprint: input.fingerprint,
      imageCount: 2, uploadedCount: stage === "creating" ? 2 : 1, imageMediaIds: stage === "creating" ? ["a", "b"] : ["a"], status: stage, message: "处理中", createdAt: "2026-09-29", updatedAt: "2026-09-29" });
    const f = await fixture({ store, connect: false });
    assert.deepEqual((await f.handle({ path: "/api/wechat/accounts" })).body.accounts, []);
    assert.equal((await f.handle({ path: `${base}/jobs/${id}` })).status, 409);
    await f.connect();
    const repeated = await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) });
    assert.equal(repeated.body.job.status, "needs_confirmation");
    assert.match(repeated.body.job.message, /不会重新上传/u);
    assert.deepEqual(f.calls, ["connect"]);
    assert.equal(f.handle.busy(), false, "old incomplete records do not make a restarted worker active");
    assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(randomUUID()) })).status, 409, "a different task ID must not duplicate the same uncertain content");
    assert.deepEqual(f.calls, ["connect"]);
  }
});

test("a lost create response stays uncertain across duplicate calls and a worker restart", { timeout: 5000 }, async () => {
  const f = await fixture({ api: { async createDraft() { throw new Error("private-token-bearing-url"); } } });
  const id = randomUUID();
  await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) });
  await f.store.terminal(id);
  const result = await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) });
  assert.equal(result.body.job.status, "needs_confirmation"); assert.doesNotMatch(JSON.stringify(result), /private-token/u);
  const restarted = await fixture({ store: f.store });
  assert.equal((await restarted.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) })).body.job.status, "needs_confirmation");
  assert.deepEqual(restarted.calls, ["connect"]);
  const duplicate = await restarted.handle({ path: `${base}/jobs`, method: "POST", body: submission(randomUUID()) });
  assert.equal(duplicate.status, 409); assert.match(duplicate.body.error, /待核对/u);
  assert.deepEqual(restarted.calls, ["connect"]);
});

test("no platform write occurs when the initial durable reservation fails", async () => {
  const store = memoryStore(); store.set = async () => { throw new Error("private-storage-error"); };
  const f = await fixture({ store });
  const response = await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(randomUUID()) });
  assert.equal(response.status, 502); assert.doesNotMatch(JSON.stringify(response), /private-storage/u);
  assert.deepEqual(f.calls, ["connect"]);
});

test("read-only verify retains the known draft ID on storage failure and never recreates it", { timeout: 5000 }, async () => {
  const f = await fixture(), id = randomUUID();
  await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) }); await f.store.terminal(id); await waitIdle(f.handle);
  f.store.set = async () => { throw new Error("full"); };
  const result = await f.handle({ path: `${base}/jobs/${id}/verify`, method: "POST" });
  assert.equal(result.body.job.draftId, "draft-synthetic"); assert.equal(result.body.job.status, "needs_confirmation");
  assert.equal(f.calls.filter((call) => call.create).length, 1);
  assert.equal((await f.handle({ path: `${base}/jobs/${id}` })).body.job.draftId, "draft-synthetic");
});

test("only draft routes exist; foreign devices and invalid connection data are rejected without retaining credentials", async () => {
  const f = await fixture();
  assert.equal(await f.handle({ path: "/api/xiaohongshu/account" }), null);
  for (const suffix of ["publication", "publication/refresh", "acknowledge"]) {
    assert.equal((await f.handle({ path: `${base}/jobs/${randomUUID()}/${suffix}`, method: "POST", body: { confirm: true } })).status, 404);
  }
  assert.equal((await f.handle({ path: "/api/wechat/accounts/connect", method: "POST", body: { deviceId: "b".repeat(32), appId, appSecret, name: "名称" } })).status, 409);
  assert.equal((await f.handle({ path: "/api/wechat/accounts/connect", method: "POST", body: { deviceId, appId, appSecret, name: "名称", extra: true } })).status, 400);
  assert.equal((await f.handle({ path: `${base}/disconnect`, method: "POST" })).status, 200);
  assert.deepEqual((await f.handle({ path: "/api/wechat/accounts" })).body.accounts, []);
});

test("submission rejects forged images, duplicate text fields and overflow before an API write", async () => {
  const f = await fixture();
  const forged = submission(randomUUID()); forged.set("images", new Blob(["fake"], { type: "image/png" }), "fake.png");
  const duplicate = submission(randomUUID()); duplicate.append("title", "重复标题");
  const invalid = [forged, duplicate, submission(randomUUID(), { title: "长".repeat(21) }), submission(randomUUID(), { body: "字".repeat(700) })];
  for (const body of invalid) assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body })).status, 400);
  assert.deepEqual(f.calls, ["connect"]);
});

test("controlled WeChat errors remain useful without echoing upstream credentials", async () => {
  const f = await fixture({ connect: false, api: { async checkConnection() { throw new WechatApiError("需要设置公众号白名单", { outcome: "rejected", errcode: 40164 }); } } });
  assert.deepEqual(await f.connect(), { status: 424, body: { error: "需要设置公众号白名单" } });
  assert.deepEqual((await f.handle({ path: "/api/wechat/accounts" })).body.accounts, []);
});

test("browser API transport is restricted to WeChat and omits cookie credentials", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let observed;
  globalThis.fetch = async (url, options) => { observed = { url, options }; return Response.json({ total_count: 0 }); };
  await assert.rejects(fetchWechatInBrowser("https://not-wechat.example/path"));
  const result = await fetchWechatInBrowser("https://api.weixin.qq.com/cgi-bin/draft/count", { credentials: "include", redirect: "follow" });
  assert.equal(result.status, 200); assert.equal(observed.options.credentials, "omit"); assert.equal(observed.options.redirect, "error");
  assert.ok(observed.options.signal instanceof AbortSignal);
});

test("verification holds the same account lock and preserves mismatch details without writing another draft", { timeout: 5000 }, async () => {
  const f = await fixture(), id = randomUUID();
  await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(id) }); await f.store.terminal(id); await waitIdle(f.handle);
  const started = deferred(), release = deferred();
  f.api.verifyDraft = async () => { started.resolve(); await release.promise; return { verified: false, verificationMismatches: ["title"], message: "草稿标题已改变" }; };
  const verification = f.handle({ path: `${base}/jobs/${id}/verify`, method: "POST" });
  await started.promise;
  assert.equal((await f.handle({ path: `${base}/jobs`, method: "POST", body: submission(randomUUID()) })).status, 409);
  assert.equal((await f.handle({ path: `${base}/disconnect`, method: "POST" })).status, 409);
  release.resolve();
  assert.equal((await verification).body.job.status, "needs_confirmation");
  assert.deepEqual((await f.store.get(jobKey(id))).verificationMismatches, ["title"]);
  assert.equal(f.calls.filter((call) => call.create).length, 1);
});

test("different public accounts upload independently while credentials remain only in their memory sessions", { timeout: 5000 }, async () => {
  const store = memoryStore(), releases = [deferred(), deferred()], ids = [appId, "wx6543210987654321"], created = [];
  const handle = createWechatHandler({ deviceId, store, apiFactory: ({ appId: value }) => {
    const index = ids.indexOf(value);
    return { async checkConnection() {}, async uploadImage() { await releases[index].promise; return `media-${index}`; },
      async createDraft() { created.push(index); return `draft-${index}`; }, async verifyDraft() { return { verified: true }; } };
  } });
  const jobs = ids.map(() => randomUUID());
  for (const [index, value] of ids.entries()) {
    const connected = await handle({ path: "/api/wechat/accounts/connect", method: "POST", body: { appId: value, appSecret, name: `公众号${index}`, deviceId } });
    const currentId = connected.body.account.id;
    assert.equal((await handle({ path: `/api/wechat/accounts/${currentId}/jobs`, method: "POST", body: submission(jobs[index], { expectedAccountId: currentId }) })).status, 202);
  }
  releases[1].resolve();
  const secondId = createHash("sha256").update(ids[1]).digest("hex").slice(0, 20);
  for (let turn = 0; turn < 30; turn++) {
    const result = await handle({ path: `/api/wechat/accounts/${secondId}/jobs/${jobs[1]}` });
    if (result.body.job.status === "saved") break;
    if (turn === 29) assert.fail("Independent second account did not finish");
  }
  assert.deepEqual(created, [1]);
  releases[0].resolve(); await store.terminal(jobs[0]);
  assert.deepEqual(created, [1, 0]);
  assert.doesNotMatch(JSON.stringify([...store.map.values()]), /ssssssssssssssssssssssssssssssss/u);
});

test("browser fetch aborts at 25 seconds without retrying or losing the parent's cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0, signal;
  globalThis.fetch = async (_url, options) => { calls++; signal = options.signal; return new Promise((_, reject) => { options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); };
  const pending = fetchWechatInBrowser("https://api.weixin.qq.com/cgi-bin/draft/count");
  const rejected = assert.rejects(pending, /aborted/u);
  t.mock.timers.tick(24_999); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await rejected; assert.equal(calls, 1);
  const parent = new AbortController();
  const canceled = fetchWechatInBrowser("https://api.weixin.qq.com/cgi-bin/draft/count", { signal: parent.signal });
  const parentRejected = assert.rejects(canceled, /aborted/u);
  parent.abort(); await parentRejected;
  assert.equal(signal.aborted, true); assert.equal(calls, 2);
});
