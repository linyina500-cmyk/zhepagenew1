import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { onRequest } = loadDomModule("functions/api/wechat/[[path]].ts");
const token = "fixture-connection-password-32-characters";
const env = { WECHAT_SYNC_URL: "https://sync.example" };
const request = (path = "account", init = {}) => new Request(`https://fold.example/api/wechat/${path}`, { headers: { Authorization: `Bearer ${token}` }, ...init });

test("unconfigured Cloudflare returns a clear unavailable state without reaching WeChat", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const response = await onRequest({ request: request(), env: {} });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /尚未配置/); assert.equal(mock.mock.callCount(), 0);
});

test("bridge forwards only the configured HTTPS endpoint and connection credential, with no redirects or cookies", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://sync.example/api/wechat/account");
    assert.equal(options.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(options.headers.get("Cookie"), null);
    assert.equal(options.redirect, "manual");
    return Response.json({ account: { id: "account-id", name: "测试公众号" } });
  });
  const response = await onRequest({ request: request("account", { headers: { Authorization: `Bearer ${token}`, Cookie: "private-session" } }), env });
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
    assert.equal(String(url), "https://sync.example/api/wechat/jobs");
    const forwarded = await new Response(options.body, { headers: options.headers }).formData();
    assert.deepEqual(await Promise.all(forwarded.getAll("images").map((file) => file.text())), ["page-first", "page-second"]);
    return Response.json({ job: { id: "job" } }, { status: 202 });
  });
  assert.equal((await onRequest({ request: request("jobs", { method: "POST", body, headers: { Authorization: `Bearer ${token}`, Origin: "https://fold.example" } }), env })).status, 202);
});

test("bridge rejects publication, arbitrary destinations, cross-origin writes and insecure configuration", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  for (const path of ["publish", "freepublish/submit", "jobs?url=https://attacker.example"]) {
    assert.ok((await onRequest({ request: request(path, { method: "POST" }), env })).status >= 400);
  }
  const foreign = request("jobs", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.example" } });
  assert.equal((await onRequest({ request: foreign, env })).status, 403);
  assert.equal((await onRequest({ request: request(), env: { WECHAT_SYNC_URL: "http://sync.example" } })).status, 503);
  assert.equal((await onRequest({ request: request(), env: { WECHAT_SYNC_URL: "https://user:password@sync.example" } })).status, 503);
  assert.equal(mock.mock.callCount(), 0);
});

test("bridge never exposes raw fetch errors or retries an uncertain write", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error(`url https://sync.example?secret=${token}`); });
  const response = await onRequest({ request: request("jobs", { method: "POST" }), env });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /fixture|secret=|sync.example/);
  assert.match(body, /不要重复提交/); assert.equal(mock.mock.callCount(), 1);
});
