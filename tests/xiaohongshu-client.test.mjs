import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createWechatServer } from "../server/wechat/http.mjs";
import { createXhsHandler } from "../server/xiaohongshu/http.mjs";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { createXhsClient } = loadDomModule("lib/xiaohongshu/client.ts");
const id = "c3d82349-d1f0-4df8-a9b2-179ff36fd112", accountId = "0123456789abcdefabcd";
const job = (changes = {}) => ({ id, accountId, accountName: "测试账号", title: "小红书海报", imageCount: 2, uploadedCount: 0,
  status: "uploading", message: "图片正在上传", acknowledged: false, ...changes });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const input = { id, accountId, content: { title: "小红书独立标题", body: "第一段\n\n第三段\n" }, images: [
  { id: "first", name: "第1页.png", blob: new Blob([png], { type: "image/png" }), width: 1080, height: 1440 },
  { id: "second", name: "第2页.jpg", blob: new Blob([jpeg], { type: "image/jpeg" }), width: 1080, height: 1440 },
] };
const signal = () => new AbortController().signal;
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("XHS client sends complete originals in order and the exact account-bound multipart fields", async () => {
  const calls = [];
  const client = createXhsClient(" connection-secret ", async (url, options) => { calls.push({ url, options }); return reply({ job: job() }, 202); });
  assert.equal((await client.createJob(input, signal())).status, "uploading");
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, "/api/xiaohongshu/jobs"); assert.equal(options.method, "POST");
  assert.equal(options.body.get("id"), id); assert.equal(options.body.get("expectedAccountId"), accountId);
  assert.equal(options.body.get("title"), input.content.title); assert.equal(options.body.get("body"), input.content.body);
  const files = options.body.getAll("images");
  assert.deepEqual(files.map(({ name, type, size }) => ({ name, type, size })), [
    { name: "第1页.png", type: "image/png", size: png.length }, { name: "第2页.jpg", type: "image/jpeg", size: jpeg.length },
  ]);
  assert.deepEqual(await Promise.all(files.map(async (file) => Buffer.from(await file.arrayBuffer()))), [png, jpeg]);
  assert.deepEqual([...options.body.keys()], ["id", "expectedAccountId", "title", "body", "images", "images"]);
  assert.deepEqual(options.headers, { Authorization: "Bearer connection-secret" });
  assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "same-origin");
});

test("XHS account and job reads reject foreign identity and unsupported saved claims", async () => {
  for (const invalid of [job({ id: "another-job" }), job({ accountId: "another-account" }), job({ status: "saved" }),
    job({ status: "saved", draftId: "draft", uploadedCount: 1 }), job({ imageCount: 19 }), job({ uploadedCount: 3 }), job({ status: "published" }),
    job({ acknowledged: "true" }), job({ acknowledged: 1 })]) {
    await assert.rejects(createXhsClient("secret", async () => reply({ job: invalid })).getJob(id, accountId, signal()), /不一致/);
  }
  for (const invalid of [{ id: accountId }, { name: "只有名字" }, null]) {
    await assert.rejects(createXhsClient("secret", async () => reply({ account: invalid })).getAccount(signal()), /尚未识别/);
  }
});

test("a lost XHS create reply reads the original ID once without repeating POST", async () => {
  const calls = [];
  const client = createXhsClient("secret", async (url, options) => {
    calls.push([options.method, url]);
    if (options.method === "POST") throw new TypeError("network response lost");
    return reply({ job: job({ status: "saved", uploadedCount: 2, draftId: "draft-one" }) });
  });
  assert.equal((await client.createJob(input, signal())).draftId, "draft-one");
  assert.deepEqual(calls, [["POST", "/api/xiaohongshu/jobs"], ["GET", `/api/xiaohongshu/jobs/${id}`]]);
});

test("missing, foreign-job and foreign-account recovery replies stay unconfirmed", async () => {
  for (const response of [() => reply({ error: "任务不存在" }, 404), () => reply({ job: job({ id: "wrong-job" }) }), () => reply({ job: job({ accountId: "wrong-account" }) })]) {
    const calls = [];
    const client = createXhsClient("secret", async (url, options) => {
      calls.push([options.method, url]);
      if (options.method === "POST") throw new Error("lost");
      return response();
    });
    await assert.rejects(client.createJob(input, signal()), /尚未确认/);
    assert.deepEqual(calls, [["POST", "/api/xiaohongshu/jobs"], ["GET", `/api/xiaohongshu/jobs/${id}`]]);
  }
});

