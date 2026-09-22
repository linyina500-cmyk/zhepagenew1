import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createWechatApi } from "../lib/wechat/api.mjs";
import { createJobService, readSubmission } from "../server/wechat/jobs.mjs";
import { createWechatServer } from "../server/wechat/http.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
function form(id = randomUUID()) {
  const value = new FormData();
  value.set("expectedAccountId", createHash("sha256").update("wx-fixture").digest("hex").slice(0, 20));
  value.set("id", id); value.set("title", "两页海报草稿"); value.set("body", "第一行\n\n#独立配文");
  value.append("images", new Blob([png], { type: "image/png" }), "page-1.png");
  value.append("images", new Blob([png], { type: "image/png" }), "page-2.png");
  return value;
}
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "zhepage-wechat-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const api = {
    async checkConnection() { calls.push(["connect"]); },
    async uploadImage(image) { calls.push(["upload", await image.blob.arrayBuffer()]); return `image-${calls.filter(([kind]) => kind === "upload").length}`; },
    async createDraft(value) { calls.push(["create", value]); return "wechat-draft-id"; },
    async verifyDraft(value) { calls.push(["verify", value]); return { verified: true }; },
    ...overrides,
  };
  const options = { dataDir, appId: "wx-fixture", accountName: "测试公众号", api };
  return { dataDir, api, calls, options, jobs: createJobService(options) };
}

async function multipartRoundtrip(value) {
  const request = new Request("https://sync.example/api/wechat/jobs", { method: "POST", body: value });
  return new Response(await request.arrayBuffer(), { headers: request.headers }).formData();
}

test("multipart text restores all line breaks before fingerprinting and draft verification", async (t) => {
  const f = await fixture(t), original = form();
  const body = "\n第一行\n\n第三行\n";
  original.set("body", body);
  const encoded = await multipartRoundtrip(original);
  assert.equal(encoded.get("body"), "\r\n第一行\r\n\r\n第三行\r\n");
  const input = await readSubmission(encoded);
  assert.equal(input.body, body);
  assert.equal(input.fingerprint, (await readSubmission(original)).fingerprint);
  await f.jobs.submit(input); await f.jobs.idle();
  for (const kind of ["create", "verify"]) assert.equal(f.calls.find(([action]) => action === kind)[1].body, body);
  const carriageReturns = form(); carriageReturns.set("body", "一\r二\r\n\r三");
  assert.equal((await readSubmission(carriageReturns)).body, "一\n二\n\n三");
});

test("multipart line encoding cannot inflate the exact text limits or permit multiline titles", async () => {
  const atByteLimit = form();
  const body = "中".repeat(680) + "\n" + "a".repeat(7);
  assert.equal(Buffer.byteLength(body, "utf8"), 2048);
  atByteLimit.set("body", body);
  const encoded = await multipartRoundtrip(atByteLimit);
  assert.equal(Buffer.byteLength(encoded.get("body"), "utf8"), 2049);
  assert.equal((await readSubmission(encoded)).body, body);
  const overByteLimit = form(); overByteLimit.set("body", body + "a");
  await assert.rejects(readSubmission(await multipartRoundtrip(overByteLimit)), /2,048/);
  const atCharacterLimit = form(); atCharacterLimit.set("body", "a".repeat(998) + "\n\n");
  assert.equal((await readSubmission(await multipartRoundtrip(atCharacterLimit))).body.length, 1000);
  atCharacterLimit.set("body", "a".repeat(999) + "\n\n");
  await assert.rejects(readSubmission(await multipartRoundtrip(atCharacterLimit)), /1,000/);
  const multilineTitle = form(); multilineTitle.set("title", "标题\n第二行");
  await assert.rejects(readSubmission(await multipartRoundtrip(multilineTitle)), /不含换行/);
});

test("all images are validated before any writes and the raw images arrive in order", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  assert.deepEqual(Buffer.from(await input.images[0].blob.arrayBuffer()), png);
  await f.jobs.submit(input); await f.jobs.idle();
  const result = await f.jobs.get(input.id);
  assert.equal(result.status, "saved"); assert.equal(result.uploadedCount, 2);
  assert.equal(result.draftId, "wechat-draft-id");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["upload", "upload", "create", "verify"]);
  assert.deepEqual(f.calls[2][1], { title: input.title, body: input.body, imageMediaIds: ["image-1", "image-2"] });
  assert.equal("body" in result, false); assert.equal("imageMediaIds" in result, false);
});

test("a repeated ID is read back without a second upload or draft, including after restart", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  assert.equal((await f.jobs.submit(input)).status, "saved");
  const restarted = createJobService(f.options);
  assert.equal((await restarted.submit(input)).draftId, "wechat-draft-id");
  assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
  const different = form(input.id); different.set("body", "已更改");
  await assert.rejects(restarted.submit(await readSubmission(different)), (error) => error.status === 409);
});

