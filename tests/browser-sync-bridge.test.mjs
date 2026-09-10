import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installBrowserSync } from "../lib/browserSync/bridge.mjs";

const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const SOURCE = `${ORIGIN}/browser-sync-check`;
const CHANNEL = "zhepage-browser-sync-v1";
const TTL = 30 * 60 * 1000;
const key = (platform) => `${CHANNEL}:${platform}`;
const imageKey = (platform, id, index) => `${key(platform)}:${id}:image:${index}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function request(platform = "xiaohongshu", id = "draft-1", count = 2) {
  return { channel: CHANNEL, kind: "request", action: "prepare", platform, id, draft: {
    title: `${platform} test`, body: "Complete article images", images: Array.from({ length: count }, (_, i) => ({ name: `${i + 1}.png`, mime: "image/png", dataUrl: PNG })),
  } };
}
function job(platform = "xiaohongshu", status = "ready", id = "draft-1", draft = request(platform, id).draft) {
  return { schemaVersion: 2, id, platform, status, createdAt: Date.now(), message: "Pending", draft: {
    title: draft.title, body: draft.body, images: draft.images.map((image, index) => ({
      key: imageKey(platform, id, index), name: image.name, mime: image.mime, bytes: Buffer.from(image.dataUrl.split(",")[1], "base64").length,
    })),
  } };
}
function seed(shared, value = job(), draft = request(value.platform, value.id).draft) {
  draft.images.forEach((image, index) => shared.values.set(imageKey(value.platform, value.id, index), structuredClone(image)));
  shared.values.set(key(value.platform), value);
  return value;
}
function storage() {
  const values = new Map();
  const events = [];
  return { values, events, GM: {
    getValue: async (name, fallback) => structuredClone(values.has(name) ? values.get(name) : fallback),
    setValue: async (name, value) => { events.push(["set", name, value.status, Buffer.byteLength(JSON.stringify(value))]); values.set(name, structuredClone(value)); },
    deleteValue: async (name) => { events.push(["delete", name]); values.delete(name); },
  } };
}
function harness(t, url = SOURCE, shared = storage(), adapterOverrides = {}, wrapWindow = false) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.atob = (value) => Buffer.from(value, "base64").toString("binary");
  window.btoa = (value) => Buffer.from(value, "binary").toString("base64");
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
    reset: (platform) => { calls.push(["reset", platform]); assert.equal(shared.values.has(key(platform)), false); return { reset: true }; },
    ...adapterOverrides,
  };
  const scriptWindow = wrapWindow ? new Proxy(window, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) : window;
  const install = new Function(`return (${installBrowserSync.toString()})`)();
  install({ window: scriptWindow, document: window.document, GM: shared.GM }, () => adapter);
  const emit = (data, overrides = {}) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: ORIGIN, source: window, ...overrides }));
  return { ...shared, window, scriptWindow, responses, calls, adapter, emit,
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
  for (const url of [`${ORIGIN}/another-page`, "https://other.example/browser-sync-check"]) {
    const other = harness(t, url);
    assert.deepEqual(await other.send(request()), []);
    assert.equal(other.events.length, 0);
  }
});

test("accepts the document's window through a userscript Proxy but rejects other message sources", async (t) => {
  const source = harness(t, SOURCE, storage(), {}, true);
  assert.notEqual(source.scriptWindow, source.window.document.defaultView);
  assert.equal(source.scriptWindow.top, source.scriptWindow.self);
  const ping = { ...request(), action: "ping" };
  assert.equal((await source.send(ping))[0].version, "0.2.1");
  assert.equal((await source.send())[0].ok, true);

  const other = harness(t);
  const frame = source.window.document.createElement("iframe");
  source.window.document.body.append(frame);
  for (const sender of [other.window, frame.contentWindow, null]) {
    assert.deepEqual(await source.send(ping, { source: sender }), []);
  }
  assert.deepEqual(await source.send(ping, { origin: "https://other.example" }), []);
  assert.deepEqual(await source.send({ ...ping, channel: "other" }), []);
  assert.deepEqual(await source.send({ ...ping, id: "invalid id" }), []);
  source.window.history.replaceState(null, "", "/another-page");
  assert.deepEqual(await source.send(ping), []);
});

test("the main application root accepts the same versioned prepare and status protocol", async (t) => {
  const source = harness(t, `${ORIGIN}/`, storage(), {}, true);
  assert.equal((await source.send({ ...request(), action: "ping" }))[0].version, "0.2.1");
  assert.equal((await source.send(request("wechat", "main-job", 3)))[0].job.imageCount, 3);
  assert.equal((await source.send({ ...request("wechat"), action: "status" }))[0].job.id, "main-job");
  for (const path of ["/browser-sync-check.html", "/browser-sync-check/", "/articles", "/login"]) {
    source.window.history.replaceState(null, "", path);
    assert.deepEqual(await source.send({ ...request(), action: "ping" }), []);
  }
});

test("does not install without a document window", (t) => {
  const dom = new JSDOM("<!doctype html>", { url: SOURCE });
  t.after(() => dom.window.close());
  const document = dom.window.document.implementation.createHTMLDocument();
  assert.equal(document.defaultView, null);
  const listen = t.mock.method(dom.window, "addEventListener");
  installBrowserSync({ window: dom.window, document, GM: {} }, () => assert.fail("must not create an adapter"));
  assert.equal(listen.mock.callCount(), 0);
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

test("rejects unknown actions and platforms, malformed drafts, and platform image limits", async (t) => {
  const source = harness(t);
  const large = `data:image/png;base64,${Buffer.alloc(10_000_001).toString("base64")}`;
  const invalid = [
    { ...request(), action: "save" }, { ...request(), platform: "unknown" },
    { ...request(), draft: { ...request().draft, title: "a".repeat(21) } },
    request("xiaohongshu", "draft-1", 19), request("wechat", "draft-1", 21),
    { ...request(), draft: { ...request().draft, body: "文".repeat(1001) } },
    { ...request(), draft: { ...request().draft, body: Array.from({ length: 11 }, (_, index) => `#topic${index}`).join(" ") } },
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
  const manifest = source.values.get(key("xiaohongshu"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(JSON.stringify(manifest).includes("data:image"), false);
  assert.deepEqual(manifest.draft.images.map((image) => source.values.get(image.key)), request().draft.images);
  assert.equal(source.events.at(-1)[1], key("xiaohongshu"), "the manifest is committed after all individual images");
  assert.equal(JSON.stringify(prepared).includes(PNG), false);
  const [status] = await source.send({ ...request(), action: "status" });
  assert.deepEqual(status.job, prepared.job);
  assert.equal((await source.send({ ...request("wechat"), action: "status" }))[0].job, null);
});

