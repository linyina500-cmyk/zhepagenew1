import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installBrowserSync } from "../lib/browserSync/bridge.mjs";

const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const SOURCE = `${ORIGIN}/browser-sync-check`;
const CHANNEL = "zhepage-browser-sync-v1";
const TTL = 30 * 60 * 1000;
const key = (platform) => `${CHANNEL}:${platform}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function request(platform = "xiaohongshu", id = "draft-1") {
  return { channel: CHANNEL, kind: "request", action: "prepare", platform, id, draft: {
    title: `${platform} test`, body: "Two test images", images: [1, 2].map((i) => ({ name: `${i}.png`, mime: "image/png", dataUrl: PNG })),
  } };
}
function job(platform = "xiaohongshu", status = "ready", id = "draft-1") {
  return { id, platform, status, createdAt: Date.now(), message: "Pending", draft: request(platform, id).draft };
}
function storage() {
  const values = new Map();
  const events = [];
  return { values, events, GM: {
    getValue: async (name, fallback) => structuredClone(values.has(name) ? values.get(name) : fallback),
    setValue: async (name, value) => { events.push(["set", name, value.status]); values.set(name, structuredClone(value)); },
    deleteValue: async (name) => { events.push(["delete", name]); values.delete(name); },
  } };
}
function harness(t, url = SOURCE, shared = storage(), adapterOverrides = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  t.after(() => dom.window.close());
  const { window } = dom;
  const responses = [];
  const calls = [];
  let panel;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { panel = attach.call(this, options); return panel; };
  window.postMessage = (data, origin) => { responses.push({ data, origin }); };
  const adapter = {
    inspect: (platform) => { calls.push(["inspect", platform]); return { ready: true, empty: true }; },
    fill: async (platform, draft) => { calls.push(["fill", platform, draft]); assert.equal(shared.values.get(key(platform)).status, "filling"); },
    save: async (platform) => { calls.push(["save", platform]); assert.equal(shared.values.get(key(platform)).status, "needs_confirmation"); return { status: "needs_confirmation", message: "请到平台草稿箱核对" }; },
    ...adapterOverrides,
  };
  installBrowserSync({ window, document: window.document, GM: shared.GM }, () => adapter);
  const emit = (data, overrides = {}) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: ORIGIN, source: window, ...overrides }));
  return { ...shared, window, responses, calls, adapter, emit,
    async send(data = request(), overrides) { const start = responses.length; emit(data, overrides); await tick(); return responses.slice(start).map((item) => item.data); },
    async click(label) { const button = [...panel.querySelectorAll("button")].find((item) => item.textContent === label); assert.ok(button); button.click(); await tick(); },
    text: () => panel?.querySelector('[role="status"]').textContent,
  };
}

test("accepts messages only from this window at the fixed preview path and origin", async (t) => {
  const source = harness(t);
  for (const overrides of [{ origin: "https://other.example" }, { source: {} }]) assert.deepEqual(await source.send(request(), overrides), []);
  assert.deepEqual(await source.send({ ...request(), channel: "other" }), []);
  assert.deepEqual(await source.send({ ...request(), kind: "response" }), []);
  assert.deepEqual(await source.send({ ...request(), id: "bad id" }), []);
  assert.equal(source.events.length, 0);
  assert.equal((await source.send({ ...request(), action: "ping" }))[0].ok, true);
  assert.equal(source.responses.at(-1).origin, ORIGIN);
  source.window.history.replaceState(null, "", "/another-page");
  assert.deepEqual(await source.send(request()), []);
  for (const url of [`${ORIGIN}/`, "https://other.example/browser-sync-check"]) {
    const other = harness(t, url);
    assert.deepEqual(await other.send(request()), []);
    assert.equal(other.events.length, 0);
  }
});

test("does not install in an iframe or expose platform actions through messages", async (t) => {
  const source = harness(t);
  const frame = source.window.document.createElement("iframe"); source.window.document.body.append(frame);
  let accessed = false;
  installBrowserSync({ window: frame.contentWindow, document: frame.contentDocument, GM: source.GM }, () => { accessed = true; });
  assert.equal(accessed, false);
  assert.equal(frame.contentDocument.getElementById("zhepage-browser-sync-panel"), null);
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish");
  assert.deepEqual(await platform.send(request()), []);
  assert.deepEqual(platform.calls, []);
});

test("rejects unknown actions and platforms, malformed drafts, and excess trial images", async (t) => {
  const source = harness(t);
  const large = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`;
  const invalid = [
    { ...request(), action: "save" }, { ...request(), platform: "unknown" },
    { ...request(), draft: { ...request().draft, title: "a".repeat(21) } },
    { ...request(), draft: { ...request().draft, images: [...request().draft.images, request().draft.images[0]] } },
    { ...request(), draft: { ...request().draft, images: [{ name: "large.png", mime: "image/png", dataUrl: large }] } },
    { ...request(), draft: { ...request().draft, images: [{ name: "invalid.png", mime: "image/png", dataUrl: "data:image/png;base64,Zg" }] } },
  ];
  for (const value of invalid) assert.equal((await source.send(value))[0].ok, false);
  assert.deepEqual(source.events, []);
});

