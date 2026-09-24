import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";
const { localSyncFetch } = loadDomModule("lib/localSync/transport.ts");
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
