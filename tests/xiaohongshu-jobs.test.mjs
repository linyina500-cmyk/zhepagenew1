import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createXhsService, readSubmission } from "../server/xiaohongshu/jobs.mjs";
import { createXhsHandler } from "../server/xiaohongshu/http.mjs";
import { XhsDriverError } from "../server/xiaohongshu/driver.mjs";

const account = { id: "0123456789abcdefabcd", name: "本机测试账号" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
function form(id = randomUUID()) {
  const result = new FormData();
  result.set("id", id); result.set("title", "两页测试海报"); result.set("body", "第一段\n\n第三段\n"); result.set("expectedAccountId", account.id);
  result.append("images", new Blob([png], { type: "image/png" }), "原文件.png");
  result.append("images", new Blob([jpeg], { type: "image/jpeg" }), "另一张.jpg");
  return result;
}
const reference = () => ({ kind: "local", id: "draft-fixture", images: [`pixels:1080x1440:${"1".repeat(64)}`, `pixels:1080x1440:${"2".repeat(64)}`] });
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-jobs-")), calls = [];
  const driver = {
    async checkConnection() { return { status: "connected", account }; },
    async openLogin() { calls.push(["login"]); return { status: "login_required" }; },
    async prepare(input) {
      calls.push(["prepare", input]);
      await input.onProgress(1); await input.onProgress(2);
      return { jobId: input.jobId, images: reference().images };
    },
    async saveDraft(input) { calls.push(["save", input]); return { draftId: "draft-fixture", draftRef: reference() }; },
    async verifyDraft(input) { calls.push(["verify", input]); return { verified: true }; },
    async close() { calls.push(["close"]); },
    ...overrides,
  };
  const service = await createXhsService({ dataDir, driver });
  let current = service;
  t.after(async () => { await current.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, driver, calls, service, async restart() { await current.close(); current = await createXhsService({ dataDir, driver }); return current; } };
}

test("raw original images and multipart line breaks reach the driver without truncation", async (t) => {
  const f = await fixture(t), source = form();
  const wire = new Request("http://local.test/jobs", { method: "POST", body: source });
  const multipart = await new Response(await wire.arrayBuffer(), { headers: wire.headers }).formData();
  assert.equal(multipart.get("body"), "第一段\r\n\r\n第三段\r\n");
  const input = await readSubmission(multipart);
  assert.equal(input.fingerprint, (await readSubmission(source)).fingerprint);
  assert.deepEqual(await f.service.checkConnection(), account);
  await f.service.submit(input); await f.service.idle();
  const result = await f.service.get(input.id);
  assert.equal(result.status, "saved"); assert.equal(result.uploadedCount, 2);
  const prepared = f.calls.find(([action]) => action === "prepare")[1];
  assert.deepEqual(await readFile(prepared.images[0].path), png);
  assert.deepEqual(await readFile(prepared.images[1].path), jpeg);
  assert.equal(prepared.body, "第一段\n\n第三段\n");
  assert.deepEqual(prepared.images.map(({ name, mime }) => ({ name, mime })), [{ name: "poster-1.png", mime: "image/png" }, { name: "poster-2.jpg", mime: "image/jpeg" }]);
  assert.equal("body" in result, false); assert.equal("images" in result, false); assert.equal("draftRef" in result, false);
  assert.deepEqual(f.calls.map(([action]) => action), ["prepare", "save", "verify"]);
});

test("repeated IDs including after restart never upload or save again", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  assert.equal((await f.service.submit(input)).status, "saved");
  const next = await f.restart();
  assert.equal((await next.submit(input)).status, "saved");
  assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
  const changed = form(input.id); changed.set("title", "另一组标题");
  await assert.rejects(next.submit(await readSubmission(changed)), (error) => error.status === 409);
});