test("complete platform image counts and large images are stored separately and restored in order", async (t) => {
  for (const [platform, count] of [["xiaohongshu", 18], ["wechat", 20]]) {
    const source = harness(t);
    assert.equal((await source.send(request(platform, "full-article", count)))[0].job.imageCount, count);
    const manifest = source.values.get(key(platform));
    assert.equal(source.events.filter(([action]) => action === "set").length, count + 1);
    assert.deepEqual(manifest.draft.images.map((reference) => source.values.get(reference.key).name), request(platform, "full-article", count).draft.images.map((image) => image.name));
  }
  const shared = storage();
  const source = harness(t, `${ORIGIN}/`, shared);
  const value = request("xiaohongshu", "large-article", 3);
  const bytes = Buffer.alloc(10_000_000, 127);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  value.draft.images[1].dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  assert.equal((await source.send(value))[0].ok, true);
  const manifest = shared.values.get(key("xiaohongshu"));
  assert.equal(manifest.draft.images[1].bytes, bytes.length);
  assert.ok(shared.events.every((event) => event[0] !== "set" || event[3] <= 13.4 * 1024 * 1024), "each GM value stays within a single image's encoded size");
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 10_000, "status changes use only the small manifest");
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  await platform.click("检查待传内容");
  shared.events.length = 0;
  await platform.click("填入当前编辑器");
  const filled = platform.calls.find(([action]) => action === "fill")[2];
  assert.deepEqual(filled, value.draft);
  assert.deepEqual(Buffer.from(filled.images[1].dataUrl.split(",")[1], "base64"), bytes);
  assert.ok(shared.events.every(([action, name]) => action !== "set" || name === key("xiaohongshu")), "filling only updates the manifest, never rewrites image payloads");
});

test("the total decoded image limit is enforced before any image is written", async (t) => {
  const source = harness(t);
  const value = request("wechat", "too-large", 7);
  const full = `data:image/png;base64,${Buffer.alloc(10_000_000).toString("base64")}`;
  const remainder = 60 * 1024 * 1024 - 60_000_000 + 1;
  value.draft.images.forEach((image, index) => { image.dataUrl = index < 6 ? full : `data:image/png;base64,${Buffer.alloc(remainder).toString("base64")}`; });
  assert.match((await source.send(value))[0].message, /60 MiB/);
  assert.deepEqual(source.events, []);
});

