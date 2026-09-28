import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createXhsHandler, readXhsSubmission } from "../browser-extension/xiaohongshu.mjs";
import { XhsError } from "../browser-extension/xhs-browser.mjs";

const id = "d237c66b-47c0-4e74-bad5-77302782c915";
const account = { id: "a".repeat(20), name: "测试账号" };
const pixels = `pixels:1x1:${"d".repeat(64)}`;
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1MAAAAASUVORK5CYII=", "base64"));
const form = (overrides = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ id, expectedAccountId: account.id, title: "测试标题", body: "第一行\n第二行", ...overrides })) data.set(key, value);
  data.append("images", new Blob([png], { type: "image/png" }), "test.png");
  return data;
};
function memoryStore() {
  const map = new Map();
  return { map, get: async (key) => structuredClone(map.get(key)), set: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async (key) => map.delete(key), list: async (prefix) => [...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) };
}
function fakeDriver(overrides = {}) {
  const calls = [];
  return { calls, accountState: async () => ({ status: "connected", account }), openLogin: async () => ({ status: "connected", account }),
    async prepare(record, update) { calls.push("prepare"); record.uploadedCount = record.images.length; await update(); return { jobId: record.id, images: [pixels], beforeIds: [], title: record.title }; },
    async save(record, update) { calls.push("save"); record.saveAttempted = true; await update(); return { draftId: "draft-123", draftRef: { kind: "local", id: "draft-123", images: [pixels] } }; },
    async verify() { calls.push("verify"); return { verified: true, draftId: "draft-123", draftRef: { kind: "local", id: "draft-123", images: [pixels] } }; }, ...overrides };
}
async function finalJob(handle) {
  for (let count = 0; count < 100; count++) {
    const result = await handle({ path: `/api/xiaohongshu/jobs/${id}` });
    if (!["uploading", "creating"].includes(result.body.job?.status)) return result.body.job;
    await pause(5);
  }
  assert.fail("job did not finish");
}

test("extension validates images and text before platform work", async () => {
  const input = await readXhsSubmission(form());
  assert.equal(input.images[0].blob.size, png.length);
  assert.match(input.images[0].hash, /^[a-f0-9]{64}$/u);
  assert.equal(input.body, "第一行\n第二行");
  await assert.rejects(readXhsSubmission(form({ title: "字".repeat(21) })), /1–20/u);
  await assert.rejects(readXhsSubmission(form({ expectedAccountId: "wrong" })), /核对/u);
  const broken = form(); broken.set("images", new Blob(["broken"], { type: "image/png" }), "bad.png");
  await assert.rejects(readXhsSubmission(broken), /不完整/u);
});

test("new job persists before upload, returns 202, then verifies native saved draft", async () => {
  const store = memoryStore(), driver = fakeDriver();
  const handle = createXhsHandler({ store, driver });
  const response = await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() });
  assert.equal(response.status, 202);
  assert.equal(response.body.job.id, id);
  const result = await finalJob(handle);
  assert.equal(result.status, "saved"); assert.equal(result.draftId, "draft-123"); assert.equal(result.uploadedCount, 1);
  assert.deepEqual(driver.calls, ["prepare", "save", "verify"]);
  const retained = await store.get(`xhs:job:${id}`);
  assert.ok(retained.images[0].blob instanceof Blob); assert.equal(retained.saveAttempted, true);
  assert.equal("images" in result, false, "private image records never cross the response boundary");
});

test("same identifier never reuploads; changed content or account cannot reuse it", async () => {
  const store = memoryStore(), driver = fakeDriver(), handle = createXhsHandler({ store, driver });
  await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() }); await finalJob(handle);
  assert.equal((await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() })).body.job.status, "saved");
  assert.equal((await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form({ title: "不同内容" }) })).status, 409);
  assert.deepEqual(driver.calls, ["prepare", "save", "verify"]);
});

test("worker restart converts durable mutation intents into uncertainty without resuming", async () => {
  for (const status of ["uploading", "creating"]) {
    const store = memoryStore(), input = await readXhsSubmission(form());
    await store.set(`xhs:job:${id}`, { ...input, accountName: account.name, imageCount: 1, uploadedCount: status === "creating" ? 1 : 0, status, saveAttempted: status === "creating" });
    const driver = fakeDriver(), handle = createXhsHandler({ store, driver });
    const result = await handle({ path: `/api/xiaohongshu/jobs/${id}` });
    assert.equal(result.body.job.status, "needs_confirmation"); assert.match(result.body.job.message, /中断/u);
    await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() });
    assert.deepEqual(driver.calls, []);
    const another = await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form({ id: "4b902aa2-0e88-4f1e-9d21-fc8384b2a0ab" }) });
    assert.equal(another.status, 409);
  }
});

test("ambiguous save or upload failure blocks retries and keeps raw page details private", async () => {
  for (const phase of ["prepare", "save"]) {
    const store = memoryStore(); let mutations = 0;
    const driver = fakeDriver({ [phase]: async () => { mutations++; throw new Error("https://private.example/token=secret"); } });
    const handle = createXhsHandler({ store, driver });
    await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() });
    const job = await finalJob(handle);
    assert.equal(job.status, "needs_confirmation"); assert.doesNotMatch(job.message, /secret|private/u);
    await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() }); assert.equal(mutations, 1);
  }
});

test("account changes and unavailable persistence prevent the first upload", async () => {
  const driver = fakeDriver({ accountState: async () => ({ status: "connected", account: { ...account, id: "b".repeat(20) } }) });
  const handle = createXhsHandler({ store: memoryStore(), driver });
  assert.equal((await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() })).status, 409);
  assert.deepEqual(driver.calls, []);
  const store = memoryStore(); store.set = async () => { throw Error("disk unavailable"); };
  const next = fakeDriver(), unavailable = createXhsHandler({ store, driver: next });
  assert.equal((await unavailable({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() })).status, 503);
  assert.deepEqual(next.calls, []);
});

test("explicit verify and acknowledgement never submit another draft or publish", async () => {
  const driver = fakeDriver({ save: async () => { throw new XhsError("请核对草稿箱"); } }), handle = createXhsHandler({ store: memoryStore(), driver });
  await handle({ path: "/api/xiaohongshu/jobs", method: "POST", body: form() }); await finalJob(handle);
  assert.equal((await handle({ path: `/api/xiaohongshu/jobs/${id}/acknowledge`, method: "POST", body: {} })).status, 400);
  assert.equal((await handle({ path: `/api/xiaohongshu/jobs/${id}/acknowledge`, method: "POST", body: { confirm: true } })).body.job.acknowledged, true);
  assert.equal((await handle({ path: "/api/xiaohongshu/publish", method: "POST" })).status, 404);
  assert.equal((await handle({ path: `/api/xiaohongshu/jobs/${id}/verify`, method: "POST" })).body.job.status, "saved");
  assert.deepEqual(driver.calls, ["prepare", "verify"]);
  assert.equal(await handle({ path: "/api/wechat/account" }), null);
});
