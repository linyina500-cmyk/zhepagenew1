import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createCloudBrowser } from "../cloud/browser.mjs";
import { createCloudSync } from "../cloud/server.mjs";

const origin = "https://test-only.zhepage.example";
const gatewaySecret = "test-only-gateway-key-never-a-production-secret";
const passwords = { 1: "test-only-account-sealing-key-never-use-in-production" };
const accessPassword = "test-only-service-password";
const appId = "wx1234567890abcdef";
const appSecret = "test-only-platform-secret-must-not-be-reflected";
const secretUrl = `https://platform.invalid/request?access_token=${appSecret}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const image = { name: "test.png", mime: "image/png", base64: png.toString("base64"), width: 1, height: 1 };
const content = { title: "仅用于接口测试", body: "测试素材不会发往真实平台" };
const qr = "data:image/jpeg;base64,dGVzdC1vbmx5LXFy";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(version) {
  return {
    cookies: [{ name: "test_session", value: `test-only-session-${version}`, domain: ".xiaohongshu.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    origins: [{ origin: "https://creator.xiaohongshu.com", localStorage: [{ name: "test_version", value: String(version) }], indexedDB: [], opfs: [] }],
  };
}

async function until(read, matches, message = "mock operation did not reach the expected state") {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture(context, options = {}) {
  const calls = [];
  const runtimes = [];
  const events = [];
  const defaults = {
    verifyWechatAccount: async ({ appId: id }) => ({ remoteId: id, displayName: "模拟公众号" }),
    saveWechatDraft: async () => ({ status: "saved", draftId: "mock-wechat-draft", message: "模拟平台已核对保存" }),
    loginXiaohongshu: async () => ({ remoteId: "creator-test-123", displayName: "模拟创作者" }),
    saveXiaohongshuDraft: async () => ({ status: "needs_confirmation", message: "模拟草稿待人工核对" }),
  };
  const providers = Object.fromEntries(Object.keys(defaults).map((name) => [name, async (input) => {
    calls.push({ name, input });
    return (options.providers?.[name] ?? defaults[name])(input);
  }]));
  const browserFactory = async (input = {}) => {
    const number = runtimes.length + 1;
    const runtime = {
      number, input, closed: false, closeCount: 0, context: { testRuntime: number },
      snapshot: async () => {
        events.push(`snapshot:${number}`);
        return options.snapshot ? await options.snapshot(runtime) : snapshot(number);
      },
      screenshot: async () => {
        assert.equal(runtime.closed, false, "a closed runtime must never be captured");
        return options.screenshot ? await options.screenshot(runtime) : qr;
      },
      close: async () => {
        runtime.closeCount++;
        events.push(`close:${number}`);
        await options.runtimeClose?.(runtime);
        runtime.closed = true;
      },
    };
    runtimes.push(runtime);
    await options.runtimeReady?.(runtime);
    return runtime;
  };
  const service = createCloudSync({ passwords, accessPassword, gatewaySecret, allowedOrigins: [origin], port: 0, providers, browserFactory, ...options.server });
  const port = await service.listen();
  const client = { cookie: options.client?.cookie ?? "", csrf: options.client?.csrf ?? "" };
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.close(); } };
  context.after(close);
  const headers = (changes = {}) => ({
    "x-sync-gateway": gatewaySecret, Origin: origin, "Content-Type": "application/json",
    Cookie: client.cookie, "x-csrf-token": client.csrf, ...changes,
  });
  const request = async (endpoint, body, changes) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sync${endpoint}`, {
      method: body === undefined ? "GET" : "POST", headers: headers(changes),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (remember = false) => {
    const response = await request("/session", { password: accessPassword, remember });
    assert.equal(response.status, 200);
    client.cookie = response.headers.get("set-cookie").split(";")[0];
    client.csrf = response.data.csrf;
    return response;
  };
  if (options.login !== false && !client.cookie) await login();
  const wechat = async () => {
    const response = await request("/accounts/wechat", { displayName: "模拟公众号", appId, appSecret });
    assert.equal(response.status, 200);
    return response.data;
  };
  const waitJob = async (id) => until(() => request(`/jobs/${id}`), (response) => response.data.state === "finished");
  const waitLogin = async (id) => until(() => request(`/logins/${id}`), (response) => ["complete", "failed"].includes(response.data.state));
  const xhs = async () => {
    const id = randomUUID();
    const response = await request("/logins", { loginRequestId: id, displayName: "模拟小红书" });
    assert.equal(response.status, 200);
    const done = await waitLogin(id);
    assert.equal(done.data.state, "complete");
    await until(() => runtimes.at(-1).closed, Boolean);
    return done.data;
  };
  const job = (envelope, changes = {}) => ({ requestId: randomUUID(), envelope, content, images: [image], ...changes });
  const count = (name) => calls.filter((call) => call.name === name).length;
  const loseResponse = (endpoint, body) => new Promise((resolve, reject) => {
    const outgoing = http.request(`http://127.0.0.1:${port}/api/sync${endpoint}`, { method: "POST", headers: headers() }, (incoming) => {
      // Simulate losing the submission reply: no status or payload is consumed.
      incoming.destroy();
      outgoing.destroy();
      resolve();
    });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(body));
  });
  return { service, port, client, calls, runtimes, events, request, login, wechat, xhs, job, waitJob, waitLogin, close, count, loseResponse };
}

