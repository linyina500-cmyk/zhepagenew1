import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

// Exercise the real TypeScript client and its imported module boundary. Only
// storage and transport are replaced; no browser or platform account is opened.
const storage = loadDomModule("lib/draftSync/credentialStore.ts");
const client = loadDomModule("lib/draftSync/cloudClient.ts");
const account = { id: "a1b2c3d4", platform: "wechat", remoteId: "wx-example", displayName: "Example", ready: true };
const connection = { csrf: "test-csrf" };
const content = { title: "Title", body: "Copy" };
const images = [{ id: "image-1", name: "poster.png", blob: new Blob(["png"], { type: "image/png" }), width: 1080, height: 1440 }];
const savedReceipt = { accountId: account.id, platform: account.platform, status: "saved", draftId: "draft-1", message: "saved" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://editor.example/" });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
  t.after(() => {
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  });
  const state = {
    events: [], requests: [], expiredEvents: [], pending: new Map(),
    envelope: "old-envelope", failLock: false, failStorage: false,
    respond: () => { throw new Error("Unexpected HTTP request"); },
  };
  dom.window.addEventListener("zhepage-sync-session-expired", (event) => state.expiredEvents.push(event));
  t.mock.method(storage, "getCredential", async (id) => {
    assert.equal(id, account.id);
    return { account, envelope: state.envelope };
  });
  t.mock.method(storage, "lockSync", async (target, requestId) => {
    assert.equal(target.id, account.id);
    state.events.push("lock");
    if (state.failLock) throw new Error("Storage unavailable");
    assert.equal(state.pending.has(target.id), false);
    state.pending.set(target.id, requestId);
  });
  t.mock.method(storage, "saveCredential", async (target, envelope) => {
    assert.equal(target.id, account.id);
    state.events.push(`store:${envelope}`);
    if (state.failStorage) throw new Error("Storage quota exceeded");
    state.envelope = envelope;
  });
  t.mock.method(storage, "unlockSync", async (target, requestId) => {
    assert.equal(target.id, account.id);
    assert.equal(state.pending.get(target.id), requestId, "must release only the marker belonging to this request");
    state.events.push("unlock");
    state.pending.delete(target.id);
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("/api/sync/"), "requests must use the same-origin proxy");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    if (url !== "/api/sync/session") assert.equal(options.headers["X-CSRF-Token"], connection.csrf);
    const request = { url, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) };
    state.requests.push(request);
    state.events.push(options.method);
    return state.respond(request);
  });
  return { state, window: dom.window, sync: () => client.syncDraft(connection, account, content, images) };
}

describe("cloud client protocol and storage failures", { concurrency: false }, () => {
  test("persists the marker before sending and the latest envelope before unlocking a verified save", async (t) => {
    const { state, sync } = harness(t);
    state.respond = ({ url, method, body }) => {
      assert.equal(state.pending.has(account.id), true, "network work must begin only after the marker is saved");
      if (method === "POST") {
        assert.equal(url, "/api/sync/jobs");
        assert.equal(body.requestId, state.pending.get(account.id));
        assert.equal(body.envelope, "old-envelope");
        assert.deepEqual(body.content, content);
        assert.deepEqual(body.images, [{ id: "image-1", name: "poster.png", mime: "image/png", width: 1080, height: 1440, base64: "cG5n" }]);
        return json({ id: body.requestId, state: "running" });
      }
      assert.equal(url, `/api/sync/jobs/${state.pending.get(account.id)}`);
      return json({ state: "finished", receipt: savedReceipt, envelope: "latest-envelope" });
    };
    assert.deepEqual(await sync(), savedReceipt);
    assert.deepEqual(state.events, ["lock", "POST", "GET", "store:latest-envelope", "unlock"]);
    assert.equal(state.envelope, "latest-envelope");
    assert.equal(state.pending.has(account.id), false);
  });

  test("does not send any HTTP request if the durable marker cannot be created", async (t) => {
    const { state, sync } = harness(t);
    state.failLock = true;
    assert.equal((await sync()).status, "needs_confirmation");
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.events, ["lock"]);
  });

  test("reconciles a lost create response with GET on the same identifier and never repeats the POST", async (t) => {
    const { state, sync } = harness(t);
    state.respond = () => { throw new TypeError("Network disconnected"); };
    assert.equal((await sync()).status, "needs_confirmation");
    assert.deepEqual(state.requests.map(({ method }) => method), ["POST", "GET"]);
    const requestId = state.requests[0].body.requestId;
    assert.equal(state.requests[1].url, `/api/sync/jobs/${requestId}`);
    assert.equal(state.pending.get(account.id), requestId);
    assert.deepEqual(state.events, ["lock", "POST", "GET"]);
  });

  test("a definite 4xx creation rejection restores the stored envelope and releases only this request marker", async (t) => {
    const { state, sync } = harness(t);
    state.pending.set("another-account", "another-pending-request");
    state.respond = () => json({ error: "Another operation is active" }, 409);
    const result = await sync();
    assert.equal(result.status, "failed");
    assert.match(result.message, /Another operation is active/);
    assert.deepEqual(state.requests.map(({ method }) => method), ["POST"]);
    assert.deepEqual(state.events, ["lock", "POST", "store:old-envelope", "unlock"]);
    assert.equal(state.pending.has(account.id), false);
    assert.equal(state.pending.get("another-account"), "another-pending-request");
  });

  test("a verified save whose new envelope cannot be persisted stays uncertain and locked", async (t) => {
    const { state, sync } = harness(t);
    state.failStorage = true;
    state.respond = ({ method, body }) => method === "POST"
      ? json({ id: body.requestId, state: "running" })
      : json({ state: "finished", receipt: savedReceipt, envelope: "latest-envelope" });
    assert.equal((await sync()).status, "needs_confirmation");
    assert.deepEqual(state.events, ["lock", "POST", "GET", "store:latest-envelope"]);
    assert.equal(state.pending.has(account.id), true);
    assert.equal(state.envelope, "old-envelope");
  });

  test("503 session response reports the explicit deployment message without claiming readiness", async (t) => {
    const { state } = harness(t);
    state.respond = () => json({ error: "Upstream is not configured" }, 503);
    await assert.rejects(client.getCloudSession(), { message: client.UNCONFIGURED_MESSAGE });
    assert.deepEqual(state.requests, [{ url: "/api/sync/session", method: "GET" }]);
    assert.equal(state.expiredEvents.length, 0);
  });

  test("422 expired platform authorization does not expire the service login", async (t) => {
    const { state, sync } = harness(t);
    state.respond = () => json({ error: "平台授权已过期，请重新连接账号" }, 422);
    const result = await sync();
    assert.equal(result.status, "failed");
    assert.match(result.message, /平台授权已过期/);
    assert.equal(state.expiredEvents.length, 0);
    assert.equal(state.pending.has(account.id), false);
    assert.deepEqual(state.requests.map(({ method }) => method), ["POST"]);
  });

  test("401 service expiration dispatches an Event from the window realm and stops before a job is created", async (t) => {
    const { state, sync, window } = harness(t);
    // Keep Node's global Event untouched: JSDOM rejects events from that realm.
    // Using window.Event in the client is required for this dispatch to succeed.
    state.respond = () => json({ error: "Service session expired" }, 401);
    const result = await sync();
    assert.equal(state.expiredEvents.length, 1);
    assert.ok(state.expiredEvents[0] instanceof window.Event);
    assert.equal(result.status, "failed");
    assert.match(result.message, /同步服务登录已过期/);
    assert.equal(state.pending.has(account.id), false);
    assert.deepEqual(state.requests.map(({ method }) => method), ["POST"]);
  });
});