test("verifies complete stored content before reporting prepared and exposes only its summary", async (t) => {
  const source = harness(t);
  const [prepared] = await source.send();
  assert.equal(prepared.ok, true);
  assert.equal(prepared.job.status, "ready");
  assert.equal(prepared.job.imageCount, 2);
  assert.deepEqual(source.values.get(key("xiaohongshu")).draft, request().draft);
  assert.equal(JSON.stringify(prepared).includes(PNG), false);
  const [status] = await source.send({ ...request(), action: "status" });
  assert.deepEqual(status.job, prepared.job);
  assert.equal((await source.send({ ...request("wechat"), action: "status" }))[0].job, null);
});

test("never reports success when storage rejects, silently drops data, or changes content", async (t) => {
  for (const mutate of [null, (value) => ({ ...value, draft: { ...value.draft, body: "changed" } }),
    (value) => ({ ...value, draft: { ...value.draft, images: [...value.draft.images].reverse() } })]) {
    const shared = storage();
    shared.GM.setValue = async (name, value) => { if (mutate) shared.values.set(name, mutate(structuredClone(value))); };
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send())[0].ok, false);
  }
  for (const failure of ["setValue", "getValue"]) {
    const shared = storage(); shared.GM[failure] = async () => { throw new Error("storage unavailable"); };
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send())[0].ok, false);
    assert.deepEqual(source.calls, []);
  }
});

test("keeps started results protected after expiry; expires only untouched ready content", async (t) => {
  for (const status of ["filling", "filled", "needs_confirmation"]) {
    const source = harness(t);
    const previous = { ...job("xiaohongshu", status), createdAt: Date.now() - TTL - 1000 };
    source.values.set(key("xiaohongshu"), previous);
    assert.equal((await source.send(request("xiaohongshu", "new-job")))[0].ok, false);
    assert.deepEqual(source.values.get(key("xiaohongshu")), previous);
  }
  const source = harness(t);
  source.values.set(key("xiaohongshu"), { ...job(), createdAt: Date.now() - TTL - 1000 });
  assert.equal((await source.send(request("xiaohongshu", "new-job")))[0].ok, true);
  assert.equal(source.values.get(key("xiaohongshu")).id, "new-job");
});

test("requires explicit checking and a ready, empty editor before marking or filling", async (t) => {
  for (const inspection of [undefined, { ready: false, empty: true }, { ready: true, empty: false }]) {
    const shared = storage(); shared.values.set(key("xiaohongshu"), job());
    const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared, { inspect: () => inspection });
    await platform.click("填入当前编辑器");
    await platform.click("检查待传内容");
    await platform.click("填入当前编辑器");
    assert.equal(platform.calls.length, 0);
    assert.equal(shared.values.get(key("xiaohongshu")).status, "ready");
    assert.equal(shared.events.length, 0);
    assert.match(platform.text(), /空白/);
  }
});

test("does not fill after a failed durable marker or stale checked task", async (t) => {
  const shared = storage(); shared.values.set(key("xiaohongshu"), job());
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  await platform.click("检查待传内容");
  shared.values.set(key("xiaohongshu"), job("xiaohongshu", "ready", "new-task"));
  await platform.click("填入当前编辑器");
  assert.deepEqual(platform.calls, []);
  await platform.click("检查待传内容");
  shared.GM.setValue = async () => { throw new Error("quota"); };
  await platform.click("填入当前编辑器");
  assert.equal(platform.calls.filter(([action]) => action === "fill").length, 0);
  assert.equal(shared.values.get(key("xiaohongshu")).status, "ready");
});

