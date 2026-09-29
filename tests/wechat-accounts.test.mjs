import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createAccountRegistry } from "../server/wechat/accounts.mjs";
import { createWechatServer } from "../server/wechat/http.mjs";
import { readSubmission } from "../server/wechat/jobs.mjs";

const token = "a".repeat(64), otherToken = "b".repeat(64);
const first = { appId: "wx0123456789abcdef", appSecret: "A".repeat(32), name: "测试账号甲" };
const second = { appId: "wxfedcba9876543210", appSecret: "B".repeat(32), name: "测试账号乙" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const json = (value) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
function form(accountId, id = randomUUID()) {
  const result = new FormData();
  result.set("expectedAccountId", accountId); result.set("id", id); result.set("title", "隔离测试海报"); result.set("body", "测试短配文");
  result.append("images", new Blob([png], { type: "image/png" }), "poster.png");
  return result;
}
async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await files(child));
    else result.push(await readFile(child, "utf8"));
  }
  return result;
}
async function fixture(t, customize) {
  const dataDir = await mkdtemp(join(tmpdir(), "zhepage-accounts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const clients = [];
  const apiFactory = (credentials) => {
    const calls = [];
    const api = {
      async checkConnection() { calls.push("connect"); },
      async uploadImage() { calls.push("upload"); return `image-${credentials.appId}`; },
      async createDraft() { calls.push("draft"); return `draft-${credentials.appId}`; },
      async verifyDraft() { calls.push("verify"); return { verified: true }; },
      async submitPublication() { calls.push("publish"); return { publishId: `publish-${credentials.appId}` }; },
      async getPublication() { calls.push("poll"); return { status: "publishing", urls: [], message: "微信处理中。" }; },
    };
    customize?.(api, credentials, calls);
    clients.push({ credentials, calls, api });
    return api;
  };
  const options = { dataDir, syncToken: token, apiFactory };
  const accounts = createAccountRegistry(options);
  const server = createWechatServer({ accounts, syncToken: token });
  const handler = server.listeners("request")[0];
  async function call(path, init = {}, authorization = token) {
    const headers = new Headers(init.headers);
    if (authorization !== null) headers.set("Authorization", `Bearer ${authorization}`);
    const web = new Request(`https://sync.example/api/wechat/${path}`, { ...init, headers });
    const bytes = Buffer.from(await web.arrayBuffer());
    const request = Readable.from(bytes.length ? [bytes] : []);
    request.url = new URL(web.url).pathname + new URL(web.url).search; request.method = web.method;
    request.socket = { localPort: 8788 }; request.headers = { host: "127.0.0.1:8788", ...Object.fromEntries(web.headers) };
    const response = { headersSent: false,
      writeHead(status, values) { this.status = status; this.headers = values; this.headersSent = true; },
      end(body) { this.body = JSON.parse(body); },
    };
    await handler(request, response);
    return response;
  }
  const connect = (credentials = first) => accounts.connect({ ...credentials, deviceId: accounts.deviceId });
  return { options, accounts, clients, call, connect, dataDir };
}

test("credentials live only in RAM while separate accounts retain isolated durable jobs", async (t) => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(second);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(f.clients.map(({ credentials }) => credentials), [
    { appId: first.appId, appSecret: first.appSecret }, { appId: second.appId, appSecret: second.appSecret },
  ]);
  assert.deepEqual(await files(f.dataDir), []);
  const aForm = form(a.id), bForm = form(b.id);
  for (const [account, body] of [[a, aForm], [b, bForm]]) {
    assert.equal((await f.call(`accounts/${account.id}/jobs`, { method: "POST", body })).status, 202);
  }
  await f.accounts.idle();
  const aJob = (await f.call(`accounts/${a.id}/jobs/${aForm.get("id")}`)).body.job;
  const bJob = (await f.call(`accounts/${b.id}/jobs/${bForm.get("id")}`)).body.job;
  assert.equal(aJob.draftId, `draft-${first.appId}`); assert.equal(bJob.draftId, `draft-${second.appId}`);
  assert.equal((await f.call(`accounts/${a.id}/jobs/${bForm.get("id")}`)).status, 404);
  assert.equal((await f.call(`accounts/${b.id}/jobs/${aForm.get("id")}`)).status, 404);
  const uploads = f.clients.map(({ calls }) => calls.filter((kind) => kind === "upload").length);
  assert.equal((await f.call(`accounts/${a.id}/jobs`, { method: "POST", body: form(b.id) })).status, 409);
  assert.deepEqual(f.clients.map(({ calls }) => calls.filter((kind) => kind === "upload").length), uploads);
  const publicData = JSON.stringify((await f.call("accounts")).body);
  const disk = (await files(f.dataDir)).join("\n");
  for (const secret of [first.appSecret, second.appSecret, token, otherToken]) {
    assert.equal(publicData.includes(secret), false); assert.equal(disk.includes(secret), false);
  }
  const restarted = createAccountRegistry(f.options);
  assert.deepEqual(restarted.list(), []);
  assert.throws(() => restarted.get(a.id), (error) => error.status === 409);
  const reconnected = await restarted.connect({ ...first, deviceId: restarted.deviceId });
  assert.equal((await restarted.get(reconnected.id).jobs.get(aForm.get("id"))).draftId, aJob.draftId);
});

test("wrong connection tokens and device binding reject before touching account APIs", async (t) => {
  const f = await fixture(t);
  const otherDevice = createAccountRegistry({ ...f.options, syncToken: otherToken });
  assert.notEqual(f.accounts.deviceId, otherDevice.deviceId);
  for (const credential of [otherToken, null]) {
    assert.equal((await f.call("connection", {}, credential)).status, 401);
    assert.equal((await f.call("accounts/connect", json({ ...first, deviceId: f.accounts.deviceId }), credential)).status, 401);
  }
  const rejected = await f.call("accounts/connect", json({ ...first, deviceId: otherDevice.deviceId }));
  assert.equal(rejected.status, 409); assert.equal(f.clients.length, 0);
  assert.equal((await f.call("connection")).body.deviceId, f.accounts.deviceId);
  const connected = await f.call("accounts/connect", json({ ...first, deviceId: f.accounts.deviceId }));
  assert.equal(connected.status, 200); assert.deepEqual(f.clients[0].calls, ["connect"]);
});

test("disconnect is idempotent after a RAM-only registry restart and preserves durable jobs", async (t) => {
  const f = await fixture(t), account = await f.connect(), input = await readSubmission(form(account.id));
  await f.accounts.get(account.id).jobs.submit(input); await f.accounts.idle();
  const before = await files(f.dataDir), apiCalls = [...f.clients[0].calls];
  const restarted = createAccountRegistry(f.options);
  assert.deepEqual(restarted.list(), []);
  const handler = createWechatServer({ accounts: restarted, syncToken: token }).listeners("request")[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = Readable.from([]);
    Object.assign(request, { method: "POST", url: `/api/wechat/accounts/${account.id}/disconnect`, socket: { localPort: 8788 }, headers: { host: "127.0.0.1:8788", authorization: `Bearer ${token}` } });
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = JSON.parse(body); } };
    await handler(request, response);
    assert.equal(response.status, 200); assert.deepEqual(response.body, { disconnected: true });
  }
  assert.equal(f.clients.length, 1); assert.deepEqual(f.clients[0].calls, apiCalls);
  assert.deepEqual(await files(f.dataDir), before);
  await restarted.connect({ ...first, deviceId: restarted.deviceId });
  assert.equal((await restarted.get(account.id).jobs.get(input.id)).status, "saved");
});

