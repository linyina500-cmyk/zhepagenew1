import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const { beginLocalSyncConnection } = loadDomModule("lib/localSync/connection.ts");
const { LocalSyncBrowserError } = loadDomModule("lib/localSync/transport.ts");
const origin = "http://127.0.0.1:8789";
const deviceId = "a".repeat(32), token = "b".repeat(64);
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const signal = () => new AbortController().signal;

function fixture(t, options = {}) {
  const dom = installDom(), requests = [], opened = [];
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: options.userAgent || "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36" });
  t.mock.method(window, "open", (...args) => { opened.push(args); throw new Error("pairing must not open a window"); });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    if (url === `${origin}/pair`) {
      if (options.pair) return options.pair(init);
      return response({ nonce: JSON.parse(init.body).nonce, deviceId, connectionToken: token });
    }
    if (options.verify) return options.verify(init);
    return response({ deviceId: options.otherDevice || deviceId });
  });
  const attempt = beginLocalSyncConnection();
  t.after(() => { attempt.close(); dom.window.close(); });
  return { attempt, requests, opened };
}

test("Safari pairing gives its browser instruction immediately without a timer or request", async (t) => {
  const f = fixture(t, { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" });
  t.mock.method(globalThis, "setTimeout", () => assert.fail("unsupported browser must not wait for a timeout"));
  await assert.rejects(f.attempt.connect(signal()), (error) => error instanceof LocalSyncBrowserError && /这台 Mac 上的 Chrome/.test(error.message));
  assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
});

test("a click pairs directly with a fresh challenge and verifies the service without opening a window", async (t) => {
  const f = fixture(t);
  assert.equal(f.requests.length, 0, "creating an attempt does not connect before the user operation starts");
  assert.deepEqual(await f.attempt.connect(signal()), { deviceId, connectionToken: token });
  assert.equal(f.requests.length, 2);
  const pair = f.requests[0], challenge = JSON.parse(pair.init.body);
  assert.equal(pair.url, `${origin}/pair`);
  assert.deepEqual(Object.keys(challenge), ["nonce"]);
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
  assert.equal(pair.init.method, "POST");
  assert.deepEqual(pair.init.headers, { "Content-Type": "application/json" });
  assert.equal(pair.init.credentials, "omit");
  assert.equal(pair.init.redirect, "error");
  assert.equal(pair.init.cache, "no-store");
  assert.equal(f.requests[1].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(f.requests[1].init.method, "GET");
  assert.ok(f.requests[1].url.endsWith("/connection"));
  assert.equal(f.opened.length, 0);
  for (const request of f.requests) {
    assert.ok(!request.url.includes(token));
    assert.ok(!request.url.includes(challenge.nonce));
  }
  await assert.rejects(f.attempt.connect(signal()), /正在处理中/);
  assert.equal(f.requests.length, 2);
  const second = beginLocalSyncConnection();
  t.after(() => second.close());
  await second.connect(signal());
  assert.notEqual(JSON.parse(f.requests[2].init.body).nonce, challenge.nonce);
});

test("network denial or an unavailable helper gives actionable inline help without a window", async (t) => {
  for (const pair of [async () => { throw new TypeError("Failed to fetch"); }, async () => response({}, 403), async () => response({}, 503)]) {
    await t.test("connection unavailable", async (t) => {
      const f = fixture(t, { pair });
      await assert.rejects(f.attempt.connect(signal()), (error) => /请先打开折页同步助手/.test(error.message) && /Chrome 提示访问本机，请允许/.test(error.message));
      assert.equal(f.requests.length, 1); assert.equal(f.opened.length, 0);
    });
  }
});

test("malformed credentials and mismatched challenges never reach authenticated verification", async (t) => {
  const invalid = [null, [], {}, { nonce: "0".repeat(64) }, { deviceId: "wrong-device" }, { connectionToken: "short" }, { connectionToken: "x".repeat(257) }, { connectionToken: "x".repeat(32) + "\0" }, { connectionToken: "x".repeat(32) + " " }];
  for (const value of invalid) {
    await t.test("invalid pairing response", async (t) => {
      const f = fixture(t, { pair: async (init) => response(value === null || Array.isArray(value) || !Object.keys(value).length ? value : { nonce: JSON.parse(init.body).nonce, deviceId, connectionToken: token, ...value }) });
      await assert.rejects(f.attempt.connect(signal()), /连接信息不完整/);
      assert.equal(f.requests.length, 1);
    });
  }
  await t.test("invalid JSON", async (t) => {
    const f = fixture(t, { pair: async () => new Response("invalid json") });
    await assert.rejects(f.attempt.connect(signal()), /连接信息不完整/);
    assert.equal(f.requests.length, 1);
  });
});

test("a different service device is never accepted", async (t) => {
  const f = fixture(t, { otherDevice: "c".repeat(32) });
  await assert.rejects(f.attempt.connect(signal()), /电脑与本机助手不一致/);
  assert.equal(f.requests.length, 2);
});

test("failed authenticated verification retains the local access guidance", async (t) => {
  const f = fixture(t, { verify: async () => { throw new TypeError("network lost"); } });
  await assert.rejects(f.attempt.connect(signal()), /Chrome 提示访问本机，请允许/);
  assert.equal(f.requests.length, 2);
});

test("the total deadline covers both pairing and service verification even when a request hangs", async (t) => {
  for (const stage of ["pair", "verify"]) {
    await t.test(stage, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let started;
      const entered = new Promise((resolve) => { started = resolve; });
      const f = fixture(t, { [stage]: async () => { started(); return new Promise(() => {}); } });
      const pending = f.attempt.connect(signal());
      const rejected = assert.rejects(pending, /请先打开折页同步助手/);
      await entered;
      t.mock.timers.tick(9_000);
      await rejected;
      assert.equal(f.requests.at(-1).init.signal.aborted, true);
    });
  }
});

test("service verification uses only the remaining overall deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishPair, enteredVerification;
  const verifying = new Promise((resolve) => { enteredVerification = resolve; });
  const f = fixture(t, {
    pair: (init) => new Promise((resolve) => { finishPair = () => resolve(response({ nonce: JSON.parse(init.body).nonce, deviceId, connectionToken: token })); }),
    verify: async () => { enteredVerification(); return new Promise(() => {}); },
  });
  const pending = f.attempt.connect(signal());
  const rejected = assert.rejects(pending, /请先打开折页同步助手/);
  t.mock.timers.tick(4_000); finishPair(); await verifying;
  t.mock.timers.tick(5_000); await rejected;
  assert.equal(f.requests[1].init.signal.aborted, true);
});

test("a completed connection removes its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  await f.attempt.connect(signal());
  t.mock.timers.tick(9_000);
  assert.equal(f.requests[0].init.signal.aborted, false);
});