test("automatic readback remains pollable until verification finishes", async (t) => {
  let resume, entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const verifying = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { async verifyDraft(input) {
    f.calls.push(["verify", input]); entered(); await gate; return { verified: true };
  } });
  const input = await readSubmission(form());
  try {
    await f.service.submit(input); await verifying;
    for (let attempt = 0; attempt < 2; attempt++) {
      const progress = await f.service.get(input.id);
      assert.equal(progress.status, "creating", "the client must keep polling during automatic readback");
      assert.equal(progress.uploadedCount, 2);
      assert.equal(progress.draftId, "draft-fixture");
      assert.match(progress.message, /正在重新打开草稿核对/u);
    }
    const durable = JSON.parse(await readFile(join(f.dataDir, "jobs", input.id, "job.json"), "utf8"));
    assert.equal(durable.status, "creating");
    assert.deepEqual(durable.draftRef, reference());
    assert.equal((await f.service.submit(input)).status, "creating");
    await assert.rejects(f.service.acknowledge(input.id), (error) => error.status === 409);
  } finally { resume(); await f.service.idle(); }
  assert.equal((await f.service.get(input.id)).status, "saved");
  assert.deepEqual(f.calls.map(([action]) => action), ["prepare", "save", "verify"]);
});

test("submission checks the binding once and passes the recorded identity to each driver's fresh boundary check", async (t) => {
  let checks = 0;
  const f = await fixture(t, { async checkConnection() { checks++; return { status: "connected", account }; } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  assert.equal(checks, 1, "run and automatic verification must not repeat the admission check");
  assert.deepEqual(f.calls.find(([action]) => action === "prepare")[1].account, account);
  assert.deepEqual(f.calls.find(([action]) => action === "verify")[1].account, account);
  await f.service.verify(input.id);
  assert.equal(checks, 1, "manual verification delegates fresh identity validation to the driver");
  assert.deepEqual(f.calls.filter(([action]) => action === "verify").at(-1)[1].account, account);
  assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
});

test("submission still rejects an account switch after the user connected", async (t) => {
  let current = account;
  const f = await fixture(t, { async checkConnection() { return { status: "connected", account: current }; } });
  await f.service.checkConnection();
  current = { ...account, id: "abcdef0123456789abcd" };
  await assert.rejects(f.service.submit(await readSubmission(form())), /绑定不一致/u);
  assert.equal(f.calls.filter(([action]) => ["prepare", "save", "verify"].includes(action)).length, 0);
});

test("missing account identity stops before uploads and never binds a guessed name", async (t) => {
  const f = await fixture(t, { async checkConnection() { return { status: "connected", account: { name: "只有昵称" } }; } });
  await assert.rejects(f.service.checkConnection(), (error) => error.status === 409);
  await assert.rejects(f.service.submit(await readSubmission(form())), (error) => error.status === 409);
  assert.deepEqual(f.calls, []);
});

test("login-required and unrecognized identity show distinct controlled messages", async (t) => {
  let status = "login_required";
  const f = await fixture(t, { async checkConnection() { return { status, message: "untrusted?cookie=secret" }; } });
  await assert.rejects(f.service.checkConnection(), (error) => error.status === 409 && /当前显示登录页/.test(error.message) && /扫码登录/.test(error.message));
  status = "needs_attention";
  await assert.rejects(f.service.checkConnection(), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /稳定的小红书账号标识/);
    assert.match(error.message, /请勿重复扫码/);
    assert.doesNotMatch(error.message, /完成登录|cookie|secret/);
    return true;
  });
  assert.deepEqual(f.calls, []);
});

test("profile remains bound to the same account after restart", async (t) => {
  let current = account;
  const f = await fixture(t, { async checkConnection() { return { status: "connected", account: current }; } });
  await f.service.checkConnection();
  const next = await f.restart();
  current = { ...account, id: "abcdef0123456789abcd" };
  await assert.rejects(next.checkConnection(), (error) => error.status === 409);
});

test("login recovery reports controlled causes without forwarding page data", async (t) => {
  for (const [reason, expected] of [["login_page_unavailable", /登录页未正常加载/], ["editor_in_use", /未完成的编辑/]]) {
    const f = await fixture(t, { async openLogin() { return { status: "needs_attention", reason, message: "private?cookie=secret" }; } });
    const result = await f.service.openLogin();
    assert.equal(result.status, "needs_attention");
    assert.match(result.message, expected);
    assert.doesNotMatch(result.message, /private|cookie|secret/);
    assert.deepEqual(f.calls, []);
  }
});

