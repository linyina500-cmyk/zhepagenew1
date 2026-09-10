import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/api/sync/[[path]].ts";

const ORIGIN = "https://editor.example.test";
const SERVICE = "https://sync.example.test";
const GATEWAY = "test-only-trusted-gateway-secret-not-for-production";
const environment = { SYNC_SERVICE_URL: SERVICE, SYNC_GATEWAY_SECRET: GATEWAY };
const interrupted = "网页同步连接暂时中断。已提交的草稿请先到平台核对，避免重复发送。";
function request({ method = "GET", pathname = "/api/sync/session", headers = {}, body = "{}", signal } = {}) {
  return new Request(`${ORIGIN}${pathname}`, { method, headers, ...(method === "POST" ? { body } : {}), ...(signal ? { signal } : {}) });
}
function forbidNetwork(context) {
  return context.mock.method(globalThis, "fetch", () => { throw new Error("Upstream must not be contacted"); });
}
async function expectError(response, status, message) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: message });
}

test("an absent or invalid deployment never forwards a browser request", async (context) => {
  const upstream = forbidNetwork(context);
  for (const env of [{}, { SYNC_SERVICE_URL: SERVICE }, { SYNC_GATEWAY_SECRET: GATEWAY }, { ...environment, SYNC_GATEWAY_SECRET: "short" }]) {
    await expectError(await onRequest({ request: request(), env }), 503, "网页同步服务尚未部署，请联系站点管理员完成配置");
  }
  for (const value of ["invalid-url", "http://sync.example.test", "https://user:synthetic-secret@sync.example.test", `${SERVICE}/unexpected-path`, `${SERVICE}/?secret=synthetic-secret`, `${SERVICE}/#fragment`]) {
    await expectError(await onRequest({ request: request(), env: { ...environment, SYNC_SERVICE_URL: value } }), 503, "网页同步服务地址配置无效，请联系站点管理员");
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("unsupported methods, foreign paths and query strings are rejected before forwarding", async (context) => {
  const upstream = forbidNetwork(context);
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    await expectError(await onRequest({ request: request({ method }), env: environment }), 405, "此请求方法不受支持");
  }
  for (const pathname of ["/api/other/session", "/api/sync", "/api/sync-foreign/session", "/api/sync/session?token=synthetic-secret", "/api/sync/../other"]) {
    await expectError(await onRequest({ request: request({ pathname }), env: environment }), 400, "同步路径无效");
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("cross-site requests and missing or mismatched mutation origins are rejected", async (context) => {
  const upstream = forbidNetwork(context);
  for (const origin of [undefined, "null", "https://attacker.example.test", "http://editor.example.test", `${ORIGIN}:444`, `${ORIGIN}/`]) {
    const headers = { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) };
    await expectError(await onRequest({ request: request({ method: "POST", headers }), env: environment }), 403, "网页来源未获授权");
  }
  for (const method of ["GET", "POST"]) {
    await expectError(await onRequest({ request: request({ method, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" } }), env: environment }), 403, "不接受跨站同步请求");
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("the proxy forwards only the authenticated request fields and injects trusted gateway and Cloudflare IP", async (context) => {
  const body = JSON.stringify({ requestId: "synthetic-job", envelope: "opaque-synthetic-account-envelope", content: { title: "测试标题", body: "独立文案" }, images: [] });
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init, body: await new Response(init.body).text() });
    return Response.json({ id: "synthetic-job", state: "running" });
  });
  const result = await onRequest({ request: request({
    method: "POST", pathname: "/api/sync/jobs", body,
    headers: {
      Origin: ORIGIN, "Content-Type": "application/json", Cookie: "__Host-zhepage_sync=opaque-session", "X-CSRF-Token": "synthetic-csrf",
      "X-Sync-Gateway": "attacker-gateway", "X-Sync-Client-IP": "attacker-client-ip", "X-Forwarded-For": "attacker-forwarded-ip", "X-Real-IP": "attacker-real-ip",
      // At the deployed Pages boundary Cloudflare replaces CF-Connecting-IP.
      "CF-Connecting-IP": "203.0.113.42", Authorization: "Bearer attacker-token", Host: "attacker.test",
      "X-Forwarded-Host": "attacker.test", "X-Private-Debug": "synthetic-private-header", "Sec-Fetch-Site": "same-origin",
    },
  }), env: environment });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SERVICE}/api/sync/jobs`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].body, body);
  assert.deepEqual(Object.fromEntries(calls[0].init.headers), {
    "content-type": "application/json", cookie: "__Host-zhepage_sync=opaque-session", origin: ORIGIN,
    "x-csrf-token": "synthetic-csrf", "x-sync-client-ip": "203.0.113.42", "x-sync-gateway": GATEWAY,
  });
});

test("a GET without Cloudflare IP never trusts client-supplied forwarding headers or adds a body", async (context) => {
  let sent;
  context.mock.method(globalThis, "fetch", async (url, init) => { sent = { url: String(url), init }; return Response.json({ configured: true, authenticated: false }); });
  const result = await onRequest({ request: request({ headers: { "X-Sync-Client-IP": "forged", "X-Forwarded-For": "203.0.113.99", "CF-Ray": "untrusted-client-value" } }), env: environment });
  assert.equal(result.status, 200);
  assert.equal(sent.url, `${SERVICE}/api/sync/session`);
  assert.equal(sent.init.method, "GET");
  assert.equal(Object.hasOwn(sent.init, "body"), false);
  assert.deepEqual(Object.fromEntries(sent.init.headers), { "x-sync-client-ip": "unknown", "x-sync-gateway": GATEWAY });
});

test("service status and secure cookies survive the proxy while private response headers do not", async (context) => {
  const cookie = "__Host-zhepage_sync=opaque-test-cookie; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000";
  let status = 200;
  context.mock.method(globalThis, "fetch", async () => new Response('{"authenticated":true,"csrf":"synthetic-csrf"}', {
    status, headers: { "Set-Cookie": cookie, "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*", "X-Private-Debug": "synthetic-private-data", Server: "internal-service", Location: "https://internal.example.test" },
  }));
  for (status of [200, 201, 401, 409, 429, 503]) {
    const result = await onRequest({ request: request(), env: environment });
    assert.equal(result.status, status);
    assert.equal(await result.text(), '{"authenticated":true,"csrf":"synthetic-csrf"}');
    assert.deepEqual(Object.fromEntries(result.headers), {
      "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer",
      "set-cookie": cookie, "x-content-type-options": "nosniff",
    });
  }
});

test("upstream redirects are not followed and cannot move cookies or credentials to another origin", async (context) => {
  let status = 301;
  const upstream = context.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response(null, { status, headers: { Location: "https://attacker.example.test/collect?secret=synthetic-secret", "Set-Cookie": "stolen=synthetic-secret" } });
  });
  for (status of [301, 302, 303, 304, 307, 308]) {
    const result = await onRequest({ request: request(), env: environment });
    assert.equal(result.headers.has("Location"), false);
    assert.equal(result.headers.has("Set-Cookie"), false);
    await expectError(result, 502, "同步服务返回了不受支持的跳转");
  }
  assert.equal(upstream.mock.callCount(), 6);
});

test("network failures expose no upstream address, request secret or error details and are not retried", async (context) => {
  const upstream = context.mock.method(globalThis, "fetch", async () => { throw new Error(`Connection refused at ${SERVICE}/private?appSecret=synthetic-secret, gateway=${GATEWAY}`); });
  await expectError(await onRequest({ request: request(), env: environment }), 502, interrupted);
  assert.equal(upstream.mock.callCount(), 1);
});

test("a request cancelled before entering the proxy never starts an upstream request", async (context) => {
  const upstream = forbidNetwork(context);
  const client = new AbortController();
  client.abort(new Error("synthetic-private-abort-reason"));
  await expectError(await onRequest({ request: request({ signal: client.signal }), env: environment }), 502, interrupted);
  assert.equal(upstream.mock.callCount(), 0);
});

test("client cancellation and the request deadline abort upstream work with the same safe error", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let forwarded;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    forwarded = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("synthetic-private-upstream-abort")), { once: true }));
  });
  const client = new AbortController();
  const cancelled = onRequest({ request: request({ signal: client.signal }), env: environment });
  assert.equal(forwarded.aborted, false);
  client.abort();
  await expectError(await cancelled, 502, interrupted);
  assert.equal(forwarded.aborted, true);
  const timedOut = onRequest({ request: request(), env: environment });
  context.mock.timers.tick(99999);
  assert.equal(forwarded.aborted, false);
  context.mock.timers.tick(1);
  await expectError(await timedOut, 502, interrupted);
  assert.equal(forwarded.aborted, true);
});

test("completed forwarding clears its deadline and detaches the incoming cancellation listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let forwarded;
  context.mock.method(globalThis, "fetch", async (_url, init) => { forwarded = init.signal; return Response.json({ configured: true, authenticated: false }); });
  const client = new AbortController();
  const result = await onRequest({ request: request({ signal: client.signal }), env: environment });
  assert.equal(result.status, 200);
  client.abort();
  context.mock.timers.tick(100001);
  assert.equal(forwarded.aborted, false);
});