test("unscoped legacy endpoints are unavailable and connection JSON is bounded before API use", async (t) => {
  const f = await fixture(t);
  for (const path of ["account", "jobs", `jobs/${randomUUID()}`, `jobs/${randomUUID()}/publication`, "publish", "freepublish/submit"]) {
    for (const method of ["GET", "POST"]) assert.equal((await f.call(path, { method })).status, 404, path);
  }
  for (const value of [null, [], { ...first, deviceId: f.accounts.deviceId, publish_time: 123 }, { ...first, appSecret: "bad", deviceId: f.accounts.deviceId }]) {
    assert.equal((await f.call("accounts/connect", json(value))).status, 400);
  }
  assert.equal((await f.call("accounts/connect", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await f.call("accounts/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  const tooLarge = { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: `"${"x".repeat(8192)}"` };
  assert.equal((await f.call("accounts/connect", tooLarge)).status, 413);
  assert.equal((await f.call("accounts/connect", { ...json({}), headers: { "Content-Type": "application/json", "Content-Length": "8193" } })).status, 413);
  assert.equal(f.clients.length, 0);
});

test("publication starts only on exact explicit confirmation and never accepts scheduling fields", async (t) => {
  const f = await fixture(t), account = await f.connect(), body = form(account.id);
  await f.call(`accounts/${account.id}/jobs`, { method: "POST", body }); await f.accounts.idle();
  const path = `accounts/${account.id}/jobs/${body.get("id")}/publication`;
  const missing = await f.call(path);
  assert.equal(missing.status, 200); assert.equal(missing.body.publication, null);
  for (const confirmation of [null, {}, [], true, { confirm: false }, { confirm: "true" },
    { confirm: true, publish_time: 123 }, { confirm: true, send_publish_date: "2099-01-01" },
    { confirm: true, draftId: "arbitrary-draft" }, { confirm: true, accountId: "other" }]) {
    assert.equal((await f.call(path, json(confirmation))).status, 400);
  }
  assert.equal((await f.call(`${path}?publish_time=123`, json({ confirm: true }))).status, 400);
  assert.equal(f.clients[0].calls.includes("publish"), false);
  assert.equal((await f.call(path, json({ confirm: true }))).status, 202); await f.accounts.idle();
  assert.equal((await f.call(path)).body.publication.status, "publishing");
  assert.equal((await f.call(`${path}/refresh`, { method: "POST" })).status, 200);
  await f.call(path, json({ confirm: true })); await f.accounts.idle();
  assert.equal(f.clients[0].calls.filter((kind) => kind === "publish").length, 1);
  assert.equal(f.clients[0].calls.filter((kind) => kind === "poll").length, 1);
});

test("active draft and publication work block disconnect and credential replacement", async (t) => {
  let releaseUpload;
  const f = await fixture(t, (api) => { api.uploadImage = async () => new Promise((resolve) => { releaseUpload = () => resolve("image-1"); }); });
  const account = await f.connect(), session = f.accounts.get(account.id), input = await readSubmission(form(account.id));
  await session.jobs.submit(input);
  assert.throws(() => f.accounts.disconnect(account.id), (error) => error.status === 409);
  await assert.rejects(f.connect({ ...first, appSecret: "C".repeat(32) }), (error) => error.status === 409);
  assert.equal(f.clients.length, 1);
  releaseUpload(); await f.accounts.idle();
  let releasePublish, enteredPublish;
  const entered = new Promise((resolve) => { enteredPublish = resolve; });
  session.api.submitPublication = async () => { enteredPublish(); return new Promise((resolve) => { releasePublish = () => resolve({ publishId: "publication-1" }); }); };
  await session.publications.submit(input.id); await entered;
  assert.throws(() => f.accounts.disconnect(account.id), (error) => error.status === 409);
  await assert.rejects(f.connect({ ...first, appSecret: "C".repeat(32) }), (error) => error.status === 409);
  releasePublish(); await f.accounts.idle();
  f.accounts.disconnect(account.id); assert.deepEqual(f.accounts.list(), []);
});

test("new credentials cannot replace a session that becomes busy during their connection check", async (t) => {
  let releaseCheck, enteredCheck, releaseUpload;
  const checking = new Promise((resolve) => { enteredCheck = resolve; });
  const f = await fixture(t, (api, credentials) => {
    if (credentials.appSecret !== first.appSecret) api.checkConnection = async () => {
      enteredCheck(); await new Promise((resolve) => { releaseCheck = resolve; });
    };
    else api.uploadImage = async () => new Promise((resolve) => { releaseUpload = () => resolve("image-1"); });
  });
  const account = await f.connect(), previous = f.accounts.get(account.id);
  const replacing = f.connect({ ...first, appSecret: "C".repeat(32) });
  await checking;
  await previous.jobs.submit(await readSubmission(form(account.id)));
  releaseCheck();
  try {
    await assert.rejects(replacing, (error) => error.status === 409);
    assert.equal(f.accounts.get(account.id), previous);
  } finally { releaseUpload(); await previous.jobs.idle(); }
});