test("never reports success when storage rejects, silently drops data, or changes an image", async (t) => {
  for (const mutate of [null, (value) => ({ ...value, name: "changed.png" }), (value) => ({ ...value, dataUrl: value.dataUrl.replace("iVBOR", "aVBOR") })]) {
    const shared = storage();
    shared.GM.setValue = async (name, value) => { if (mutate) shared.values.set(name, mutate(structuredClone(value))); };
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send())[0].ok, false);
    assert.equal(shared.values.size, 0, "uncommitted image writes are removed after failure");
  }
  for (const failure of ["setValue", "getValue"]) {
    const shared = storage(); shared.GM[failure] = async () => { throw new Error("storage unavailable"); };
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send())[0].ok, false);
    assert.deepEqual(source.calls, []);
  }
});

test("a failed image write clears only its new keys and preserves the other platform's ready task", async (t) => {
  const shared = storage();
  const previous = seed(shared, job("wechat"));
  const originalSet = shared.GM.setValue;
  shared.GM.setValue = async (name, value) => {
    await originalSet(name, value);
    if (name === imageKey("xiaohongshu", "new-job", 1)) throw new Error("image storage interrupted");
  };
  const source = harness(t, SOURCE, shared);
  assert.equal((await source.send(request("xiaohongshu", "new-job", 3)))[0].ok, false);
  assert.deepEqual(shared.values.get(key("wechat")), previous);
  assert.ok(previous.draft.images.every((reference) => shared.values.has(reference.key)));
  assert.equal([...shared.values.keys()].some((name) => name.includes(":new-job:")), false);
});

test("neither the same ID nor a new ID can replace an existing ready task before it is explicitly ended", async (t) => {
  const shared = storage();
  const previous = seed(shared);
  const source = harness(t, SOURCE, shared);
  assert.equal((await source.send())[0].ok, false);
  assert.deepEqual(shared.events, []);
  assert.match((await source.send(request("xiaohongshu", "new-job", 3)))[0].message, /结束本次传图/);
  assert.deepEqual(shared.events, []);
  assert.deepEqual(shared.values.get(key("xiaohongshu")), previous);
  assert.ok(previous.draft.images.every((reference) => shared.values.has(reference.key)));
});

test("preparation stops if a different task appears while its images are written", async (t) => {
  const shared = storage();
  const previous = job("xiaohongshu", "filling");
  const originalSet = shared.GM.setValue;
  shared.GM.setValue = async (name, value) => {
    await originalSet(name, value);
    if (name === imageKey("xiaohongshu", "new-job", 0)) seed(shared, previous);
  };
  const source = harness(t, SOURCE, shared);
  assert.match((await source.send(request("xiaohongshu", "new-job")))[0].message, /状态已变化/);
  assert.equal(shared.values.get(key("xiaohongshu")).status, "filling");
  assert.ok(previous.draft.images.every((reference) => shared.values.has(reference.key)));
  assert.equal([...shared.values.keys()].some((name) => name.includes(":new-job:")), false);
});

test("an uncertain manifest write keeps image data for a later status read", async (t) => {
    const shared = storage();
    const originalGet = shared.GM.getValue;
    let failRead = true;
    shared.GM.getValue = async (name, fallback) => {
      if (name === key("xiaohongshu") && shared.values.get(name)?.id === "new-job" && failRead) { failRead = false; throw new Error("manifest readback interrupted"); }
      return originalGet(name, fallback);
    };
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send(request("xiaohongshu", "new-job", 3)))[0].ok, false);
    const committed = shared.values.get(key("xiaohongshu"));
    assert.equal(committed.id, "new-job");
    assert.ok(committed.draft.images.every((reference) => shared.values.has(reference.key)), "uncertainty must never delete a potentially committed task's images");
    assert.equal((await source.send({ ...request(), action: "status" }))[0].job.id, "new-job");
});

test("a reopened client cannot read a false empty status or begin another job while image storage is still pending", async (t) => {
  const shared = storage();
  const originalSet = shared.GM.setValue;
  let release;
  shared.GM.setValue = async (name, value) => {
    if (name === imageKey("xiaohongshu", "first-job", 0)) await new Promise((resolve) => { release = resolve; });
    await originalSet(name, value);
  };
  const source = harness(t, SOURCE, shared);
  assert.deepEqual(await source.send(request("xiaohongshu", "first-job")), []);
  assert.equal(typeof release, "function");
  const [status] = await source.send({ ...request("xiaohongshu", "status-after-close"), action: "status" });
  assert.equal(status.ok, false);
  assert.match(status.message, /仍在写入/);
  assert.equal((await source.send(request("xiaohongshu", "second-job")))[0].ok, false);
  release(); await tick();
  assert.equal((await source.send({ ...request("xiaohongshu", "status-after-write"), action: "status" }))[0].job.id, "first-job");
  assert.equal([...shared.values.keys()].some((name) => name.includes(":second-job:")), false);
});