test("missing or incomplete save receipts cannot become saved even if driver verification says true", async (t) => {
  for (const receipt of [{}, { draftId: "draft-fixture", draftRef: { ...reference(), images: [] } },
    { draftId: "draft-fixture", draftRef: { ...reference(), images: [null, null] } },
    { draftId: "different", draftRef: reference() },
    { draftId: "draft-fixture", draftRef: { ...reference(), kind: "remote" } },
    { draftId: "invalid/id", draftRef: { ...reference(), id: "invalid/id" } },
    { draftId: "draft-fixture", draftRef: { ...reference(), images: ["blob:https://creator.xiaohongshu.com/first", "https://cdn.example/second"] } },
    { draftId: "draft-fixture", draftRef: { id: "draft-fixture", url: "https://creator.xiaohongshu.com/publish/publish?target=image&draft_id=draft-fixture", images: reference().images } }]) {
    await t.test(JSON.stringify(receipt), async (t) => {
      const f = await fixture(t, { async saveDraft() { f.calls.push(["save"]); return receipt; } });
      const input = await readSubmission(form());
      await f.service.submit(input); await f.service.idle();
      assert.equal((await f.service.get(input.id)).status, "needs_confirmation");
      await f.service.verify(input.id);
      assert.equal(f.calls.filter(([action]) => action === "verify").length, 0);
      assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
    });
  }
});

