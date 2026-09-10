import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installBrowserSync } from "../lib/browserSync/bridge.mjs";

const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const CHANNEL = "zhepage-browser-sync-v1";
const html = await readFile(new URL("../public/browser-sync-check.html", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM(html, { url: `${ORIGIN}/browser-sync-check`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.setTimeout = globalThis.setTimeout;
  window.clearTimeout = globalThis.clearTimeout;
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, fillText() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,dGVzdA==";
  const requests = [];
  const emit = (data, overrides = {}) => window.dispatchEvent(new window.MessageEvent("message", {
    data, origin: ORIGIN, source: window, ...overrides,
  }));
  window.postMessage = (data, origin) => {
    assert.equal(origin, ORIGIN);
    if (data.kind === "request") requests.push(data);
    // Deliver asynchronously so a message sent before extension injection is lost.
    queueMicrotask(() => emit(data));
  };
  window.eval(window.document.querySelector("script").textContent);
  return {
    window, requests, element: (id) => window.document.getElementById(id),
    reply(request, fields = {}, overrides) {
      emit({ channel: CHANNEL, kind: "response", id: request.id, ok: true, ...(request.action === "ping" ? { version: "0.2.0" } : {}), ...fields }, overrides);
    },
    async advance(ms) { t.mock.timers.tick(ms); await flush(); },
  };
}

test("recovers when the first ping is delivered before the userscript listener exists", async (t) => {
  const app = fixture(t);
  await flush();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].action, "ping");
  assert.equal(app.element("prepare").disabled, true);

  installBrowserSync({ window: app.window, document: app.window.document, GM: {} }, () => {
    assert.fail("the source page must not create a platform adapter");
  });
  await app.advance(3000);
  assert.equal(app.requests.length, 2);
  assert.match(app.element("extension-status").textContent, /扩展已连接/);
  assert.equal(app.element("prepare").disabled, false);
  app.reply(app.requests[0], { ok: false, message: "迟到的失败" });
  await app.advance(9000);
  assert.equal(app.requests.length, 2);
  assert.match(app.element("extension-status").textContent, /扩展已连接/);
});

test("keeps one bounded check in flight and permits a fresh check after final failure", async (t) => {
  const app = fixture(t);
  const check = app.element("check-extension");
  assert.equal(check.disabled, true);
  for (let i = 0; i < 4; i++) check.dispatchEvent(new app.window.Event("click"));
  assert.equal(app.requests.length, 1);
  for (let attempt = 0; attempt < 3; attempt++) await app.advance(3000);
  assert.equal(app.requests.length, 3);
  assert.match(app.element("extension-status").textContent, /没有收到扩展回应/);
  assert.equal(app.element("prepare").disabled, true);
  assert.equal(check.disabled, false);
  await app.advance(30000);
  assert.equal(app.requests.length, 3);

  check.click();
  assert.equal(app.requests.length, 4);
  app.reply(app.requests[3]);
  await flush();
  app.reply(app.requests[2], { ok: false, message: "上一轮迟到的失败" });
  await app.advance(9000);
  assert.equal(app.requests.length, 4);
  assert.match(app.element("extension-status").textContent, /扩展已连接/);
  assert.equal(app.element("prepare").disabled, false);
});

test("rejects responses from other origins, windows, channels, and message kinds", async (t) => {
  const app = fixture(t);
  for (const overrides of [{ origin: "https://other.example" }, { source: {} }]) app.reply(app.requests[0], {}, overrides);
  for (const fields of [{ channel: "other" }, { kind: "request" }]) app.reply(app.requests[0], fields);
  await flush();
  assert.equal(app.element("prepare").disabled, true);
  assert.match(app.element("extension-status").textContent, /正在检测/);
  await app.advance(3000);
  assert.equal(app.requests.length, 2);
  app.reply(app.requests[1]);
  await flush();
  assert.match(app.element("extension-status").textContent, /扩展已连接/);
});

test("a check cannot enable a pending preparation, and prepare or status never retry", async (t) => {
  const app = fixture(t);
  app.reply(app.requests[0]);
  await flush();
  const prepare = app.element("prepare");
  prepare.click();
  assert.equal(app.requests.at(-1).action, "prepare");
  app.element("check-extension").click();
  assert.equal(app.requests.at(-1).action, "ping");
  app.reply(app.requests.at(-1));
  await flush();
  assert.equal(prepare.disabled, true);
  prepare.dispatchEvent(new app.window.Event("click"));
  await app.advance(15000);
  assert.equal(app.requests.filter(({ action }) => action === "prepare").length, 1);
  assert.match(app.element("prepare-status").textContent, /没有收到扩展回应/);
  assert.equal(prepare.disabled, false);
  app.element("check-result").click();
  await app.advance(9000);
  assert.equal(app.requests.filter(({ action }) => action === "status").length, 1);
  assert.match(app.element("result").textContent, /没有收到扩展回应/);
});

test("an installed old script prompts for its update without enabling preparation or hiding the version error", async (t) => {
  const app = fixture(t);
  app.reply(app.requests[0], { version: "0.1.1" });
  await flush();
  await app.advance(30000);
  assert.equal(app.requests.length, 1);
  assert.equal(app.element("prepare").disabled, true);
  assert.match(app.element("extension-status").textContent, /更新.*0\.2\.0/);
});
