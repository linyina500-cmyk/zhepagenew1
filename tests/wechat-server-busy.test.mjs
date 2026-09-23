import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createWechatServer } from "../server/wechat/http.mjs";

const syncToken = "fixture-sync-token-".repeat(4), accountId = "a".repeat(20);
function fixture(overrides = {}) {
  let disconnects = 0;
  const accounts = { deviceId: "b".repeat(32), busy: () => false, get: () => ({ jobs: {} }), disconnect: () => { disconnects++; } };
  const handler = createWechatServer({ accounts, syncToken, ...overrides }).listeners("request")[0];
  const call = async (path, options = {}) => {
    const request = options.stream || Readable.from([]);
    Object.assign(request, { url: path, method: options.method || "GET", headers: { authorization: `Bearer ${syncToken}`, ...options.headers } });
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = JSON.parse(body); } };
    await handler(request, response); return response;
  };
  return { call, get disconnects() { return disconnects; } };
}

test("connection checks report lazy XHS work without initializing XHS and block disconnect", async () => {
  let xhsActive = false, starts = 0;
  const f = fixture({ xhsBusy: () => xhsActive, handleXhs: async () => { starts++; return false; } });
  assert.equal((await f.call("/api/wechat/connection")).body.busy, false); assert.equal(starts, 0);
  xhsActive = true;
  assert.equal((await f.call("/api/wechat/connection")).body.busy, true);
  assert.equal((await f.call(`/api/wechat/accounts/${accountId}/disconnect`, { method: "POST" })).status, 409);
  assert.equal(f.disconnects, 0); assert.equal(starts, 0);
  xhsActive = false;
  assert.equal((await f.call(`/api/wechat/accounts/${accountId}/disconnect`, { method: "POST" })).status, 200);
  assert.equal(f.disconnects, 1);
});

test("receiving WeChat upload bytes keeps connection busy until parsing exits", async () => {
  const f = fixture(), stream = new PassThrough();
  const upload = f.call(`/api/wechat/accounts/${accountId}/jobs`, { method: "POST", stream,
    headers: { "content-type": "multipart/form-data; boundary=fixture-boundary" } });
  stream.write("incomplete fixture bytes");
  assert.equal((await f.call("/api/wechat/connection")).body.busy, true);
  assert.equal((await f.call(`/api/wechat/accounts/${accountId}/disconnect`, { method: "POST" })).status, 409);
  stream.end(); assert.equal((await upload).status, 400);
  assert.equal((await f.call("/api/wechat/connection")).body.busy, false); assert.equal(f.disconnects, 0);
});

test("XHS requests keep reset blocked while uploading or checking a browser and release on failure", async () => {
  let release;
  const f = fixture({ handleXhs: async () => { await new Promise((resolve) => { release = resolve; }); throw new Error("controlled fixture failure"); } });
  const request = f.call("/api/xiaohongshu/jobs", { method: "POST" });
  assert.equal((await f.call("/api/wechat/connection")).body.busy, true);
  assert.equal((await f.call(`/api/wechat/accounts/${accountId}/disconnect`, { method: "POST" })).status, 409);
  release(); assert.equal((await request).status, 502);
  assert.equal((await f.call("/api/wechat/connection")).body.busy, false);
});

test("the tunneled sync listener exposes no pairing endpoint", async () => {
  const f = fixture();
  for (const path of ["/connect", "/pair", "/api/wechat/pair"]) {
    const response = await f.call(path, { method: "POST" });
    assert.equal(response.status, 404); assert.equal(JSON.stringify(response.body).includes(syncToken), false);
  }
});
