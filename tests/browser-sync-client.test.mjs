import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { createBrowserSyncClient, BrowserSyncUnconfirmedError, BROWSER_SYNC_ORIGIN, BROWSER_SYNC_VERSION } = loadDomModule("lib/browserSync/client.ts");
const CHANNEL = "zhepage-browser-sync-v1";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const makeImage = (index, size = png.length) => ({ id: `image-${index}`, name: `真实图片-${index}.png`, width: 1080, height: 1440, blob: new Blob([png, Buffer.alloc(Math.max(0, size - png.length), index % 256)], { type: "image/png" }) });
const input = (count = 4, platform = "xiaohongshu") => ({ id: crypto.randomUUID(), platform, content: { title: "真实文章完整配图", body: "独立文案\n保留换行和最后一句。 #原图" }, images: Array.from({ length: count }, (_, index) => makeImage(index + 1)) });
const summary = (request) => ({ id: request.id, status: "ready", message: "完整保存，请在平台导入", title: request.draft.title, imageCount: request.draft.images.length });

function fixture(context, { url = `${BROWSER_SYNC_ORIGIN}/`, proxy = false } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  const window = dom.window;
  const requests = [], jobs = new Map(), timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = (id) => { timers.delete(id); };
  const respond = (request, payload, overrides = {}) => window.dispatchEvent(new window.MessageEvent("message", {
    source: window, origin: BROWSER_SYNC_ORIGIN,
    data: { channel: CHANNEL, kind: "response", id: request.id, ok: true, ...payload }, ...overrides,
  }));
  const handle = (request) => {
    if (request.action === "ping") respond(request, { version: BROWSER_SYNC_VERSION });
    if (request.action === "prepare") { const job = summary(request); jobs.set(request.platform, job); respond(request, { job }); }
    if (request.action === "status") respond(request, { job: jobs.get(request.platform) ?? null });
  };
  let onRequest = handle;
  window.postMessage = (request, origin) => { assert.equal(origin, BROWSER_SYNC_ORIGIN); requests.push(request); queueMicrotask(() => onRequest(request)); };
  const source = proxy ? new Proxy(window, { get(target, key) { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } }) : window;
  let client;
  context.after(() => { client?.dispose(); dom.window.close(); });
  return {
    window, requests, jobs, timers, respond, handle,
    create() { client = createBrowserSyncClient(source); return client; },
    set onRequest(handler) { onRequest = handler; },
    async expire(delay) { const matching = [...timers].filter(([, timer]) => timer.delay === delay); assert.ok(matching.length, `a ${delay} ms timer is pending`); for (const [id, timer] of matching) { timers.delete(id); timer.callback(); } await flush(); },
  };
}

test("client passes every original image byte and full caption through the captured page window", async (context) => {
  const f = fixture(context, { proxy: true }), client = f.create(), draft = input(5);
  draft.images[2] = makeImage(33, 1_300_000);
  draft.content.body = "文".repeat(990) + "\n末尾保留";
  const result = await client.prepare(draft);
  assert.equal(result.imageCount, 5);
  assert.deepEqual(f.requests.map((request) => request.action), ["ping", "prepare", "status"]);
  const sent = f.requests[1].draft;
  assert.equal(sent.title, draft.content.title);
  assert.equal(sent.body, draft.content.body);
  assert.equal(sent.images.length, draft.images.length);
  for (let index = 0; index < sent.images.length; index++) {
    assert.equal(sent.images[index].name, draft.images[index].name);
    assert.equal(sent.images[index].mime, draft.images[index].blob.type);
    assert.deepEqual(Buffer.from(sent.images[index].dataUrl.split(",")[1], "base64"), Buffer.from(await draft.images[index].blob.arrayBuffer()));
  }
  assert.equal(f.timers.size, 0);
});

test("platform image ceilings and 1000 Chinese characters are accepted without pilot truncation", async (context) => {
  const f = fixture(context), client = f.create();
  for (const [platform, count] of [["xiaohongshu", 18], ["wechat", 20]]) {
    const draft = input(count, platform); draft.content.body = "汉".repeat(1000);
    const result = await client.prepare(draft);
    assert.equal(result.imageCount, count);
    const sent = f.requests.findLast((request) => request.action === "prepare");
    assert.equal(sent.draft.body, draft.content.body);
    assert.equal(sent.draft.images.length, count);
  }
});

test("invalid content is rejected before any extension request", async (context) => {
  const f = fixture(context), client = f.create();
  const variants = [
    (draft) => { draft.content.title = "题".repeat(21); },
    (draft) => { draft.content.body = "文".repeat(1001); },
    (draft) => { draft.content.body = Array.from({ length: 11 }, (_, index) => `#话题${index}`).join(" "); },
    (draft) => { draft.images = input(19).images; },
    (draft) => { draft.platform = "wechat"; draft.images = input(21).images; },
    (draft) => { draft.images[0].name = "n".repeat(201); },
    (draft) => { draft.images[0] = makeImage(1, 10_000_001); },
    (draft) => { const large = makeImage(1, 9_000_000); draft.images = Array.from({ length: 7 }, () => large); },
  ];
  for (const mutate of variants) { const draft = input(); mutate(draft); await assert.rejects(client.prepare(draft)); }
  assert.equal(f.requests.length, 0);
});

