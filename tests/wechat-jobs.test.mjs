import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createWechatApi, WechatApiError } from "../lib/wechat/api.mjs";
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

test("cover readback is stored only in the local job and never upgrades content verification", async (t) => {
  const crop = { ratio: "3_4", x1: 0, y1: 0, x2: 1, y2: 1 };
  const coverInfo = { crop_percent_list: [crop] };
  const coverSource = { thumbMediaId: "image-1", firstImageMediaId: "image-1", isFirstImage: true,
    articleFieldNames: ["thumb_media_id", "image_info"], coverFieldNames: ["crop_percent_list"] };
  let verified = true;
  const f = await fixture(t, { async verifyDraft() { return { verified, message: "内容需核对",
    verificationMismatches: verified ? [] : ["title"],
    coverSource: { ...coverSource, isFirstImage: false, thumb_url: "private-cover-url" },
    coverInfo: { thumb_url: "private-cover-url", crop_percent_list: [{ ...crop, unexpected: "private-value" }] } }; } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(record.coverInfo, coverInfo);
  assert.deepEqual(record.coverSource, coverSource);
  assert.deepEqual(record.verificationMismatches, []);
  assert.equal(record.status, "saved");
  assert.doesNotMatch(JSON.stringify(record), /private-cover-url|private-value|thumb_url|unexpected/);
  const restarted = createJobService(f.options);
  for (const result of [await f.jobs.get(input.id), await restarted.get(input.id), await restarted.submit(input)]) {
    assert.equal(Object.hasOwn(result, "coverInfo"), false);
    assert.equal(Object.hasOwn(result, "coverSource"), false);
    assert.equal(Object.hasOwn(result, "verificationMismatches"), false);
    assert.equal(result.status, "saved");
  }
  verified = false;
  const result = await restarted.verify(input.id);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(Object.hasOwn(result, "coverInfo"), false);
  assert.equal(Object.hasOwn(result, "coverSource"), false);
  assert.equal(Object.hasOwn(result, "verificationMismatches"), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).coverInfo, coverInfo);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).coverSource, coverSource);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).verificationMismatches, ["title"]);
  assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "upload").length, 2);
});

test("missing, invalid or failed cover readback removes stale local diagnostics", async (t) => {
  const valid = { crop_percent_list: [{ ratio: "3_4", x1: 0, y1: 0, x2: 1, y2: 1 }] };
  const validSource = { thumbMediaId: "image-1", firstImageMediaId: "image-1", isFirstImage: true, articleFieldNames: [], coverFieldNames: [] };
  let next = { verified: true, coverInfo: valid, coverSource: validSource, verificationMismatches: [] };
  const f = await fixture(t, { async verifyDraft() { if (next instanceof Error) throw next; return next; } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
  for (const result of [{ verified: true }, { verified: true, coverInfo: { crop_percent_list: [{ ratio: "3_4", x1: 0 }] }, coverSource: { articleFieldNames: "invalid" }, verificationMismatches: ["private-body"] }, new Error("upstream unavailable")]) {
    next = { verified: true, coverInfo: valid, coverSource: validSource, verificationMismatches: [] };
    await f.jobs.verify(input.id);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).coverInfo, valid);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).coverSource, validSource);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).verificationMismatches, []);
    next = result;
    const publicResult = await f.jobs.verify(input.id);
    assert.equal(publicResult.status, result instanceof Error ? "needs_confirmation" : "saved");
    assert.equal(Object.hasOwn(publicResult, "coverInfo"), false);
    assert.equal(Object.hasOwn(publicResult, "coverSource"), false);
    assert.equal(Object.hasOwn(publicResult, "verificationMismatches"), false);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")), "coverInfo"), false);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")), "coverSource"), false);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")), "verificationMismatches"), false);
  }
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
    request.socket = { localPort: 8788 }; request.headers = { host: "127.0.0.1:8788", ...Object.fromEntries(web.headers) };
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
    Object.assign(request, { url: "/api/wechat/accounts/connect", method: "POST", socket: { localPort: 8788 }, headers: { host: "127.0.0.1:8788", authorization: `Bearer ${syncToken}`, "content-type": "application/json" } });
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
    } else if (scenario === "network") assert.match(error, /调用凭据.*检查连接/u);
    else assert.equal(error, "公众号同步暂未完成，请读取状态并核对草稿箱");
    for (const unsafe of [secret, syncToken, "https://", "access_token="]) assert.equal(response.body.includes(unsafe), false, scenario);
    assert.equal(connectionCalls, 1, scenario);
    assert.equal(apiCalls, controlled ? 1 : 0, scenario);
  }
});