test("gateway, origin, session and CSRF checks reject requests before platform access", async (context) => {
  const app = await fixture(context, { login: false });
  assert.equal((await app.request("/session", undefined, { "x-sync-gateway": "" })).status, 403);
  assert.equal((await app.request("/session", undefined, { "x-sync-gateway": "forged" })).status, 403);
  for (const Origin of ["", "null", "https://evil.example", `${origin}.evil.example`]) {
    assert.equal((await app.request("/session", { password: accessPassword, remember: false }, { Origin })).status, 403);
  }
  assert.deepEqual((await app.request("/session")).data, { configured: true, authenticated: false });
  assert.equal((await app.request("/accounts/inspect", { envelopes: [] })).status, 401);
  await app.login();
  assert.equal((await app.request("/accounts/inspect", { envelopes: [] }, { "x-csrf-token": "wrong" })).status, 403);
  assert.equal((await app.request("/accounts/inspect", { envelopes: [] }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal(app.calls.length, 0);
  assert.equal(app.runtimes.length, 0);
});

test("login cookies are secure and only remembered logins have a persistent expiry", async (context) => {
  const app = await fixture(context, { login: false });
  assert.equal((await app.request("/session", { password: "wrong", remember: false })).status, 401);
  for (const remember of [false, true]) {
    const response = await app.login(remember);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^__Host-zhepage_sync=/);
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"]) assert.ok(cookie.includes(attribute));
    assert.equal(cookie.includes("Max-Age="), remember);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.ok(Buffer.byteLength(cookie) < 4096);
    assert.equal(cookie.includes(accessPassword), false);
    const session = await app.request("/session");
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.csrf, response.data.csrf);
    assert.equal(session.headers.get("cache-control"), "no-store");
  }
});

test("browser-held WeChat envelopes survive a fresh server with the same keys and session", async (context) => {
  const first = await fixture(context);
  const connected = await first.wechat();
  assert.equal(connected.account.remoteId, appId);
  assert.equal(connected.account.ready, true);
  assert.equal(connected.account.syncBlocked, false);
  for (const value of [appSecret, "appSecret", accessPassword]) assert.equal(JSON.stringify(connected).includes(value), false);
  assert.equal(typeof connected.envelope, "string");
  const client = { ...first.client };
  await first.close();
  const second = await fixture(context, { client });
  assert.equal((await second.request("/session")).data.authenticated, true);
  const inspected = await second.request("/accounts/inspect", { envelopes: [connected.envelope] });
  assert.deepEqual(inspected.data.accounts, [connected.account]);
  const input = second.job(connected.envelope);
  assert.equal((await second.request("/jobs", input)).status, 200);
  const completed = await second.waitJob(input.requestId);
  assert.equal(completed.data.receipt.status, "saved");
  assert.equal(typeof completed.data.envelope, "string");
  assert.notEqual(completed.data.envelope, connected.envelope);
  assert.equal((await second.request("/accounts/inspect", { envelopes: [completed.data.envelope] })).data.accounts[0].id, connected.account.id);
  assert.equal(second.count("verifyWechatAccount"), 0, "restart must not require resubmitting AppSecret");
  const call = second.calls.find(({ name }) => name === "saveWechatDraft");
  assert.equal(call.input.account.appSecret, appSecret);
  assert.deepEqual(call.input.draft.images[0].bytes, png);
});

test("tampered authorization envelopes cannot reach providers or create a runtime", async (context) => {
  const app = await fixture(context);
  const connected = await app.wechat();
  const parts = connected.envelope.split("*");
  parts[4] = `${parts[4][0] === "A" ? "B" : "A"}${parts[4].slice(1)}`;
  const invalid = [parts.join("*"), `${connected.envelope}x`, "forged"];
  for (const envelope of invalid) assert.equal((await app.request("/jobs", app.job(envelope))).status, 422);
  const inspected = await app.request("/accounts/inspect", { envelopes: [...invalid, connected.envelope] });
  assert.deepEqual(inspected.data.invalidIndexes, [0, 1, 2]);
  assert.equal(inspected.data.accounts.length, 1);
  assert.equal(app.count("saveWechatDraft"), 0);
  assert.equal(app.runtimes.length, 0);
});

test("HTTP image validation rejects fake bytes, MIME mismatches and forged dimensions", async (context) => {
  const app = await fixture(context);
  const { envelope } = await app.wechat();
  for (const changes of [{ base64: "https://evil.example/private.png" }, { base64: "abcd====" }, { mime: "image/jpeg" }, { width: 1080 }, { height: 0 }]) {
    assert.equal((await app.request("/jobs", app.job(envelope, { images: [{ ...image, ...changes }] }))).status, 400);
  }
  assert.equal((await app.request("/jobs", app.job(envelope, { images: [] }))).status, 400);
  assert.equal(app.count("saveWechatDraft"), 0);
  const input = app.job(envelope);
  assert.equal((await app.request("/jobs", input)).status, 200);
  await app.waitJob(input.requestId);
  assert.deepEqual(app.calls.find(({ name }) => name === "saveWechatDraft").input.draft.images[0].bytes, png);
});

for (const platform of ["wechat", "xiaohongshu"]) {
  test(`${platform} enforces twenty title characters and ten topics before invoking its provider`, async (context) => {
    const app = await fixture(context);
    const { envelope } = await (platform === "wechat" ? app.wechat() : app.xhs());
    const save = platform === "wechat" ? "saveWechatDraft" : "saveXiaohongshuDraft";
    for (const invalid of [
      { title: "图".repeat(21), body: "正文" },
      { title: "标题", body: Array.from({ length: 11 }, (_, index) => `#话题${index}`).join(" ") },
    ]) assert.equal((await app.request("/jobs", app.job(envelope, { content: invalid }))).status, 400);
    assert.equal(app.count(save), 0);
    const input = app.job(envelope, { content: { title: "图".repeat(20), body: Array.from({ length: 10 }, (_, index) => `#话题${index}`).join(" ") } });
    assert.equal((await app.request("/jobs", input)).status, 200);
    await app.waitJob(input.requestId);
    assert.equal(app.count(save), 1);
  });
}

test("a request ID is idempotent while running and finished but cannot change its materials", async (context) => {
  const pending = deferred();
  context.after(() => pending.resolve({ status: "saved", draftId: "mock-idempotent", message: "模拟保存" }));
  const app = await fixture(context, { providers: { saveWechatDraft: async () => pending.promise } });
  const { envelope } = await app.wechat();
  const input = app.job(envelope);
  assert.equal((await app.request("/jobs", input)).status, 200);
  assert.equal((await app.request("/jobs", input)).status, 200);
  assert.equal((await app.request("/jobs", { ...input, content: { ...content, title: "不同标题" } })).status, 409);
  assert.equal((await app.request("/jobs", { ...input, images: [{ ...image, name: "changed.png" }] })).status, 409);
  assert.equal(app.count("saveWechatDraft"), 1);
  pending.resolve({ status: "saved", draftId: "mock-idempotent", message: "模拟保存" });
  await app.waitJob(input.requestId);
  assert.equal((await app.request("/jobs", input)).status, 200);
  assert.equal(app.count("saveWechatDraft"), 1);
});

test("losing the POST response is recovered by GET without sending the draft again", async (context) => {
  const pending = deferred();
  context.after(() => pending.resolve({ status: "saved", draftId: "mock-recovered", message: "模拟保存" }));
  const app = await fixture(context, { providers: { saveWechatDraft: async () => pending.promise } });
  const { envelope } = await app.wechat();
  const input = app.job(envelope);
  await app.loseResponse("/jobs", input);
  assert.equal((await app.request(`/jobs/${input.requestId}`)).data.state, "running");
  pending.resolve({ status: "saved", draftId: "mock-recovered", message: "模拟保存" });
  assert.equal((await app.waitJob(input.requestId)).data.receipt.draftId, "mock-recovered");
  await app.request(`/jobs/${input.requestId}`);
  assert.equal(app.count("saveWechatDraft"), 1);
});

test("XHS login IDs are idempotent and cancellation only closes the matching login", async (context) => {
  const app = await fixture(context, { providers: { loginXiaohongshu: async ({ signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) } });
  const id = randomUUID();
  const input = { loginRequestId: id, displayName: "模拟小红书" };
  assert.equal((await app.request("/logins", input)).data.id, id);
  assert.equal((await app.request("/logins", input)).data.id, id);
  const waiting = await until(() => app.request(`/logins/${id}`), (response) => Boolean(response.data.image));
  assert.equal(waiting.data.image, qr);
  assert.equal(app.count("loginXiaohongshu"), 1);
  assert.equal((await app.request(`/logins/${randomUUID()}/cancel`, {})).data.cancelled, false);
  assert.equal(app.runtimes[0].closed, false);
  assert.equal((await app.request(`/logins/${id}/cancel`, {})).data.cancelled, true);
  assert.equal((await app.waitLogin(id)).data.state, "failed");
  assert.equal(app.runtimes[0].closeCount, 1);
  assert.equal((await app.request(`/logins/${id}/cancel`, {})).data.cancelled, false);
});

test("successful XHS login snapshots before close and a later job restores the sealed state", async (context) => {
  const app = await fixture(context);
  const connected = await app.xhs();
  assert.deepEqual(app.events.slice(0, 2), ["snapshot:1", "close:1"]);
  assert.equal(app.runtimes[0].closeCount, 1);
  assert.equal(JSON.stringify(connected).includes("test-only-session-1"), false);
  assert.equal("storageState" in connected.account, false);
  const input = app.job(connected.envelope);
  assert.equal((await app.request("/jobs", input)).status, 200);
  const result = await app.waitJob(input.requestId);
  assert.deepEqual(app.runtimes[1].input.storageState, snapshot(1));
  assert.equal(result.data.receipt.status, "needs_confirmation");
  assert.equal(app.runtimes[1].closed, false);
  assert.equal(result.data.image, qr);
  assert.notEqual(result.data.envelope, connected.envelope);
  assert.equal(JSON.stringify(result.data).includes("test-only-session-2"), false);
});

test("concurrent cancellation cleanup keeps the next login blocked until the one close finishes", async (context) => {
  const closing = deferred();
  context.after(() => closing.resolve());
  const app = await fixture(context, {
    runtimeClose: async (runtime) => { if (runtime.number === 1) await closing.promise; },
    providers: { loginXiaohongshu: async ({ signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) },
  });
  const id = randomUUID();
  await app.request("/logins", { loginRequestId: id, displayName: "第一次登录" });
  let settled = false;
  const cancellation = app.request(`/logins/${id}/cancel`, {}).then((response) => { settled = true; return response; });
  try {
    await until(() => app.runtimes[0].closeCount, (count) => count === 1);
    assert.equal((await app.request("/logins", { loginRequestId: randomUUID(), displayName: "不应重叠" })).status, 409);
    assert.equal(settled, false);
    assert.equal(app.runtimes[0].closed, false);
    assert.equal(app.runtimes.length, 1);
  } finally { closing.resolve(); await cancellation; }
  assert.equal(app.runtimes[0].closeCount, 1);
  const nextId = randomUUID();
  assert.equal((await app.request("/logins", { loginRequestId: nextId, displayName: "完成清理后登录" })).status, 200);
  assert.equal((await app.request(`/logins/${nextId}/cancel`, {})).data.cancelled, true);
});

test("cancellation during browser creation waits for that browser to arrive and be closed", async (context) => {
  const starting = deferred();
  context.after(() => starting.resolve());
  const app = await fixture(context, { runtimeReady: async (runtime) => { if (runtime.number === 1) await starting.promise; } });
  const id = randomUUID();
  await app.request("/logins", { loginRequestId: id, displayName: "尚未完成创建" });
  let settled = false;
  const cancellation = app.request(`/logins/${id}/cancel`, {}).then((response) => { settled = true; return response; });
  try {
    // Let the HTTP cancellation reach a factory whose promise is still pending.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await app.request("/logins", { loginRequestId: randomUUID(), displayName: "不应重叠创建" })).status, 409);
    assert.equal(settled, false);
    assert.equal(app.runtimes.length, 1);
    assert.equal(app.count("loginXiaohongshu"), 0);
  } finally { starting.resolve(); await cancellation; }
  assert.equal((await app.waitLogin(id)).data.state, "failed");
  assert.equal(app.runtimes[0].closed, true);
  assert.equal(app.runtimes[0].closeCount, 1);
  assert.equal(app.count("loginXiaohongshu"), 0);
  const nextId = randomUUID();
  assert.equal((await app.request("/logins", { loginRequestId: nextId, displayName: "现在可登录" })).status, 200);
  assert.equal((await app.waitLogin(nextId)).data.state, "complete");
});

test("XHS login seal failure closes its runtime and never reports a usable account", async (context) => {
  const broken = {}; broken.cycle = broken;
  const app = await fixture(context, { snapshot: async () => broken });
  const id = randomUUID();
  await app.request("/logins", { loginRequestId: id, displayName: "模拟小红书" });
  const result = await app.waitLogin(id);
  assert.equal(result.data.state, "failed");
  assert.equal(result.data.envelope, undefined);
  assert.equal(result.data.account, undefined);
  await until(() => app.runtimes[0].closed, Boolean);
  assert.equal(app.runtimes[0].closeCount, 1);
});

test("a browser cleanup failure requests shutdown once and returns an actionable service error", async (context) => {
  let shutdowns = 0;
  const app = await fixture(context, {
    runtimeClose: async () => { throw new Error(`test-only cleanup failure ${secretUrl}`); },
    server: { onCleanupFailure: () => { shutdowns++; } },
  });
  const id = randomUUID();
  await app.request("/logins", { loginRequestId: id, displayName: "模拟小红书" });
  await app.waitLogin(id);
  await until(() => shutdowns, (count) => count === 1);
  assert.equal(app.runtimes[0].closed, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await app.request("/accounts/wechat", { displayName: "模拟公众号", appId, appSecret });
    assert.equal(next.status, 503);
    assert.match(next.data.error, /重启同步服务/);
    assert.equal(next.data.error.includes(appSecret), false);
  }
  assert.equal(shutdowns, 1);
  assert.equal(app.count("verifyWechatAccount"), 0);
});

test("browser setup and cleanup failing together stop the service before another operation", async (context) => {
  let shutdowns = 0;
  let launches = 0;
  let closeAttempts = 0;
  const playwright = { chromium: { launch: async () => {
    launches++;
    return {
      newContext: async () => { throw new Error(`test-only setup failure ${secretUrl}`); },
      close: async () => { closeAttempts++; throw new Error(`test-only cleanup failure ${secretUrl}`); },
    };
  } } };
  const app = await fixture(context, { server: {
    browserFactory: () => createCloudBrowser({ playwright }),
    onCleanupFailure: () => { shutdowns++; },
  } });
  const id = randomUUID();
  assert.equal((await app.request("/logins", { loginRequestId: id, displayName: "模拟小红书" })).status, 200);
  const result = await app.waitLogin(id);
  assert.equal(result.data.state, "failed");
  assert.equal(result.data.account, undefined);
  assert.equal(result.data.envelope, undefined);
  assert.equal(JSON.stringify(result.data).includes(appSecret), false);
  assert.equal(shutdowns, 1);
  assert.equal(closeAttempts, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await app.request("/accounts/wechat", { displayName: "模拟公众号", appId, appSecret });
    assert.equal(next.status, 503);
    assert.match(next.data.error, /重启同步服务/);
    assert.equal(next.data.error.includes(appSecret), false);
  }
  assert.equal(shutdowns, 1);
  assert.equal(launches, 1);
  assert.equal(closeAttempts, 1);
  assert.equal(app.calls.length, 0);
});

test("pending XHS pages expire automatically but the unresolved account stays blocked", async (context) => {
  const app = await fixture(context, { server: { temporarySessionMs: 150 } });
  const connected = await app.xhs();
  const input = app.job(connected.envelope);
  await app.request("/jobs", input);
  const result = await app.waitJob(input.requestId);
  assert.equal(app.runtimes[1].closed, false);
  assert.equal(typeof result.data.expiresAt, "number");
  await until(() => app.runtimes[1].closed, Boolean);
  const expired = await app.request(`/jobs/${input.requestId}`);
  assert.equal(expired.data.image, undefined);
  assert.equal(expired.data.expiresAt, undefined);
  assert.equal(app.runtimes[1].closeCount, 1);
  assert.equal((await app.request("/accounts/inspect", { envelopes: [result.data.envelope] })).data.accounts[0].syncBlocked, true);
  assert.equal((await app.request("/jobs", app.job(result.data.envelope))).status, 409);
  assert.equal(app.count("saveXiaohongshuDraft"), 1);
});

test("manual acknowledgement closes the pending page and returns the latest reusable envelope", async (context) => {
  const app = await fixture(context);
  const connected = await app.xhs();
  const input = app.job(connected.envelope);
  await app.request("/jobs", input);
  const result = await app.waitJob(input.requestId);
  assert.equal(app.runtimes[1].closed, false);
  const ack = await app.request("/jobs/acknowledge", { envelope: connected.envelope, requestId: input.requestId, outcome: "not_saved" });
  assert.equal(ack.status, 200);
  assert.equal(ack.data.acknowledged, true);
  assert.equal(ack.data.envelope, result.data.envelope);
  assert.equal(app.runtimes[1].closeCount, 1);
  assert.equal(app.count("saveXiaohongshuDraft"), 1, "acknowledgement must never retry the draft");
  assert.equal((await app.request("/accounts/inspect", { envelopes: [ack.data.envelope] })).data.accounts[0].syncBlocked, false);
  const next = app.job(ack.data.envelope);
  assert.equal((await app.request("/jobs", next)).status, 200);
  await app.waitJob(next.requestId);
  assert.deepEqual(app.runtimes[2].input.storageState, snapshot(2));
});

test("a delayed acknowledgement for the previous job cannot close or unlock a newer pending page", async (context) => {
  const app = await fixture(context);
  const connected = await app.xhs();
  const first = app.job(connected.envelope);
  await app.request("/jobs", first);
  await app.waitJob(first.requestId);
  const stale = { envelope: connected.envelope, requestId: first.requestId, outcome: "not_saved" };
  const acknowledged = await app.request("/jobs/acknowledge", stale);
  assert.equal(acknowledged.status, 200);
  const next = app.job(acknowledged.data.envelope);
  await app.request("/jobs", next);
  await app.waitJob(next.requestId);
  const currentRuntime = app.runtimes.at(-1);
  assert.equal(currentRuntime.closed, false);
  assert.equal((await app.request("/jobs/acknowledge", stale)).status, 409);
  assert.equal(currentRuntime.closed, false);
  const inspected = await app.request("/accounts/inspect", { envelopes: [acknowledged.data.envelope] });
  assert.equal(inspected.data.accounts[0].syncBlocked, true);
  assert.equal(inspected.data.accounts[0].pendingJobId, next.requestId);
  assert.equal((await app.request("/jobs/acknowledge", { envelope: acknowledged.data.envelope, requestId: next.requestId, outcome: "saved" })).status, 200);
  assert.equal(currentRuntime.closeCount, 1);
  assert.equal(app.count("saveXiaohongshuDraft"), 2);
});

test("server restart does not recover the job ledger: the client must retain its pending-result lock", async (context) => {
  const first = await fixture(context);
  const connected = await first.xhs();
  const input = first.job(connected.envelope);
  await first.request("/jobs", input);
  const pending = await first.waitJob(input.requestId);
  const client = { ...first.client };
  await first.close();
  assert.equal(first.runtimes[1].closed, true);
  const second = await fixture(context, { client });
  assert.equal((await second.request(`/jobs/${input.requestId}`)).status, 404);
  const inspected = await second.request("/accounts/inspect", { envelopes: [pending.data.envelope] });
  assert.equal(inspected.data.accounts[0].id, connected.account.id);
  assert.equal(inspected.data.accounts[0].syncBlocked, false);
  assert.equal(second.calls.length, 0);
  assert.equal(second.runtimes.length, 0);
  const recorded = await second.request("/jobs/acknowledge", { envelope: pending.data.envelope, requestId: input.requestId, outcome: "not_saved" });
  assert.equal(recorded.data.acknowledged, true);
  assert.equal(second.runtimes.length, 0);
  // No new POST is issued: this test documents the intentional stateless
  // boundary, not permission for a client to retry an unresolved submission.
});

test("provider exceptions never reflect credential URLs in connection, login or job responses", async (context) => {
  const failure = () => { throw new Error(secretUrl); };
  const badConnection = await fixture(context, { providers: { verifyWechatAccount: failure } });
  const rejected = await badConnection.request("/accounts/wechat", { displayName: "模拟公众号", appId, appSecret });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(rejected.data).includes(appSecret), false);
  assert.equal(JSON.stringify(rejected.data).includes("platform.invalid"), false);
  const app = await fixture(context, { providers: { saveWechatDraft: failure, loginXiaohongshu: failure } });
  const { envelope } = await app.wechat();
  const input = app.job(envelope);
  await app.request("/jobs", input);
  const result = await app.waitJob(input.requestId);
  assert.equal(result.data.receipt.status, "needs_confirmation");
  assert.equal(JSON.stringify(result.data).includes(appSecret), false);
  assert.equal(JSON.stringify(result.data).includes("platform.invalid"), false);
  const id = randomUUID();
  await app.request("/logins", { loginRequestId: id, displayName: "模拟小红书" });
  const login = await app.waitLogin(id);
  assert.equal(login.data.state, "failed");
  assert.equal(JSON.stringify(login.data).includes(appSecret), false);
  assert.equal(JSON.stringify(login.data).includes("platform.invalid"), false);
});

test("a saved result without a draft ID remains unresolved and cannot be silently resent", async (context) => {
  const app = await fixture(context, { providers: { saveWechatDraft: async () => ({ status: "saved", message: "模拟平台未返回编号" }) } });
  const { envelope } = await app.wechat();
  const input = app.job(envelope);
  await app.request("/jobs", input);
  assert.equal((await app.waitJob(input.requestId)).data.receipt.status, "needs_confirmation");
  assert.equal((await app.request("/jobs", app.job(envelope))).status, 409);
  assert.equal(app.count("saveWechatDraft"), 1);
  assert.equal((await app.request("/jobs/acknowledge", { envelope, requestId: input.requestId, outcome: "saved" })).data.acknowledged, true);
});