test("missing or mismatched stored images stop status and filling without claiming success", async (t) => {
  for (const corruption of ["missing", "metadata"]) {
    const shared = storage();
    const stored = seed(shared);
    if (corruption === "missing") shared.values.delete(stored.draft.images[1].key);
    else shared.values.get(stored.draft.images[1].key).name = "wrong.png";
    const source = harness(t, SOURCE, shared);
    assert.equal((await source.send({ ...request(), action: "status" }))[0].ok, false);
    const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
    await platform.click("检查待传内容");
    await platform.click("填入当前编辑器");
    assert.equal(platform.calls.filter(([action]) => action === "fill").length, 0);
    assert.equal(shared.values.get(key("xiaohongshu")).status, "ready");
    assert.deepEqual(shared.events, []);
  }
});

test("keeps started results protected after expiry; expires only untouched ready content", async (t) => {
  for (const status of ["filling", "filled", "needs_confirmation"]) {
    const source = harness(t);
    const previous = { ...job("xiaohongshu", status), createdAt: Date.now() - TTL - 1000 };
    seed(source, previous);
    assert.equal((await source.send(request("xiaohongshu", "new-job")))[0].ok, false);
    assert.deepEqual(source.values.get(key("xiaohongshu")), previous);
  }
  const source = harness(t);
  seed(source, { ...job(), createdAt: Date.now() - TTL - 1000 });
  assert.equal((await source.send(request("xiaohongshu", "new-job")))[0].ok, true);
  assert.equal(source.values.get(key("xiaohongshu")).id, "new-job");
});

