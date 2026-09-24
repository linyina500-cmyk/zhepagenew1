import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";
const { localSyncFetch, LocalSyncBrowserError, assertLocalSyncBrowser } = loadDomModule("lib/localSync/transport.ts");

function browser(t, userAgent, platform = "MacIntel", maxTouchPoints = 0) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent, platform, maxTouchPoints } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete globalThis.navigator; });
}

test("Safari and iOS stop with a browser instruction before any local request", async (t) => {
  for (const [name, agent, platform, touches] of [
    ["Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "MacIntel", 0],
    ["iPhone Chrome", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1", "iPhone", 5],
    ["iPad desktop mode", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "MacIntel", 5],
  ]) {
    await t.test(name, (t) => {
      browser(t, agent, platform, touches);
      t.mock.method(globalThis, "fetch", () => assert.fail("unsupported browser reached network"));
      assert.throws(assertLocalSyncBrowser, LocalSyncBrowserError);
      for (const path of ["/api/wechat/connection", "/api/xiaohongshu/account"]) {
        assert.throws(() => localSyncFetch(path), (error) => error instanceof LocalSyncBrowserError && error.message === "请使用这台 Mac 上的 Chrome 浏览器连接本机助手，当前浏览器不支持此连接。");
      }
    });
  }
});

test("desktop Chrome, Chromium, Edge and Firefox keep their local connection", async (t) => {
  for (const agent of [
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chromium/140.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Edg/140.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0",
  ]) {
    await t.test(agent, async (t) => {
      browser(t, agent);
      let calls = 0;
      t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("{}"); });
      assert.doesNotThrow(assertLocalSyncBrowser);
      await localSyncFetch("/api/wechat/connection");
      assert.equal(calls, 1);
    });
  }
});
test("both platforms send credentials and complete bodies only to this computer", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return new Response("{}"); });
  for (const path of ["/api/wechat/accounts/abcd/jobs", "/api/xiaohongshu/jobs/fixture/verify"]) {
    const body = new FormData(); body.append("images", new Blob(["full image bytes"]), "1.png");
    const signal = new AbortController().signal;
    await localSyncFetch(path, { method: "POST", headers: { Authorization: "Bearer synthetic-token" }, body, signal });
    const [url, options] = calls.at(-1);
    assert.equal(url, `http://127.0.0.1:8788${path}`);
    assert.equal(options.body, body); assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, "Bearer synthetic-token");
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    assert.equal(options.mode, "cors"); assert.equal(options.cache, "no-store");
    assert.equal(options.targetAddressSpace, "loopback");
  }
  assert.equal(calls.length, 2);
});
test("untrusted destinations and credentials in URLs cannot reach fetch", (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("invalid address reached network"));
  for (const input of ["https://example.com/api/wechat/connection", "//example.com/api/wechat/connection", "/api/wechat/connection?token=secret", "/api/wechat/../pair", "/pair", new URL("http://127.0.0.1:8788/api/wechat/connection")]) {
    assert.throws(() => localSyncFetch(input), /地址无效/);
  }
});
