import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const { getStartupConnection } = loadDomModule("lib/draftSync/companionClient.ts");
const { addXiaohongshuAccount, cancelXiaohongshuLogin } = loadDomModule("lib/draftSync/companionClient.ts");
const token = "startup-test-token-only-not-a-real-account-key";
const loginRequestId = "11111111-1111-4111-8111-111111111111";

test("launcher handoff disappears from history and remains reusable only in page memory", () => {
  const dom = installDom();
  try {
    dom.reconfigure({ url: `http://127.0.0.1:5173/?preview=1#zhepage-pairing=${token}&view=draft` });
    window.history.replaceState({ navigation: "preserved" }, "");
    assert.deepEqual(getStartupConnection(), { token });
    assert.equal(window.location.href, "http://127.0.0.1:5173/?preview=1#view=draft");
    assert.deepEqual(window.history.state, { navigation: "preserved" });
    const copy = getStartupConnection();
    copy.token = "changed-by-caller";
    assert.deepEqual(getStartupConnection(), { token });
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);

    dom.reconfigure({ url: "http://localhost:5173/" });
    assert.equal(getStartupConnection(), null, "a different origin cannot reuse the cached handoff");
  } finally { dom.window.close(); }
});

test("public, HTTPS, ambiguous, and malformed handoffs are removed without becoming connections", () => {
  const dom = installDom();
  try {
    const cases = [
      `https://feature-local-draft-sync.zhepagenew.pages.dev/#zhepage-pairing=${token}`,
      `http://127.0.0.1.attacker.example/#zhepage-pairing=${token}`,
      `https://127.0.0.1:5173/#zhepage-pairing=${token}`,
      `http://127.0.0.1:5173/#zhepage-pairing=${token}&zhepage-pairing=duplicate`,
      "http://127.0.0.1:5173/#zhepage-pairing=short",
      "http://127.0.0.1:5173/#zhepage-pairing=" + "x".repeat(129),
      "http://127.0.0.1:5173/#zhepage-pairing=" + "x".repeat(32) + "%0A",
    ];
    for (const url of cases) {
      dom.reconfigure({ url });
      assert.equal(getStartupConnection(), null);
      assert.equal(window.location.hash, "");
      assert.equal(window.localStorage.length, 0);
      assert.equal(window.sessionStorage.length, 0);
    }
  } finally { dom.window.close(); }
});

test("a handoff is not accepted when the browser cannot remove it from history", (context) => {
  const dom = installDom();
  try {
    dom.reconfigure({ url: `http://127.0.0.1:5173/#zhepage-pairing=${token}` });
    context.mock.method(window.history, "replaceState", () => { throw new Error("history unavailable"); });
    assert.equal(getStartupConnection(), null);
  } finally { dom.window.close(); }
});

test("a caller can stop login waiting after the helper confirms cancellation", async (context) => {
  const dom = installDom();
  let activeSignal;
  const control = new AbortController();
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:47831/api/accounts/xiaohongshu");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { displayName: "仅用于测试的账号", loginRequestId });
    activeSignal = options.signal;
    return new Promise((_resolve, reject) => {
      if (activeSignal.aborted) reject(new DOMException("cancelled", "AbortError"));
      else activeSignal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  });
  try {
    const pending = addXiaohongshuAccount({ token }, "仅用于测试的账号", loginRequestId, control.signal);
    control.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(activeSignal.aborted, true);
  } finally { dom.window.close(); }
});

test("login cancellation accepts only the helper's explicit completed outcome", async (context) => {
  const dom = installDom();
  let payload;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:47831/api/accounts/cancel-login");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(options.body), { loginRequestId });
    return Response.json(payload);
  });
  try {
    for (const cancelled of [true, false]) {
      payload = { cancelled };
      assert.equal(await cancelXiaohongshuLogin({ token }, loginRequestId), cancelled);
    }
    for (const invalid of [{}, { cancelled: "true" }, { ok: true }, null]) {
      payload = invalid;
      await assert.rejects(cancelXiaohongshuLogin({ token }, loginRequestId), /尚未确认登录是否结束/);
    }
  } finally { dom.window.close(); }
});

test("login and cancellation carry the same caller-owned request identity", async (context) => {
  const dom = installDom();
  const requests = [];
  const ids = [loginRequestId, "22222222-2222-4222-8222-222222222222"];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ path: new URL(url).pathname, body });
    if (url.endsWith("/cancel-login")) return Response.json({ cancelled: false });
    return Response.json({ account: { id: body.loginRequestId, platform: "xiaohongshu", displayName: body.displayName, remoteId: "fixture-creator", ready: true } });
  });
  try {
    for (const id of ids) await addXiaohongshuAccount({ token }, "测试账号", id);
    // A delayed cancellation must retain the older identity even after a newer
    // login has used the same client and connection.
    await cancelXiaohongshuLogin({ token }, ids[0]);
    await cancelXiaohongshuLogin({ token }, ids[1]);
    assert.deepEqual(requests, [
      ...ids.map((id) => ({ path: "/api/accounts/xiaohongshu", body: { displayName: "测试账号", loginRequestId: id } })),
      ...ids.map((id) => ({ path: "/api/accounts/cancel-login", body: { loginRequestId: id } })),
    ]);
  } finally { dom.window.close(); }
});