test("ping retries only missing responses, caps attempts, and rejects obsolete scripts", async (context) => {
  const f = fixture(context), client = f.create();
  f.onRequest = (request) => { if (f.requests.length > 1) f.handle(request); };
  const pending = client.ping(); await flush(); await f.expire(3000);
  assert.deepEqual(await pending, { version: BROWSER_SYNC_VERSION });
  assert.equal(f.requests.length, 2);
  f.onRequest = () => {};
  const missing = assert.rejects(client.ping(), /没有收到扩展回应/);
  await flush(); await f.expire(3000); await f.expire(3000); await f.expire(3000); await missing;
  assert.equal(f.requests.length, 5);
  f.onRequest = (request) => f.respond(request, { version: "0.1.1" });
  await assert.rejects(client.ping(), /0\.2\.0/);
  assert.equal(f.requests.length, 6);
  assert.equal(f.timers.size, 0);
});

test("messages from another origin, window, channel or request cannot settle a pending request", async (context) => {
  const f = fixture(context), client = f.create();
  f.onRequest = () => {};
  const pending = client.ping(); await flush(); const request = f.requests[0];
  const payload = { version: BROWSER_SYNC_VERSION };
  const foreign = new JSDOM("", { url: BROWSER_SYNC_ORIGIN });
  try {
    f.respond(request, payload, { origin: "https://other.example" });
    f.respond(request, payload, { source: foreign.window });
    f.respond(request, payload, { source: null });
    f.respond(request, { ...payload, channel: "other-channel" });
    f.respond(request, { ...payload, kind: "request" });
    f.respond(request, { ...payload, id: "other-id" });
    assert.equal(f.timers.size, 1);
    f.respond(request, payload); await pending;
    assert.equal(f.timers.size, 0);
    f.window.history.replaceState({}, "", "/untrusted");
    await assert.rejects(client.ping(), /返回折页/);
    assert.equal(f.requests.length, 1);
  } finally { foreign.window.close(); }
});

test("source client is restricted to the approved top-level page routes", (context) => {
  for (const url of ["http://localhost/", `${BROWSER_SYNC_ORIGIN}/article`, `${BROWSER_SYNC_ORIGIN}/browser-sync-check.html`]) {
    const f = fixture(context, { url }); assert.throws(() => f.create(), /草稿同步页面/);
  }
  const f = fixture(context); const frame = f.window.document.createElement("iframe"); f.window.document.body.append(frame);
  assert.throws(() => createBrowserSyncClient(frame.contentWindow), /草稿同步页面/);
});

test("a lost prepare acknowledgement reads the existing job exactly once and releases the next transfer", async (context) => {
  const f = fixture(context), client = f.create();
  f.onRequest = (request) => { if (request.action === "prepare") f.jobs.set(request.platform, summary(request)); else f.handle(request); };
  const draft = input(), pending = client.prepare(draft); await flush(); await f.expire(180000);
  assert.equal((await pending).id, draft.id);
  assert.deepEqual(f.requests.map((request) => request.action), ["ping", "prepare", "status"]);
  f.jobs.clear(); f.onRequest = f.handle;
  const second = input(3); assert.equal((await client.prepare(second)).id, second.id);
  assert.equal(f.requests.filter((request) => request.action === "prepare").length, 2);
});

test("a malformed or failed acknowledgement recovers only from a matching stored job", async (context) => {
  const f = fixture(context), client = f.create();
  for (const acknowledgement of [{ job: { incomplete: true } }, { ok: false, message: "回执写入失败" }]) {
    f.onRequest = (request) => {
      if (request.action === "prepare") { f.jobs.set(request.platform, summary(request)); f.respond(request, acknowledgement); }
      else f.handle(request);
    };
    const draft = input(); assert.equal((await client.prepare(draft)).id, draft.id);
  }
  assert.equal(f.requests.filter((request) => request.action === "prepare").length, 2);
  assert.equal(f.requests.filter((request) => request.action === "status").length, 2);
});

test("mismatched stored content stays unconfirmed without another write or repeated status", async (context) => {
  const f = fixture(context), client = f.create();
  f.onRequest = (request) => {
    if (request.action === "status") f.respond(request, { job: { ...f.jobs.get(request.platform), imageCount: 1 } });
    else f.handle(request);
  };
  await assert.rejects(client.prepare(input(4)), BrowserSyncUnconfirmedError);
  assert.deepEqual(f.requests.map((request) => request.action), ["ping", "prepare", "status"]);
  assert.equal(f.timers.size, 0);
});

test("cancelling a sent transfer preserves uncertainty and does not retry; single flight then releases", async (context) => {
  const f = fixture(context), client = f.create(), controller = new AbortController();
  f.onRequest = (request) => { if (request.action !== "prepare") f.handle(request); };
  const pending = assert.rejects(client.prepare(input(), controller.signal), BrowserSyncUnconfirmedError);
  await flush();
  await assert.rejects(client.prepare(input()), /上一组内容仍在传入/);
  controller.abort(); await pending;
  assert.deepEqual(f.requests.map((request) => request.action), ["ping", "prepare"]);
  assert.equal(f.timers.size, 0);
  f.onRequest = f.handle;
  assert.equal((await client.prepare(input(3))).imageCount, 3);
  const cancelled = new AbortController(); cancelled.abort(); const before = f.requests.length;
  await assert.rejects(client.prepare(input(), cancelled.signal), { name: "AbortError" });
  assert.equal(f.requests.length, before);
});

test("disposal cancels all outstanding requests and ignores late extension replies", async (context) => {
  const f = fixture(context), client = f.create(); f.onRequest = () => {};
  const ping = assert.rejects(client.ping(), { name: "AbortError" });
  const status = assert.rejects(client.getStatus("xiaohongshu"), { name: "AbortError" });
  await flush(); assert.equal(f.timers.size, 2); client.dispose(); await Promise.all([ping, status]);
  assert.equal(f.timers.size, 0);
  f.respond(f.requests[0], { version: BROWSER_SYNC_VERSION });
  await assert.rejects(client.ping(), { name: "AbortError" });
  assert.equal(f.requests.length, 2);
});
