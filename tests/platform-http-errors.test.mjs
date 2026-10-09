import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { WechatApiError } from "../lib/wechat/api.mjs";
import { createWechatServer } from "../server/wechat/http.mjs";
import { XhsDriverError } from "../server/xiaohongshu/driver.mjs";
import { RequestError as XhsRequestError } from "../server/xiaohongshu/jobs.mjs";

const syncToken = "synthetic-sync-token-".repeat(4), privateError = "synthetic-private-browser-url-and-token";
function fixture(overrides = {}) {
  const diagnostics = [], accounts = {
    deviceId: "a".repeat(32), busy: () => false,
    get() { throw new Error(privateError); }, list() { throw new Error(privateError); },
  };
  const handler = createWechatServer({ accounts, syncToken, onDiagnostic: (event) => diagnostics.push(event), ...overrides }).listeners("request")[0];
  return { diagnostics, async call(path, { authorized = true } = {}) {
    const request = Readable.from([]);
    Object.assign(request, { url: path, method: "GET", socket: { localPort: 8788 }, headers: {
      host: "127.0.0.1:8788", ...(authorized ? { authorization: `Bearer ${syncToken}` } : {}),
    } });
    const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = JSON.parse(body); } };
    await handler(request, response);
    return response;
  } };
}

test("XHS login, account and draft failures use independent messages and redact browser details", async () => {
  const f = fixture({ handleXhs: async () => { throw new Error(privateError); } });
  for (const [action, path, message] of [
    ["login", "/api/xiaohongshu/login", /小红书登录窗口/],
    ["account", "/api/xiaohongshu/account", /检查小红书账号/],
    ["draft", "/api/xiaohongshu/jobs/test-job", /小红书草稿箱/],
  ]) {
    const response = await f.call(path);
    assert.equal(response.status, 502);
    assert.match(response.body.error, message);
    assert.doesNotMatch(response.body.error, /公众号|synthetic-|token/);
    assert.deepEqual(f.diagnostics.at(-1), { platform: "xiaohongshu", action, code: "unexpected_error" });
  }
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /synthetic-|token/);
});

test("controlled XHS browser failures retain actionable messages without becoming WeChat failures", async () => {
  const error = new XhsDriverError("小红书页面暂时打不开，请确认网络正常后重试。", { status: 503, code: "page_open_failed" });
  const f = fixture({ handleXhs: async () => { throw error; } });
  const response = await f.call("/api/xiaohongshu/login");
  assert.equal(response.status, 503); assert.equal(response.body.error, error.message);
  assert.deepEqual(f.diagnostics, [{ platform: "xiaohongshu", action: "login", code: "page_open_failed" }]);
  const rejected = fixture({ handleXhs: async () => { throw new XhsRequestError("请先核对小红书账号", 409); } });
  assert.equal((await rejected.call("/api/xiaohongshu/account")).status, 409);
  assert.deepEqual(rejected.diagnostics, []);
});

test("XHS unavailable and unknown routes never consult WeChat accounts", async () => {
  const accounts = new Proxy({}, { get() { assert.fail("XHS routing must not read WeChat state"); } });
  const missing = await fixture({ accounts }).call("/api/xiaohongshu/login");
  assert.equal(missing.status, 503); assert.match(missing.body.error, /小红书服务尚未准备好/);
  const unknown = await fixture({ accounts, handleXhs: async () => false }).call("/api/xiaohongshu/unknown");
  assert.equal(unknown.status, 404); assert.match(unknown.body.error, /没有此小红书/);
});

test("shared connection authentication failures stay platform-neutral and do not initialize XHS", async () => {
  let calls = 0;
  const f = fixture({ handleXhs: async () => { calls++; return false; } });
  for (const path of ["/api/xiaohongshu/login", "/api/wechat/accounts"]) {
    const response = await f.call(path, { authorized: false });
    assert.equal(response.status, 401); assert.match(response.body.error, /本机连接已失效/);
    assert.doesNotMatch(response.body.error, /公众号|小红书|口令/);
  }
  assert.equal(calls, 0); assert.deepEqual(f.diagnostics, []);
});

test("WeChat errors retain their own status and cannot surface on XHS routes", async () => {
  const apiError = new WechatApiError("公众号接口今日调用额度已用完");
  const f = fixture({ accounts: { list() { throw apiError; } } });
  const response = await f.call("/api/wechat/accounts");
  assert.equal(response.status, 424); assert.equal(response.body.error, apiError.message);
  assert.deepEqual(f.diagnostics, []);
  const unknown = await fixture().call("/api/wechat/accounts");
  assert.equal(unknown.status, 502); assert.match(unknown.body.error, /公众号同步暂未完成/);
  assert.doesNotMatch(unknown.body.error, /小红书|synthetic-/);
  const xhs = await fixture({ handleXhs: async () => { throw apiError; } }).call("/api/xiaohongshu/login");
  assert.equal(xhs.status, 502); assert.match(xhs.body.error, /小红书登录窗口/); assert.doesNotMatch(xhs.body.error, /公众号/);
});