test("unknown save result blocks replays and fresh IDs, without leaking raw errors", async (t) => {
  let saves = 0;
  const f = await fixture(t, { async saveDraft() { saves++; throw new Error("secret cookie invalid"); } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  const job = await f.service.get(input.id);
  assert.equal(job.status, "needs_confirmation"); assert.doesNotMatch(JSON.stringify(job), /secret|cookie/);
  await f.service.submit(input); await f.service.verify(input.id);
  await assert.rejects(f.service.submit(await readSubmission(form())), (error) => error.status === 409);
  const next = await f.restart();
  assert.equal((await next.submit(input)).status, "needs_confirmation");
  assert.equal(saves, 1);
});

test("reviewed driver failures identify the actual phase without permitting upload or save replays", async (t) => {
  for (const [method, phase, detail] of [
    ["prepare", "导入内容时", "未找到唯一草稿箱入口，请在专用浏览器核对"],
    ["prepare", "导入内容时", "图文草稿列表尚未加载，请稍后核对"],
    ["prepare", "导入内容时", "图片内容暂时无法核对，请检查专用窗口"],
    ["saveDraft", "暂存草稿时", "暂存草稿按钮尚不可用"],
    ["verifyDraft", "重新核对草稿时", "小红书登录账号尚未确认或发生变化，请重新连接核对"],
    ["verifyDraft", "重新核对草稿时", "未找到原草稿的编辑入口"],
  ]) {
    await t.test(`${method}: ${detail}`, async (t) => {
      let attempts = 0;
      const f = await fixture(t, { async [method]() { attempts++; throw new XhsDriverError(detail); } });
      const input = await readSubmission(form());
      await f.service.submit(input); await f.service.idle();
      const job = await f.service.get(input.id);
      assert.equal(job.status, "needs_confirmation");
      assert.equal(job.message, `${phase}：${detail}；本任务不会重复上传或保存。`);
      assert.ok(job.message.length <= 500);
      await f.service.submit(input);
      await assert.rejects(f.service.submit(await readSubmission(form())), (error) => error.status === 409);
      assert.equal(attempts, 1);
      if (method === "verifyDraft") {
        const reread = await f.service.verify(input.id);
        assert.equal(reread.message, job.message);
        assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
      }
    });
  }
});

test("unknown and forged driver errors never expose browser data in any phase", async (t) => {
  const privateText = "https://example.test/?cookie=secret user-private-body";
  for (const [method, phase] of [["prepare", "导入内容时"], ["saveDraft", "暂存草稿时"], ["verifyDraft", "重新核对草稿时"]]) {
    for (const error of [new Error(privateText), new XhsDriverError(privateText),
      Object.assign(new Error(privateText), { name: "XhsDriverError", code: "page_needs_attention" }),
      new Error("暂存草稿按钮尚不可用")]) {
      await t.test(`${method} ${error.constructor.name} ${error.message === privateText ? "private" : "spoofed literal"}`, async (t) => {
        const f = await fixture(t, { async [method]() { throw error; } });
        const input = await readSubmission(form());
        await f.service.submit(input); await f.service.idle();
        const job = await f.service.get(input.id);
        assert.equal(job.status, "needs_confirmation");
        assert.equal(job.message, `${phase}：结果尚未确认，请检查小红书专用窗口；本任务不会重复上传或保存。`);
        assert.doesNotMatch(JSON.stringify(job), /secret|cookie|user-private|example\.test/u);
        if (method === "verifyDraft") assert.equal((await f.service.verify(input.id)).message, job.message);
      });
    }
  }
});

test("a crash-stage durable record becomes unknown and cannot call the driver", async (t) => {
  const f = await fixture(t), input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  const path = join(f.dataDir, "jobs", input.id, "job.json"), record = JSON.parse(await readFile(path, "utf8"));
  record.status = "creating"; delete record.draftRef; delete record.draftId;
  await writeFile(path, JSON.stringify(record));
  const next = await f.restart();
  assert.equal((await next.submit(input)).status, "needs_confirmation");
  assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
});

test("failed readback can only retry reading the same draft", async (t) => {
  let verified = false;
  const f = await fixture(t, { async verifyDraft(input) { f.calls.push(["verify", input]); return { verified }; } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  assert.equal((await f.service.get(input.id)).status, "needs_confirmation");
  verified = true;
  assert.equal((await f.service.verify(input.id)).status, "saved");
  assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
  assert.deepEqual(f.calls.filter(([action]) => action === "verify").map(([, value]) => value.draftRef.id), ["draft-fixture", "draft-fixture"]);
});

test("one account task lock covers uploads, login and verification", async (t) => {
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const f = await fixture(t, { async prepare() { await gate; return {}; } });
  const input = await readSubmission(form());
  try {
    await f.service.submit(input);
    await assert.rejects(f.service.openLogin(), (error) => error.status === 409);
    await assert.rejects(f.service.verify(input.id), (error) => error.status === 409);
    await assert.rejects(f.service.acknowledge(input.id), (error) => error.status === 409);
    await assert.rejects(f.service.submit(await readSubmission(form())), (error) => error.status === 409);
    assert.equal(f.service.busy(), true);
  } finally { resume(); await f.service.idle(); }
});

test("human acknowledgement unblocks new IDs without verifying or replaying the old task", async (t) => {
  let saves = 0;
  const f = await fixture(t, { async saveDraft() { saves++; return {}; } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  const acknowledged = await f.service.acknowledge(input.id);
  assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.status, "needs_confirmation");
  assert.equal(f.calls.filter(([action]) => action === "verify").length, 0);
  const next = await f.restart();
  assert.equal((await next.submit(input)).acknowledged, true); assert.equal(saves, 1);
  const another = await readSubmission(form());
  await next.submit(another); await next.idle();
  assert.equal(saves, 2); assert.equal((await next.get(another.id)).acknowledged, false);
});

test("another service cannot own the same profile directory concurrently", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createXhsService({ dataDir: f.dataDir, driver: f.driver }), (error) => error.status === 409);
});

test("truncated images, excess images and duplicate form fields are rejected", async () => {
  const truncated = form(); truncated.delete("images"); truncated.append("images", new Blob([png.subarray(0, -1)], { type: "image/png" }), "cut.png");
  await assert.rejects(readSubmission(truncated), /不完整/);
  const excessive = form(); for (let index = 0; index < 17; index++) excessive.append("images", new Blob([png], { type: "image/png" }), "more.png");
  await assert.rejects(readSubmission(excessive), /1–18/);
  const duplicate = form(); duplicate.append("title", "another"); await assert.rejects(readSubmission(duplicate), /不完整/);
});

test("HTTP draft-only handler accepts real multipart and exposes no publication route", async () => {
  const received = [], handler = createXhsHandler({ service: {
    async submit(input) { received.push(input); return { id: input.id, status: "uploading" }; },
  } });
  const request = new Request("http://localhost/api/xiaohongshu/jobs", { method: "POST", body: form() });
  const stream = Readable.from([Buffer.from(await request.arrayBuffer())]);
  stream.url = "/api/xiaohongshu/jobs"; stream.method = "POST"; stream.headers = Object.fromEntries(request.headers);
  let response;
  assert.equal(await handler(stream, (status, body) => { response = { status, body }; }), true);
  assert.equal(response.status, 202); assert.equal(received.length, 1); assert.deepEqual(received[0].images[0].bytes, png);
  await assert.rejects(handler({ url: "/api/xiaohongshu/publish", method: "POST" }, () => {}), (error) => error.status === 404);
  assert.equal(await handler({ url: "/api/wechat/account", method: "GET" }, () => {}), false);
});

test("HTTP acknowledgement requires the exact affirmative confirmation object", async () => {
  let acknowledges = 0;
  const handler = createXhsHandler({ service: { async acknowledge(id) { acknowledges++; return { id, acknowledged: true, status: "needs_confirmation" }; } } });
  const id = randomUUID();
  async function send(value) {
    const request = Readable.from([Buffer.from(JSON.stringify(value))]);
    request.url = `/api/xiaohongshu/jobs/${id}/acknowledge`; request.method = "POST"; request.headers = { "content-type": "application/json" };
    let result;
    await handler(request, (status, body) => { result = { status, body }; });
    return result;
  }
  for (const invalid of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, other: 1 }, null]) await assert.rejects(send(invalid), (error) => error.status === 400);
  const result = await send({ confirm: true });
  assert.equal(result.status, 200); assert.equal(result.body.job.status, "needs_confirmation"); assert.equal(acknowledges, 1);
});


test("saved drafts with unavailable images retain originals and cannot trigger another upload", async (t) => {
  const f = await fixture(t, { async verifyDraft(input) {
    f.calls.push(["verify", input]);
    return { verified: false, reason: "images_unavailable", message: "private signed image URL cookie=secret" };
  } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  const result = await f.service.get(input.id);
  assert.equal(result.status, "needs_confirmation"); assert.equal(result.draftId, "draft-fixture");
  assert.equal(result.message, "草稿已保存，但小红书图片暂时无法显示，请在专用窗口检查。原图已保留，请勿重复同步。");
  assert.doesNotMatch(JSON.stringify(result), /private|cookie|secret/);
  const prepared = f.calls.find(([action]) => action === "prepare")[1];
  assert.deepEqual(await readFile(prepared.images[0].path), png);
  assert.deepEqual(await readFile(prepared.images[1].path), jpeg);
  assert.equal((await f.service.submit(input)).message, result.message);
  assert.equal((await f.service.verify(input.id)).message, result.message);
  await assert.rejects(f.service.submit(await readSubmission(form())), (error) => error.status === 409);
  assert.equal(f.calls.filter(([action]) => action === "prepare").length, 1);
  assert.equal(f.calls.filter(([action]) => action === "save").length, 1);
});

test("unrecognized verification reasons and messages keep the controlled generic mismatch message", async (t) => {
  const f = await fixture(t, { async verifyDraft() {
    return { verified: false, reason: "private_unknown_reason", message: "cookie=secret" };
  } });
  const input = await readSubmission(form());
  await f.service.submit(input); await f.service.idle();
  const result = await f.service.get(input.id);
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.message, "草稿内容或图片尚未通过核对，请在专用浏览器检查");
  assert.doesNotMatch(JSON.stringify(result), /private|cookie|secret/);
});