test("closing or cancelling before connection does not send a request", async (t) => {
  const f = fixture(t);
  f.attempt.close();
  await assert.rejects(f.attempt.connect(signal()), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  const other = beginLocalSyncConnection(), controller = new AbortController(), reason = new Error("cancelled");
  t.after(() => other.close());
  controller.abort(reason);
  await assert.rejects(other.connect(controller.signal), (error) => error === reason);
  assert.equal(f.requests.length, 0);
});

test("cancellation stops a pending request and rejects late pairing or verification results", async (t) => {
  for (const stage of ["pair", "verify"]) {
    await t.test(stage, async (t) => {
      let finish, started;
      const entered = new Promise((resolve) => { started = resolve; });
      const f = fixture(t, { [stage]: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
      const controller = new AbortController(), reason = new Error("cancelled");
      const pending = f.attempt.connect(controller.signal);
      const rejected = assert.rejects(pending, (error) => error === reason);
      await entered;
      controller.abort(reason);
      await rejected;
      assert.equal(f.requests.at(-1).init.signal.aborted, true);
      finish(response({ nonce: JSON.parse(f.requests[0].init.body).nonce, deviceId, connectionToken: token }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.requests.length, stage === "pair" ? 1 : 2);
    });
  }
});

test("close cancels an active connection without waiting for the deadline", async (t) => {
  const f = fixture(t, { pair: async () => new Promise(() => {}) });
  const pending = f.attempt.connect(signal());
  const rejected = assert.rejects(pending, { name: "AbortError" });
  f.attempt.close();
  await rejected;
  assert.equal(f.requests[0].init.signal.aborted, true);
});