test("aborting XHS upload does not trigger recovery GET or a second upload", async () => {
  const controller = new AbortController(), calls = [];
  const client = createXhsClient("secret", async (url, options) => {
    calls.push([options.method, url]);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  });
  const waiting = client.createJob(input, controller.signal);
  controller.abort(new Error("窗口已关闭"));
  await assert.rejects(waiting, /窗口已关闭/);
  assert.deepEqual(calls, [["POST", "/api/xiaohongshu/jobs"]]);
});

test("already-aborted XHS operations never issue a network request", async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error("任务已取消"));
  const client = createXhsClient("secret", async () => { calls++; return reply({}); });
  for (const start of [() => client.getAccount(controller.signal), () => client.openLogin(controller.signal),
    () => client.createJob(input, controller.signal), () => client.getJob(id, accountId, controller.signal),
    () => client.verifyJob(id, accountId, controller.signal), () => client.acknowledgeJob(id, accountId, controller.signal)]) {
    await assert.rejects(start(), /任务已取消/);
  }
  assert.equal(calls, 0);
});

test("XHS acknowledge sends only confirm true and retains the unverified status", async () => {
  const calls = [];
  const client = createXhsClient("secret", async (url, options) => { calls.push({ url, options }); return reply({ job: job({ status: "needs_confirmation", acknowledged: true }) }); });
  const result = await client.acknowledgeJob(id, accountId, signal());
  assert.equal(result.status, "needs_confirmation"); assert.equal(result.acknowledged, true);
  assert.equal(calls[0].url, `/api/xiaohongshu/jobs/${id}/acknowledge`); assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { confirm: true });
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  await client.verifyJob(id, accountId, signal());
  assert.equal(calls[1].url, `/api/xiaohongshu/jobs/${id}/verify`); assert.equal(calls[1].options.body, undefined);
});

test("XHS polling stops before another read after the total deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let calls = 0;
  const client = createXhsClient("secret", async () => { calls++; return reply({ job: job() }); });
  const waiting = client.waitForJob(job(), signal(), () => {});
  t.mock.timers.tick(90_000);
  assert.equal((await waiting).status, "uploading");
  assert.equal(calls, 0, "deadline expiry must not begin another request with a fresh network timeout");
});

test("aborting while XHS polling sleeps starts no read and terminal states do not poll", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const controller = new AbortController(); let calls = 0;
  const client = createXhsClient("secret", async () => { calls++; return reply({ job: job() }); });
  const waiting = client.waitForJob(job(), controller.signal, () => {});
  controller.abort(new Error("取消等待")); await assert.rejects(waiting, /取消等待/);
  for (const status of ["saved", "needs_confirmation", "failed"]) {
    const terminal = job({ status }); assert.equal(await client.waitForJob(terminal, signal(), () => {}), terminal);
  }
  assert.equal(calls, 0);
});

test("shared HTTP authorization happens before the XHS login side effect", async () => {
  let opened = 0, dispatched = 0;
  const syncToken = "a".repeat(32), handler = createXhsHandler({ service: { async openLogin() { opened++; } } });
  const server = createWechatServer({ accounts: {}, syncToken, handleXhs: async (...args) => { dispatched++; return handler(...args); } });
  async function issue(authorization) {
    const request = Readable.from([]); request.url = "/api/xiaohongshu/login"; request.method = "POST"; request.socket = { localPort: 8788 }; request.headers = { host: "127.0.0.1:8788", authorization };
    const result = Promise.withResolvers(); let status;
    const response = { headersSent: false, writeHead(value) { status = value; this.headersSent = true; }, end(body) { result.resolve({ status, body: JSON.parse(body) }); } };
    server.emit("request", request, response);
    return result.promise;
  }
  assert.equal((await issue(undefined)).status, 401); assert.equal((await issue("Bearer wrong")).status, 401);
  assert.equal(dispatched, 0); assert.equal(opened, 0);
  const result = await issue(`Bearer ${syncToken}`);
  assert.equal(result.status, 200); assert.deepEqual(result.body, { opened: true }); assert.equal(dispatched, 1); assert.equal(opened, 1);
});