test("controlled upload and creation refusals preserve whitelist guidance and allow a new job after repair", async (t) => {
  for (const stage of ["upload", "create", "token"]) {
    const f = await fixture(t);
    const method = stage === "upload" ? "uploadImage" : "createDraft";
    const original = f.api[method];
    let blocked = true;
    f.api[method] = async (...args) => {
      if (blocked) throw new WechatApiError("请将出口 IPv4 203.0.113.27 加入公众号 IP 白名单（错误码 40164）。",
        { outcome: stage === "token" ? "not_submitted" : "rejected", errcode: 40164 });
      return original(...args);
    };
    const input = await readSubmission(form());
    await f.jobs.submit(input); await f.jobs.idle();
    const rejected = await f.jobs.get(input.id);
    assert.equal(rejected.status, "failed", stage);
    assert.equal(rejected.draftId, undefined);
    assert.match(rejected.message, /203\.0\.113\.27.*40164/u);
    if (stage === "token") assert.match(rejected.message, /请求尚未发出/u);
    assert.equal(f.calls.filter(([kind]) => kind === "create").length, 0);
    blocked = false;
    assert.equal((await f.jobs.submit(input)).status, "failed");
    const retry = await readSubmission(form());
    await f.jobs.submit(retry); await f.jobs.idle();
    assert.equal((await f.jobs.get(retry.id)).status, "saved");
    assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
  }
});

test("restarting during uploads confirms no draft exists without replaying any platform write", async (t) => {
  for (const uploadedCount of [0, 1, 2]) {
    const f = await fixture(t), input = await readSubmission(form());
    await f.jobs.submit(input); await f.jobs.idle();
    const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    Object.assign(record, { status: "uploading", uploadedCount, imageMediaIds: record.imageMediaIds.slice(0, uploadedCount) });
    delete record.draftId;
    await writeFile(path, JSON.stringify(record));
    const before = f.calls.length, restarted = createJobService(f.options);
    for (const result of [await restarted.get(input.id), await restarted.submit(input), await restarted.verify(input.id)]) {
      assert.equal(result.status, "failed");
      assert.equal(result.draftId, undefined);
      assert.equal(result.uploadedCount, uploadedCount);
      assert.match(result.message, /尚未创建草稿/u);
    }
    assert.equal(f.calls.length, before);
  }
});

test("controlled readback failures retain the known draft and useful reason across restart", async (t) => {
  for (const outcome of ["rejected", "not_submitted", "uncertain"]) {
    let blocked = true;
    const f = await fixture(t, { async verifyDraft() {
      if (blocked) throw new WechatApiError("请将 203.0.113.27 加入白名单（错误码 40164）。", { outcome, errcode: 40164 });
      return { verified: true };
    } });
    const input = await readSubmission(form());
    await f.jobs.submit(input); await f.jobs.idle();
    const restarted = createJobService(f.options);
    for (const result of [await f.jobs.get(input.id), await restarted.verify(input.id)]) {
      assert.equal(result.status, "needs_confirmation");
      assert.equal(result.draftId, "wechat-draft-id");
      assert.match(result.message, /已返回草稿编号.*203\.0\.113\.27.*40164/u);
      assert.doesNotMatch(result.message, /未创建|拒绝创建/u);
    }
    await assert.rejects(restarted.resolve(input.id), (error) => error.status === 409);
    blocked = false;
    assert.equal((await restarted.verify(input.id)).status, "saved");
    assert.equal(f.calls.filter(([kind]) => kind === "create").length, 1);
  }
});