test("fills and saves only on separate user clicks, keeping every save unverified", async (t) => {
  const shared = storage(); shared.values.set(key("xiaohongshu"), job());
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  await tick(); assert.deepEqual(platform.calls, []);
  await platform.click("检查待传内容"); assert.deepEqual(platform.calls, []);
  await platform.click("填入当前编辑器");
  assert.equal(shared.values.get(key("xiaohongshu")).status, "filled");
  assert.equal(platform.calls.filter(([action]) => action === "save").length, 0);
  await platform.click("保存为平台草稿");
  assert.equal(shared.values.get(key("xiaohongshu")).status, "needs_confirmation");
  await platform.click("保存为平台草稿");
  await platform.click("填入当前编辑器");
  assert.equal(platform.calls.filter(([action]) => action === "save").length, 1);
  assert.equal(platform.calls.filter(([action]) => action === "fill").length, 1);
});

test("preserves failed or interrupted fill results without retrying", async (t) => {
  for (const failPersist of [false, true]) {
    const shared = storage(); shared.values.set(key("xiaohongshu"), job());
    const original = shared.GM.setValue;
    if (failPersist) shared.GM.setValue = async (name, value) => { if (value.status !== "filling") throw new Error("quota"); await original(name, value); };
    let fills = 0;
    const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared, { fill: async () => { fills++; throw new Error("上传中断"); } });
    await platform.click("检查待传内容"); await platform.click("填入当前编辑器");
    assert.equal(shared.values.get(key("xiaohongshu")).status, failPersist ? "filling" : "needs_confirmation");
    assert.match(platform.text(), /上传中断/);
    await platform.click("填入当前编辑器"); assert.equal(fills, 1);
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send(request("xiaohongshu", "replacement")))[0].ok, false);
  }
});

test("retains the pending marker if saving or the final result write fails", async (t) => {
  for (const failPersist of [false, true]) {
    const shared = storage(); shared.values.set(key("wechat"), job("wechat", "filled"));
    let writes = 0;
    const original = shared.GM.setValue;
    if (failPersist) shared.GM.setValue = async (name, value) => { if (++writes === 2) throw new Error("quota"); await original(name, value); };
    let saves = 0;
    const platform = harness(t, "https://mp.weixin.qq.com/", shared, { save: async () => { saves++; throw new Error("保存回执中断，请到草稿箱核对"); } });
    await platform.click("检查待传内容"); await platform.click("保存为平台草稿");
    assert.equal(shared.values.get(key("wechat")).status, "needs_confirmation");
    assert.match(platform.text(), /保存回执中断/);
    await platform.click("保存为平台草稿"); assert.equal(saves, 1);
  }
});

test("keeps two platform tasks and manual cleanup independent even with equal task IDs", async (t) => {
  const shared = storage(); const source = harness(t, SOURCE, shared);
  for (const platform of ["xiaohongshu", "wechat"]) assert.equal((await source.send(request(platform)))[0].ok, true);
  const xhs = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  const wechat = harness(t, "https://mp.weixin.qq.com/", shared);
  await wechat.click("检查待传内容"); await wechat.click("填入当前编辑器");
  assert.equal(shared.values.get(key("xiaohongshu")).status, "ready");
  assert.deepEqual(wechat.calls.find(([action]) => action === "fill"), ["fill", "wechat", request("wechat").draft]);
  assert.deepEqual(xhs.calls, []);
  await wechat.click("结束本次验证");
  assert.equal(shared.values.has(key("wechat")), false);
  assert.equal(shared.values.has(key("xiaohongshu")), true);
});

test("manual cleanup can recover invalid records but never claims a dropped delete succeeded", async (t) => {
  for (const corrupt of [{ status: "saved" }, { platform: "other" }, { createdAt: Date.now() + TTL }]) {
    const shared = storage(); shared.values.set(key("wechat"), { ...job("wechat"), ...corrupt });
    const platform = harness(t, "https://mp.weixin.qq.com/", shared);
    await platform.click("检查待传内容"); assert.match(platform.text(), /记录无效/);
    await platform.click("结束本次验证"); assert.equal(shared.values.has(key("wechat")), false);
    assert.match(platform.text(), /已清除/);
  }
  const shared = storage(); shared.values.set(key("wechat"), job("wechat", "needs_confirmation"));
  shared.GM.deleteValue = async () => {};
  const platform = harness(t, "https://mp.weixin.qq.com/", shared);
  await platform.click("结束本次验证");
  assert.match(platform.text(), /尚未清除/);
  assert.equal(shared.values.get(key("wechat")).status, "needs_confirmation");
});
