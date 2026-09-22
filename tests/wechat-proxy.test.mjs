import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { onRequest } = loadDomModule("functions/api/wechat/[[path]].ts");
const token = "fixture-connection-password-32-characters";
const env = { WECHAT_SYNC_URL: "https://sync.example" };
const request = (path = "connection", init = {}) => new Request(`https://fold.example/api/wechat/${path}`, { headers: { Authorization: `Bearer ${token}` }, ...init });

test("unconfigured Cloudflare returns a clear unavailable state without reaching WeChat", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const response = await onRequest({ request: request(), env: {} });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /尚未配置/); assert.equal(mock.mock.callCount(), 0);
});

test("bridge forwards only the configured HTTPS endpoint and connection credential, with no redirects or cookies", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://sync.example/api/wechat/connection");
    assert.equal(options.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(options.headers.get("Cookie"), null);
    assert.equal(options.redirect, "manual");
    return Response.json({ account: { id: "account-id", name: "测试公众号" } });
  });
  const response = await onRequest({ request: request("connection", { headers: { Authorization: `Bearer ${token}`, Cookie: "private-session" } }), env });
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).account.name, "测试公众号");
});

test("bridge explicitly refuses every 3xx response before forwarding its body or Location", async (t) => {
  let upstreamStatus;
  const mock = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: upstreamStatus, headers: {
      "Content-Type": "application/json", Location: "https://untrusted.example/collect-credentials",
    } });
  });
  for (upstreamStatus = 300; upstreamStatus < 400; upstreamStatus++) {
    const response = await onRequest({ request: request(), env });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Location"), null);
    const body = await response.text();
    assert.match(body, /重定向/);
    assert.doesNotMatch(body, /untrusted|collect-credentials|fixture-connection/);
  }
  assert.equal(mock.mock.callCount(), 100);
});

test("write bridge preserves all multipart image bytes and their order", async (t) => {
  const body = new FormData(); body.set("id", "job"); body.set("title", "两页"); body.set("body", "短文");
  body.append("images", new Blob(["page-first"], { type: "image/png" }), "1.png");
  body.append("images", new Blob(["page-second"], { type: "image/png" }), "2.png");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://sync.example/api/wechat/accounts/0123456789abcdef0123/jobs");
    const forwarded = await new Response(options.body, { headers: options.headers }).formData();
    assert.deepEqual(await Promise.all(forwarded.getAll("images").map((file) => file.text())), ["page-first", "page-second"]);
    return Response.json({ job: { id: "job" } }, { status: 202 });
  });
  assert.equal((await onRequest({ request: request("accounts/0123456789abcdef0123/jobs", { method: "POST", body, headers: { Authorization: `Bearer ${token}`, Origin: "https://fold.example" } }), env })).status, 202);
});

test("bridge rejects unscoped publication, arbitrary destinations, cross-origin writes and insecure configuration", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["publish", "freepublish/submit", "jobs?url=https://attacker.example"]) {
    assert.ok((await onRequest({ request: request(path, { method: "POST" }), env })).status >= 400);
  }
  const foreign = request("accounts/0123456789abcdef0123/jobs", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.example" } });
  assert.equal((await onRequest({ request: foreign, env })).status, 403);
  assert.equal((await onRequest({ request: request(), env: { WECHAT_SYNC_URL: "http://sync.example" } })).status, 503);
  assert.equal((await onRequest({ request: request(), env: { WECHAT_SYNC_URL: "https://user:password@sync.example" } })).status, 503);
  assert.equal(mock.mock.callCount(), 0);
});

test("bridge never exposes raw fetch errors or retries an uncertain write", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error(`url https://sync.example?secret=${token}`); });
  const response = await onRequest({ request: request("accounts/0123456789abcdef0123/jobs", { method: "POST" }), env });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /fixture|secret=|sync.example/);
  assert.match(body, /不要重复提交/); assert.equal(mock.mock.callCount(), 1);
});

test("scoped multi-account routes preserve JSON credentials and confirmation only for the selected account path", async (t) => {
  const account = "0123456789abcdef0123", job = "12345678-1234-4234-8234-123456789abc";
  let expectedPath, expectedBody;
  const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), `https://sync.example/api/wechat/${expectedPath}`);
    assert.equal(options.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(options.headers.get("Cookie"), null);
    assert.equal(options.headers.get("X-Wechat-AppSecret"), null);
    assert.equal(options.redirect, "manual");
    if (expectedBody !== undefined) assert.deepEqual(await new Response(options.body).json(), expectedBody);
    return Response.json({ ok: true });
  });
  const connect = { appId: "wx0123456789abcdef", appSecret: "A".repeat(32), name: "假账号", deviceId: "d".repeat(32) };
  const cases = [
    ["GET", "connection"], ["GET", "accounts"],
    ["POST", "accounts/connect", connect],
    ["POST", `accounts/${account}/disconnect`],
    ["GET", `accounts/${account}/jobs/${job}`],
    ["POST", `accounts/${account}/jobs/${job}/verify`],
    ["GET", `accounts/${account}/jobs/${job}/publication`],
    ["POST", `accounts/${account}/jobs/${job}/publication`, { confirm: true }],
    ["POST", `accounts/${account}/jobs/${job}/publication/refresh`],
  ];
  for (const [method, path, body] of cases) {
    expectedPath = path; expectedBody = body;
    const response = await onRequest({ env, request: request(path, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Cookie: "private-session", "X-Wechat-AppSecret": "must-not-forward" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(mock.mock.callCount(), cases.length);
});

test("legacy and unapproved account routes fail closed before forwarding any credentials", async (t) => {
  const account = "0123456789abcdef0123", job = "12345678-1234-4234-8234-123456789abc";
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const [method, path] of [
    ["GET", "account"], ["POST", "jobs"], ["GET", `jobs/${job}`],
    ["POST", `jobs/${job}/publication`], ["GET", "accounts/connect"],
    ["POST", "connection"], ["DELETE", `accounts/${account}/disconnect`],
    ["GET", `accounts/${account}/jobs/${job}/publication/refresh`],
    ["POST", `accounts/${account}/jobs/${job}/schedule`],
    ["POST", `accounts/${account}/freepublish/submit`],
    ["POST", `accounts/wrong-account/jobs/${job}/publication`],
    ["POST", `accounts/${account}/jobs/${job}/publication?publish_time=123`],
  ]) {
    const response = await onRequest({ env, request: request(path, { method }) });
    assert.equal(response.status, path.includes("?") ? 400 : 404, `${method} ${path}`);
  }
  const path = `accounts/${account}/jobs/${job}/publication`;
  assert.equal((await onRequest({ env, request: request(path, { method: "POST", headers: {} }) })).status, 401);
  assert.equal((await onRequest({ env, request: request(path, { method: "POST", headers: { Authorization: "Bearer short" } }) })).status, 401);
  assert.equal((await onRequest({ env, request: request("accounts/connect", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://foreign.example" } }) })).status, 403);
  assert.equal(mock.mock.callCount(), 0);
});