test("confirming an absent draft ends the original record durably without replaying its ID", async (t) => {
  let creates = 0;
  const f = await fixture(t, { async createDraft() { creates++; throw new Error("lost response"); } });
  const input = await readSubmission(form());
  await f.jobs.submit(input); await f.jobs.idle();
  const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
  const previous = JSON.parse(await readFile(path, "utf8"));
  const retry = await readSubmission(form());
  await assert.rejects(f.jobs.submit(retry), (error) => error.status === 409);
  await assert.rejects(readFile(join(f.dataDir, f.jobs.account.id, retry.id, "job.json")), (error) => error.code === "ENOENT");
  assert.equal(creates, 1);
  const expected = { jobId: input.id, accountId: f.jobs.account.id, confirmedNoDraft: true };
  assert.deepEqual(await f.jobs.resolve(input.id), expected);
  const resolved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(resolved.resolution, "confirmed_absent");
  assert.equal(resolved.status, "failed");
  for (const field of ["body", "title", "fingerprint", "imageMediaIds", "createdAt"]) assert.deepEqual(resolved[field], previous[field]);
  const restarted = createJobService(f.options);
  assert.deepEqual(await restarted.resolve(input.id), expected);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), resolved);
  assert.equal((await restarted.submit(input)).status, "failed");
  assert.equal((await restarted.verify(input.id)).status, "failed");
  assert.equal(creates, 1);
  f.api.createDraft = async () => { creates++; return "new-draft"; };
  await restarted.submit(retry); await restarted.idle();
  assert.equal((await restarted.get(retry.id)).status, "saved");
  assert.equal(creates, 2);
});

test("recovering storage persists a retained whitelist failure before admitting the same content again", async (t) => {
  let diskFull = false, blocked = true;
  const f = await fixture(t, { async createDraft() {
    if (blocked) {
      diskFull = true;
      throw new WechatApiError("请将 203.0.113.27 加入白名单（错误码 40164）。", { outcome: "rejected", errcode: 40164 });
    }
    return "recovered-draft";
  } });
  const original = fs.promises.open;
  fs.promises.open = async (path, ...args) => {
    if (diskFull && String(path).startsWith(f.dataDir) && String(path).endsWith(".tmp")) throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const input = await readSubmission(form());
    await f.jobs.submit(input); await f.jobs.idle();
    const retained = await f.jobs.get(input.id);
    assert.equal(retained.status, "failed");
    assert.match(retained.message, /203\.0\.113\.27.*40164.*磁盘/u);
    const path = join(f.dataDir, f.jobs.account.id, input.id, "job.json");
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "creating");
    diskFull = false; blocked = false;
    const retry = await readSubmission(form());
    await f.jobs.submit(retry); await f.jobs.idle();
    assert.equal((await f.jobs.get(retry.id)).status, "saved");
    assert.equal(JSON.parse(await readFile(path, "utf8")).status, "failed");
    assert.equal((await createJobService(f.options).get(input.id)).status, "failed");
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
  }
});

test("missing or interrupted records get a tombstone that rejects late submission after restart", async (t) => {
  for (const reservedDirectory of [false, true]) {
    const f = await fixture(t), input = await readSubmission(form());
    const path = join(f.dataDir, f.jobs.account.id, input.id);
    if (reservedDirectory) await mkdir(path, { recursive: true });
    const ack = await f.jobs.resolve(input.id);
    assert.deepEqual(ack, { jobId: input.id, accountId: f.jobs.account.id, confirmedNoDraft: true });
    const tombstone = JSON.parse(await readFile(join(path, "job.json"), "utf8"));
    assert.equal(tombstone.resolution, "confirmed_absent");
    assert.equal(tombstone.imageMediaIds, undefined);
    const restarted = createJobService(f.options);
    assert.deepEqual(await restarted.resolve(input.id), ack);
    for (const service of [f.jobs, restarted]) {
      await assert.rejects(service.get(input.id), (error) => error.status === 410);
      await assert.rejects(service.verify(input.id), (error) => error.status === 410);
      await assert.rejects(service.submit(input), (error) => error.status === 410);
    }
    assert.equal(f.calls.length, 0);
  }
});