test("requires explicit checking and a ready, empty editor before marking or filling", async (t) => {
  for (const inspection of [undefined, { ready: false, empty: true }, { ready: true, empty: false }]) {
    const shared = storage(); seed(shared);
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
  const shared = storage(); seed(shared);
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  await platform.click("检查待传内容");
  seed(shared, job("xiaohongshu", "ready", "new-task"));
  await platform.click("填入当前编辑器");
  assert.deepEqual(platform.calls, []);
  await platform.click("检查待传内容");
  shared.GM.setValue = async () => { throw new Error("quota"); };
  await platform.click("填入当前编辑器");
  assert.equal(platform.calls.filter(([action]) => action === "fill").length, 0);
  assert.equal(shared.values.get(key("xiaohongshu")).status, "ready");
});

test("a task that changes while its images are read cannot be claimed or uploaded", async (t) => {
  const shared = storage();
  seed(shared);
  const platform = harness(t, "https://creator.xiaohongshu.com/publish/publish", shared);
  await platform.click("检查待传内容");
  const originalGet = shared.GM.getValue;
  shared.GM.getValue = async (name, fallback) => {
    if (name === imageKey("xiaohongshu", "draft-1", 0)) shared.values.get(key("xiaohongshu")).status = "needs_confirmation";
    return originalGet(name, fallback);
  };
  await platform.click("填入当前编辑器");
  assert.equal(platform.calls.filter(([action]) => action === "fill").length, 0);
  assert.equal(shared.values.get(key("xiaohongshu")).status, "needs_confirmation");
  assert.deepEqual(shared.events, []);
  assert.match(platform.text(), /状态已经变化/);
});

test("fills and saves only on separate user clicks, keeping every save unverified", async (t) => {
  const shared = storage(); seed(shared);
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
    const shared = storage(); seed(shared);
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
    const shared = storage(); seed(shared, job("wechat", "filled"));
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
  await wechat.click("结束本次传图");
  assert.equal(shared.values.has(key("wechat")), false);
  assert.equal(shared.values.has(key("xiaohongshu")), true);
});

test("ending a task resets the adapter only after verified cleanup and permits a second task on the same page", async (t) => {
  for (const platformName of ["xiaohongshu", "wechat"]) {
    const shared = storage();
    const source = harness(t, `${ORIGIN}/`, shared);
    let empty = true;
    let alreadyFilled = false;
    let fills = 0;
    let resets = 0;
    const page = harness(t, platformName === "wechat" ? "https://mp.weixin.qq.com/" : "https://creator.xiaohongshu.com/publish/publish", shared, {
      inspect: () => ({ ready: true, empty }),
      fill: async () => { assert.equal(alreadyFilled, false); alreadyFilled = true; empty = false; fills++; },
      reset: () => { assert.equal(shared.values.size, 0, "the manifest and every image deletion must already be verified"); alreadyFilled = false; resets++; return { reset: true }; },
    });
    assert.equal((await source.send(request(platformName, "first", 3)))[0].ok, true);
    await page.click("检查待传内容");
    await page.click("填入当前编辑器");
    await page.click("保存为平台草稿");
    await page.click("结束本次传图");
    assert.equal(resets, 1);
    assert.equal((await source.send({ ...request(platformName), action: "status" }))[0].job, null);
    assert.equal((await source.send(request(platformName, "second", 4)))[0].ok, true);
    await page.click("检查待传内容");
    await page.click("填入当前编辑器");
    assert.equal(fills, 1, "ending a task never authorizes overwriting the previous editor's content");
    assert.equal(shared.values.get(key(platformName)).status, "ready");
    empty = true; // The user opens a fresh empty editor in this platform page.
    await page.click("填入当前编辑器");
    assert.equal(fills, 2);
    assert.equal(shared.values.get(key(platformName)).id, "second");
    assert.equal(shared.values.get(key(platformName)).status, "filled");
    assert.equal(page.calls.filter(([action]) => action === "save").length, 1, "the second import does not save automatically");
  }
});

test("missing-image cleanup and legacy inline tasks require explicit ending without migration", async (t) => {
  const shared = storage();
  const legacy = { id: "legacy", platform: "wechat", status: "ready", createdAt: Date.now(), message: "Old trial", draft: request("wechat").draft };
  shared.values.set(key("wechat"), legacy);
  const source = harness(t, SOURCE, shared);
  for (const action of ["prepare", "status"]) {
    const [result] = await source.send({ ...request("wechat", "new-job"), action });
    assert.equal(result.ok, false);
    assert.match(result.message, /旧版/);
  }
  assert.deepEqual(shared.values.get(key("wechat")), legacy);
  assert.deepEqual(shared.events, []);
  const platform = harness(t, "https://mp.weixin.qq.com/", shared);
  await platform.click("结束本次传图");
  assert.equal(shared.values.size, 0);
  assert.equal((await source.send(request("wechat", "new-job")))[0].ok, true);
  shared.values.delete(imageKey("wechat", "new-job", 0));
  await platform.click("结束本次传图");
  assert.equal(shared.values.size, 0, "an absent image does not prevent verified deletion of all remaining keys");
});

test("failed deletion retains the task and cannot reset the adapter or authorize another upload", async (t) => {
  const shared = storage();
  seed(shared, job("wechat", "needs_confirmation"));
  shared.GM.deleteValue = async () => {};
  const platform = harness(t, "https://mp.weixin.qq.com/", shared);
  await platform.click("结束本次传图");
  assert.match(platform.text(), /尚未清除/);
  assert.equal(platform.calls.filter(([action]) => action === "reset").length, 0);
  const source = harness(t, SOURCE, shared);
  assert.equal((await source.send(request("wechat", "second")))[0].ok, false);
  assert.equal(shared.values.get(key("wechat")).status, "needs_confirmation");
});

test("ready expiry verifies image deletion and does not silently discard a failed cleanup", async (t) => {
  const shared = storage();
  seed(shared, { ...job(), createdAt: Date.now() - TTL - 1 });
  shared.GM.deleteValue = async () => {};
  const source = harness(t, SOURCE, shared);
  const [result] = await source.send({ ...request(), action: "status" });
  assert.equal(result.ok, false);
  assert.match(result.message, /尚未清除/);
  assert.equal(shared.values.size, 3);
});

test("manual cleanup can recover invalid records but never claims a dropped delete succeeded", async (t) => {
  for (const corrupt of [{ status: "saved" }, { platform: "other" }, { createdAt: Date.now() + TTL }]) {
    const shared = storage(); seed(shared, job("wechat"));
    shared.values.set(key("wechat"), { ...shared.values.get(key("wechat")), ...corrupt });
    const platform = harness(t, "https://mp.weixin.qq.com/", shared);
    await platform.click("检查待传内容"); assert.match(platform.text(), /记录无效/);
    await platform.click("结束本次传图"); assert.equal(shared.values.has(key("wechat")), false);
    assert.match(platform.text(), /已清除/);
  }
  const shared = storage(); seed(shared, job("wechat", "needs_confirmation"));
  shared.GM.deleteValue = async () => {};
  const platform = harness(t, "https://mp.weixin.qq.com/", shared);
  await platform.click("结束本次传图");
  assert.match(platform.text(), /尚未清除/);
  assert.equal(shared.values.get(key("wechat")).status, "needs_confirmation");
});
