import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const { beginLocalSyncConnection } = loadDomModule("lib/localSync/connection.ts");
const origin = "http://127.0.0.1:8789";
const deviceId = "a".repeat(32), token = "b".repeat(64);

function fixture(t, options = {}) {
  const dom = installDom(), messages = [], requests = [], opened = [];
  const popup = { closed: false, close() { this.closed = true; }, postMessage(data, target) { messages.push({ data, target }); } };
  t.mock.method(window, "open", (...args) => { opened.push(args); return options.blocked ? null : popup; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ deviceId: options.otherDevice || deviceId }));
  });
  const attempt = beginLocalSyncConnection();
  const send = (data, source = popup, eventOrigin = origin) => window.dispatchEvent(new window.MessageEvent("message", { data, source, origin: eventOrigin }));
  const ready = () => { send({ type: "zhepage-local-ready" }); return messages.at(-1)?.data.nonce; };
  const connected = (nonce) => send({ type: "zhepage-local-connected", nonce, deviceId, connectionToken: token });
  t.after(() => { attempt.close(); dom.window.close(); });
  return { attempt, send, ready, connected, messages, requests, opened, popup };
}

test("pairing verifies the exact popup, local origin and fresh challenge before verifying the service", async (t) => {
  const f = fixture(t);
  const result = f.attempt.connect(new AbortController().signal);
  const payload = { type: "zhepage-local-ready" };
  f.send(payload, {}, origin); f.send(payload, f.popup, "https://untrusted.example");
  assert.equal(f.messages.length, 0);
  const nonce = f.ready();
  assert.match(nonce, /^[a-f0-9]{64}$/); assert.equal(f.messages[0].target, origin);
  f.connected("0".repeat(64));
  f.send({ type: "zhepage-local-connected", nonce, deviceId, connectionToken: token }, {}, origin);
  f.send({ type: "zhepage-local-connected", nonce, deviceId, connectionToken: token }, f.popup, "http://localhost:8789");
  await Promise.resolve(); assert.equal(f.requests.length, 0);
  f.connected(nonce);
  assert.deepEqual(await result, { deviceId, connectionToken: token });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/wechat/connection");
  assert.equal(f.requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(f.opened[0][0], `${origin}/connect`);
  assert.ok(!f.opened.flat().join(" ").includes(token));
  assert.ok(!f.opened.flat().join(" ").includes(nonce));
  f.connected(nonce); f.ready(); assert.equal(f.messages.length, 1);
});

test("blocked popup produces actionable inline help without making any service request", async (t) => {
  const f = fixture(t, { blocked: true });
  await assert.rejects(f.attempt.connect(new AbortController().signal), /允许此网站打开连接窗口/);
  assert.equal(f.requests.length, 0);
});

test("closing the dialog aborts pairing and late messages cannot connect", async (t) => {
  const f = fixture(t), controller = new AbortController();
  const pending = f.attempt.connect(controller.signal);
  const nonce = f.ready(); controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/); f.connected(nonce);
  assert.equal(f.popup.closed, true); assert.equal(f.requests.length, 0);
});

test("a missing helper times out with the application name and retry action", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture(t), pending = f.attempt.connect(new AbortController().signal);
  t.mock.timers.tick(12_000);
  await assert.rejects(pending, /打开“折页同步助手”/); assert.equal(f.requests.length, 0);
});

test("closing the pairing window rejects promptly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture(t), pending = f.attempt.connect(new AbortController().signal);
  f.popup.close(); t.mock.timers.tick(300);
  await assert.rejects(pending, /连接窗口已关闭/);
});

test("malformed response and a different service device are never accepted", async (t) => {
  await t.test("malformed credentials", async (t) => {
    const f = fixture(t), pending = f.attempt.connect(new AbortController().signal), nonce = f.ready();
    f.send({ type: "zhepage-local-connected", nonce, deviceId, connectionToken: "bad\nsecret" });
    await assert.rejects(pending, /连接信息不完整/); assert.equal(f.requests.length, 0);
  });
  await t.test("different device", async (t) => {
    const f = fixture(t, { otherDevice: "c".repeat(32) }), pending = f.attempt.connect(new AbortController().signal);
    f.connected(f.ready()); await assert.rejects(pending, /电脑与本机助手不一致/);
  });
});

test("abort during service verification discards the result", async (t) => {
  const f = fixture(t), controller = new AbortController();
  let complete;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { complete = resolve; }));
  const pending = f.attempt.connect(controller.signal); f.connected(f.ready());
  await Promise.resolve(); controller.abort(new Error("cancelled"));
  complete(new Response(JSON.stringify({ deviceId })));
  await assert.rejects(pending, /cancelled/); assert.equal(f.popup.closed, true);
});