test("resolve rejects known drafts, every publication record and an in-flight publication attempt", async (t) => {
  const saved = await fixture(t), input = await readSubmission(form());
  await saved.jobs.submit(input); await saved.jobs.idle();
  await assert.rejects(saved.jobs.resolve(input.id), (error) => error.status === 409);
  for (const publication of ["", "broken publication record", JSON.stringify({ status: "failed" })]) {
    const f = await fixture(t), id = randomUUID();
    const path = join(f.dataDir, f.jobs.account.id, id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "publication.json"), publication);
    await assert.rejects(f.jobs.resolve(id), (error) => error.status === 409);
    await assert.rejects(readFile(join(path, "job.json")), (error) => error.code === "ENOENT");
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t), id = randomUUID();
  const release = f.jobs.beginPublication(id);
  assert.equal(f.jobs.busy(), true);
  await assert.rejects(f.jobs.resolve(id), (error) => error.status === 409);
  release(); release();
  assert.equal(f.jobs.busy(), false);
  assert.equal((await f.jobs.resolve(id)).confirmedNoDraft, true);
});

test("resolve and late submission serialize while an active upload rejects resolution", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  const results = await Promise.allSettled([f.jobs.resolve(input.id), f.jobs.submit(input), f.jobs.resolve(input.id)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 410);
  assert.deepEqual(results[2].value, results[0].value);
  assert.equal(f.calls.length, 0);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const uploading = await fixture(t, { async uploadImage() { await gate; return "image"; } });
  const activeInput = await readSubmission(form());
  await uploading.jobs.submit(activeInput);
  try {
    await assert.rejects(uploading.jobs.resolve(activeInput.id), (error) => error.status === 409);
    await assert.rejects(uploading.jobs.resolve(randomUUID()), (error) => error.status === 409);
  } finally { release(); await uploading.jobs.idle(); }
  assert.equal((await uploading.jobs.get(activeInput.id)).status, "saved");
});

test("the resolution lock prevents publication before its first filesystem await", async (t) => {
  const f = await fixture(t), id = randomUUID();
  const original = fs.promises.lstat;
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  fs.promises.lstat = async (...args) => {
    if (String(args[0]).startsWith(f.dataDir)) { entered(); await gate; }
    return original(...args);
  };
  syncBuiltinESMExports();
  let resolving;
  try {
    resolving = f.jobs.resolve(id);
    await ready;
    assert.equal(f.jobs.busy(), true);
    assert.throws(() => f.jobs.beginPublication(id), (error) => error.status === 409);
  } finally {
    release();
    await resolving;
    fs.promises.lstat = original;
    syncBuiltinESMExports();
  }
  assert.equal(f.jobs.busy(), false);
  assert.equal(f.calls.length, 0);
});

test("HTTP resolve requires exact confirmation and returns durable account-scoped acknowledgement", async (t) => {
  const f = await fixture(t), id = randomUUID(), syncToken = "test-only-connection-token-of-32-characters";
  let publicationBusy = false;
  const server = createWechatServer({ syncToken, accounts: { get(accountId) {
    assert.equal(accountId, f.jobs.account.id);
    return { jobs: f.jobs, publications: { busy: () => publicationBusy } };
  } } });
  async function call(body, method = "POST") {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { url: `/api/wechat/accounts/${f.jobs.account.id}/jobs/${id}${method === "POST" ? "/resolve" : ""}`,
      method, socket: { localPort: 8788 }, headers: { host: "127.0.0.1:8788", authorization: `Bearer ${syncToken}`, "content-type": "application/json" } });
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(value) { this.body = JSON.parse(value); } };
    await server.listeners("request")[0](request, response);
    return response;
  }
  for (const body of [undefined, null, {}, { confirmNoDraft: false }, { confirmNoDraft: true, extra: true }]) assert.equal((await call(body)).status, 400);
  publicationBusy = true;
  assert.equal((await call({ confirmNoDraft: true })).status, 409);
  publicationBusy = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call({ confirmNoDraft: true });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { resolution: { jobId: id, accountId: f.jobs.account.id, confirmedNoDraft: true } });
  }
  assert.equal((await call(undefined, "GET")).status, 410);
  assert.equal(f.calls.length, 0);
});