test("a lost draft creation response remains uncertain and is never resubmitted", async (t) => {
  let creates = 0;
  const f = await fixture(t, { async createDraft() { creates++; throw new Error("upstream?access_token=private"); } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const result = await f.jobs.get(input.id);
  assert.equal(result.status, "needs_confirmation");
  assert.doesNotMatch(JSON.stringify(result), /access_token|private/);
  await f.jobs.submit(input); await f.jobs.verify(input.id);
  assert.equal(creates, 1);
});

test("interrupted durable creating record cannot create again after restart", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  record.status = "creating"; delete record.draftId;
  await writeFile(path, JSON.stringify(record));
  const restarted = createJobService(f.options);
  assert.equal((await restarted.submit(input)).status, "needs_confirmation");
  assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
});

test("readback failure preserves the returned draft ID and verify performs no writes to WeChat", async (t) => {
  let verified = false;
  const f = await fixture(t, { async verifyDraft() { return { verified, message: "配文未匹配" }; } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  assert.equal((await f.jobs.get(input.id)).status, "needs_confirmation");
  assert.equal((await f.jobs.get(input.id)).draftId, "wechat-draft-id");
  verified = true;
  assert.equal((await f.jobs.verify(input.id)).status, "saved");
  assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
});

test("two failed disk writes retain a known draft ID until verification can persist it", async (t) => {
  let diskFull = false, failedWrites = 0, creates = 0;
  const f = await fixture(t, {
    async createDraft() { creates++; diskFull = true; return "known-draft-before-disk-failure"; },
  });
  const input = await readSubmission(form());
  const originalOpen = fs.promises.open;
  // Inject a full disk only after WeChat has returned a real draft identifier.
  // Restoring ESM exports in finally keeps this fault local to the test.
  fs.promises.open = async (path, ...options) => {
    if (diskFull && String(path).startsWith(f.dataDir) && String(path).endsWith(".tmp")) {
      failedWrites++;
      const error = new Error("simulated full disk"); error.code = "ENOSPC"; throw error;
    }
    return originalOpen(path, ...options);
  };
  syncBuiltinESMExports();
  try {
    await f.jobs.submit(input); await f.jobs.idle();
    assert.equal(failedWrites, 2);
    const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
    const lastDurable = JSON.parse(await readFile(path, "utf8"));
    assert.equal(lastDurable.status, "creating");
    assert.equal(lastDurable.draftId, undefined);
    const retained = await f.jobs.get(input.id);
    assert.equal(retained.status, "needs_confirmation");
    assert.equal(retained.draftId, "known-draft-before-disk-failure");
    assert.match(retained.message, /磁盘/);
    assert.equal((await f.jobs.submit(input)).draftId, retained.draftId);
    assert.equal(creates, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "upload").length, 2);
    assert.equal(f.calls.filter(([kind]) => kind === "verify").length, 0);

    const stillUnpersisted = await f.jobs.verify(input.id);
    assert.equal(stillUnpersisted.status, "needs_confirmation");
    assert.match(stillUnpersisted.message, /磁盘/);
    assert.equal((await f.jobs.get(input.id)).draftId, retained.draftId);

    diskFull = false;
    const verified = await f.jobs.verify(input.id);
    assert.equal(verified.status, "saved");
    assert.equal(verified.draftId, retained.draftId);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.draftId, retained.draftId);
    assert.equal(persisted.status, "saved");
    const restarted = createJobService(f.options);
    assert.equal((await restarted.get(input.id)).draftId, retained.draftId);
    assert.equal((await restarted.submit(input)).status, "saved");
    assert.equal(creates, 1);
    assert.deepEqual(f.calls.map(([kind]) => kind), ["upload", "upload", "verify", "verify"]);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("concurrent different job submissions reserve only one upload before processing", async (t) => {
  let release, uploads = 0, creates = 0;
  const uploadGate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, {
    async uploadImage() { const index = ++uploads; await uploadGate; return `image-${index}`; },
    async createDraft() { creates++; return "one-concurrent-draft"; },
  });
  const first = await readSubmission(form()), second = await readSubmission(form());
  try {
    const results = await Promise.allSettled([f.jobs.submit(first), f.jobs.submit(second)]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.status, 409);
    assert.equal(uploads, 1);
    assert.equal(creates, 0);
    assert.equal((await f.jobs.get(first.id)).status, "uploading");
    await assert.rejects(f.jobs.get(second.id), (error) => error.status === 404);
  } finally {
    release();
    await f.jobs.idle();
  }
  assert.equal(uploads, 2);
  assert.equal(creates, 1);
  assert.equal((await f.jobs.get(first.id)).status, "saved");
  // Rejection did not poison the reservation queue or consume the next ID.
  await f.jobs.submit(second); await f.jobs.idle();
  assert.equal((await f.jobs.get(second.id)).status, "saved");
  assert.equal(creates, 2);
});

test("partial upload failure never creates an incomplete draft", async (t) => {
  let upload = 0, creates = 0;
  const f = await fixture(t, { async uploadImage() { if (++upload === 2) throw new Error(); return "one"; }, async createDraft() { creates++; } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const result = await f.jobs.get(input.id);
  assert.equal(result.status, "failed"); assert.equal(result.uploadedCount, 1); assert.equal(creates, 0);
});

test("changing the configured account after connection rejects before platform upload", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  await assert.rejects(f.jobs.submit({ ...input, expectedAccountId: "different-account" }), (error) => error.status === 409);
  assert.equal(f.calls.length, 0);
});

test("malformed image, excessive byte length and duplicate fields fail before submission", async () => {
  const malformed = form(); malformed.append("images", new Blob(["not a picture"], { type: "image/png" }), "wrong.png");
  await assert.rejects(readSubmission(malformed), /格式不符/);
  const oversized = form(); oversized.set("body", "中".repeat(683));
  await assert.rejects(readSubmission(oversized), /2,048/);
  const repeated = form(); repeated.append("title", "重复标题");
  await assert.rejects(readSubmission(repeated), /不完整/);
  const invalidId = form("../../override"); await assert.rejects(readSubmission(invalidId), /编号无效/);
});

test("HTTP service scopes every job to a connected account and requires a separate credential", async (t) => {
  const f = await fixture(t), syncToken = "test-only-connection-token-of-32-characters";
  const server = createWechatServer({ accounts: { deviceId: "device-fixture", get: (id) => { assert.equal(id, f.jobs.account.id); return { jobs: f.jobs }; } }, syncToken });
  // Execute the real HTTP callback with streams; no external account or network.
  const handler = server.listeners("request")[0];
  const base = `https://sync.example/api/wechat/accounts/${f.jobs.account.id}`;
  async function call(url, options) {
    const web = new Request(url, options);
    const body = Buffer.from(await web.arrayBuffer());
    const request = Readable.from(body.length ? [body] : []);
    request.url = new URL(url).pathname; request.method = web.method;
    request.headers = Object.fromEntries(web.headers);
    const response = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
    await handler(request, response);
    return { status: response.status, json: async () => JSON.parse(response.body) };
  }
  assert.equal((await call(`${base}/account`)).status, 401); assert.equal(f.calls.length, 0);
  const headers = { Authorization: `Bearer ${syncToken}` };
  const connection = await call("https://sync.example/api/wechat/connection", { headers });
  assert.equal((await connection.json()).deviceId, "device-fixture");
  assert.equal((await call(`${base}/publish`, { method: "POST", headers })).status, 404);
  const input = form();
  const response = await call(`${base}/jobs`, { method: "POST", headers, body: input });
  assert.equal(response.status, 202);
  const id = (await response.json()).job.id;
  await f.jobs.idle();
  assert.equal(f.calls.find(([kind]) => kind === "create")[1].body, input.get("body"));
  const read = await call(`${base}/jobs/${id}`, { headers });
  assert.equal((await read.json()).job.status, "saved");
});

test("HTTP preserves controlled WeChat errors as 424 without leaking secrets or retrying", async () => {
  const syncToken = "test-only-connection-token-of-32-characters";
  const secret = "fixture-secret-must-not-leak";
  for (const scenario of ["whitelist", "network", "internal", "spoofed-name"]) {
    let apiCalls = 0, connectionCalls = 0;
    const api = createWechatApi({ appId: "wx-fixture", appSecret: secret, fetchImpl: async () => {
      apiCalls++;
      if (scenario === "whitelist") return Response.json({ errcode: 40164, errmsg: `invalid ip 203.0.113.27, secret=${secret}, access_token=${syncToken}` });
      throw new Error(`https://api.weixin.qq.com/?access_token=${syncToken}&secret=${secret}`);
    } });
    const server = createWechatServer({ syncToken, accounts: { async connect() {
      connectionCalls++;
      if (scenario === "internal" || scenario === "spoofed-name") {
        const error = new Error(secret);
        if (scenario === "spoofed-name") error.name = "WechatApiError";
        throw error;
      }
      await api.checkConnection();
    } } });
    const request = Readable.from([Buffer.from("{}")]);
    Object.assign(request, { url: "/api/wechat/accounts/connect", method: "POST", headers: { authorization: `Bearer ${syncToken}`, "content-type": "application/json" } });
    const response = {
      headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) { this.body = body; },
    };
    // Exercise the real HTTP handler without opening a port or calling WeChat.
    await server.listeners("request")[0](request, response);
    const controlled = scenario === "whitelist" || scenario === "network";
    assert.equal(response.status, controlled ? 424 : 502, scenario);
    assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(response.headers["Cache-Control"], "no-store");
    const { error } = JSON.parse(response.body);
    if (scenario === "whitelist") {
      assert.match(error, /203\.0\.113\.27.*IP 白名单/u);
      assert.match(error, /40164/u);
    } else if (scenario === "network") assert.match(error, /不会自动重试/u);
    else assert.equal(error, "公众号同步暂未完成，请读取状态并核对草稿箱");
    for (const unsafe of [secret, syncToken, "https://", "access_token="]) assert.equal(response.body.includes(unsafe), false, scenario);
    assert.equal(connectionCalls, 1, scenario);
    assert.equal(apiCalls, controlled ? 1 : 0, scenario);
  }
});
