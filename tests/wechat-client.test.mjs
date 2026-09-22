import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { createWechatClient, WechatUnconfirmedError } = loadDomModule("lib/wechat/client.ts");
const id = "76f6dbe5-a12d-4fe2-8ee7-35e6e988ab8e";
const accountId = "account-a";
const job = (change = {}) => ({ id, accountId, accountName: "测试公众号", title: "标题", imageCount: 2, uploadedCount: 0, status: "uploading", message: "上传中", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", ...change });
const input = { id, accountId, content: { title: "标题", body: "多图短文\n第二行" }, images: ["first", "second"].map((bytes, index) => ({ id: String(index), name: `${index + 1}.png`, blob: new Blob([bytes], { type: "image/png" }), width: 1080, height: 1350 })) };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const signal = () => new AbortController().signal;

test("connection checks are read-only and credentials stay in the Authorization header", async () => {
  const calls = [];
  const client = createWechatClient(" connection-password ", async (url, options) => { calls.push({ url, options }); return reply({ account: { id: accountId, name: "测试公众号" } }); });
  assert.deepEqual(await client.getAccount(signal()), { id: accountId, name: "测试公众号" });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/wechat/account");
  assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(calls[0].options.headers, { Authorization: "Bearer connection-password" });
  assert.equal(calls[0].options.redirect, "error");
  await assert.rejects(createWechatClient("pass", async () => reply({ error: "公众号同步服务尚未配置" }, 503)).getAccount(signal()), /尚未配置/);
});

test("create sends complete original images in order and exact independent copy once", async () => {
  const calls = [];
  const client = createWechatClient("pass", async (url, options) => { calls.push({ url, options }); return reply({ job: job() }, 202); });
  const actual = await client.createJob(input, signal());
  assert.equal(actual.status, "uploading"); assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, "/api/wechat/jobs"); assert.equal(options.method, "POST");
  assert.equal(options.body.get("id"), id); assert.equal(options.body.get("title"), input.content.title); assert.equal(options.body.get("body"), input.content.body);
  assert.equal(options.body.get("expectedAccountId"), accountId, "uploads must be pinned to the account the user checked");
  const images = options.body.getAll("images");
  assert.deepEqual(images.map((image) => image.name), ["1.png", "2.png"]);
  assert.deepEqual(await Promise.all(images.map((image) => image.text())), ["first", "second"]);
  assert.deepEqual([...options.body.keys()], ["id", "expectedAccountId", "title", "body", "images", "images"]);
});

test("a lost create response reads the persisted identity once without a second POST", async () => {
  const calls = [];
  const client = createWechatClient("pass", async (url, options) => {
    calls.push([options.method, url]);
    if (options.method === "POST") throw new TypeError("network lost");
    return reply({ job: job({ status: "saved", uploadedCount: 2, draftId: "wechat-draft" }) });
  });
  const result = await client.createJob(input, signal());
  assert.equal(result.draftId, "wechat-draft");
  assert.deepEqual(calls, [["POST", "/api/wechat/jobs"], ["GET", `/api/wechat/jobs/${id}`]]);
});

test("missing or different-account readback never turns an uncertain create into success", async () => {
  for (const response of [() => reply({ error: "任务不存在" }, 404), () => reply({ job: job({ accountId: "wrong-account" }) })]) {
    let posts = 0, reads = 0;
    const client = createWechatClient("pass", async (_url, options) => {
      if (options.method === "POST") { posts++; throw new Error("connection lost"); }
      reads++; return response();
    });
    await assert.rejects(client.createJob(input, signal()), WechatUnconfirmedError);
    assert.equal(posts, 1); assert.equal(reads, 1);
  }
});

test("aborting while sending stops waiting without an automatic status request or repeat create", async () => {
  const controller = new AbortController(); let calls = 0;
  const client = createWechatClient("pass", async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  });
  const pending = client.createJob(input, controller.signal);
  controller.abort(new Error("窗口已关闭"));
  await assert.rejects(pending, /窗口已关闭/); assert.equal(calls, 1);
});

test("readback requires a platform draft ID and complete upload count for a saved claim", async () => {
  for (const invalid of [job({ status: "saved" }), job({ status: "saved", draftId: "draft", uploadedCount: 1 })]) {
    const client = createWechatClient("pass", async () => reply({ job: invalid }));
    await assert.rejects(client.getJob(id, accountId, signal()), /信息不一致/);
  }
  const requests = [];
  const client = createWechatClient("pass", async (url, options) => { requests.push([url, options.method, options.body]); return reply({ job: job({ status: "saved", uploadedCount: 2, draftId: "draft" }) }); });
  await client.verifyJob(id, accountId, signal());
  assert.deepEqual(requests, [[`/api/wechat/jobs/${id}/verify`, "POST", undefined]]);
});

test("polling stops at its deadline and retains an unfinished task for manual reading", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let calls = 0;
  const client = createWechatClient("pass", async () => { calls++; return reply({ job: job() }); });
  const waiting = client.waitForJob(job(), signal(), () => {}, 20);
  context.mock.timers.tick(20);
  const result = await waiting;
  assert.equal(result.id, id); assert.equal(result.status, "uploading"); assert.equal(calls, 0);
  const saved = job({ status: "saved", uploadedCount: 2, draftId: "draft" });
  assert.equal(await client.waitForJob(saved, signal(), () => {}), saved); assert.equal(calls, 0);
});
