import assert from "node:assert/strict";
import { test } from "node:test";
import { createWechatApi, WechatApiError } from "../lib/wechat/api.mjs";

const appId = "wx-test";
const appSecret = "private-app-secret";
const accessToken = "private-access-token";
const draft = { title: "海报草稿", body: "第一行\n\n第二行 #海报", imageMediaIds: ["picture-1", "picture-2"] };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });
const tokenResponse = () => jsonResponse({ access_token: accessToken, expires_in: 7200 });
const draftResponse = (patch = {}) => jsonResponse({ news_item: [{
  article_type: "newspic", title: draft.title, content: draft.body,
  image_info: { image_list: draft.imageMediaIds.map((id) => ({ image_media_id: id })) },
  ...patch,
}] });

function fixture(responses) {
  const calls = [];
  const api = createWechatApi({ appId, appSecret, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const response = responses.shift();
    assert.ok(response, "unexpected request or automatic retry");
    return typeof response === "function" ? response(url, options) : response;
  } });
  return { api, calls };
}

function assertControlledError(error, outcome, errcode) {
  assert.ok(error instanceof WechatApiError);
  assert.equal(error.outcome, outcome);
  assert.equal(error.errcode, errcode);
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /private-app-secret|private-access-token|api\.weixin\.qq\.com|raw-error-detail/);
  assert.equal(error.cause, undefined);
  return true;
}

test("connection checks only obtain the stable token and read the draft count", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ total_count: 0 })]);
  assert.equal(await api.checkConnection(), undefined);
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/count"]);
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[1].options.redirect, "error");
});

test("connection checks reject unavailable permission and unrecognised count responses", async () => {
  for (const response of [jsonResponse({ errcode: 48001 }), jsonResponse({ total_count: "0" }), jsonResponse({ total_count: -1 }), jsonResponse({})]) {
    const { api } = fixture([tokenResponse(), response]);
    await assert.rejects(api.checkConnection(), WechatApiError);
  }
});

test("uploads original PNG/JPEG bytes as permanent images and creates only an ordered newspic draft", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ media_id: "picture-1" }), jsonResponse({ media_id: "picture-2" }), jsonResponse({ media_id: "draft-1" }), draftResponse()]);
  const bytes = new Uint8Array([1, 2, 3, 255]);
  for (const [index, type] of ["image/png", "image/jpeg"].entries()) {
    assert.equal(await api.uploadImage({ blob: new Blob([bytes], { type }), name: `poster-${index + 1}.${index ? "jpg" : "png"}` }), `picture-${index + 1}`);
  }
  assert.equal(await api.createDraft(draft), "draft-1");
  assert.equal((await api.verifyDraft({ draftId: "draft-1", ...draft })).verified, true);
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/material/add_material", "/cgi-bin/material/add_material", "/cgi-bin/draft/add", "/cgi-bin/draft/get"]);
  assert.deepEqual(JSON.parse(calls[0].options.body), { grant_type: "client_credential", appid: appId, secret: appSecret, force_refresh: false });
  assert.equal(calls[0].url.search, "");
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.redirect, "error");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  for (const call of calls.slice(1)) assert.equal(call.url.searchParams.get("access_token"), accessToken);
  for (const call of calls.slice(1, 3)) {
    assert.equal(call.url.searchParams.get("type"), "image");
    assert.equal(call.options.headers, undefined);
    assert.ok(call.options.body instanceof FormData);
    assert.deepEqual(new Uint8Array(await call.options.body.get("media").arrayBuffer()), bytes);
  }
  assert.equal(calls[1].options.body.get("media").name, "poster-1.png");
  assert.equal(calls[2].options.body.get("media").type, "image/jpeg");
  assert.deepEqual(JSON.parse(calls[3].options.body), { articles: [{
    article_type: "newspic", title: draft.title, content: draft.body,
    image_info: { image_list: [{ image_media_id: "picture-1" }, { image_media_id: "picture-2" }] },
    need_open_comment: 0, only_fans_can_comment: 0,
  }] });
  assert.deepEqual(JSON.parse(calls[4].options.body), { media_id: "draft-1" });
});

test("concurrent callers share one stable token request and cache it until 60 seconds before expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let resolveToken;
  let tokenCalls = 0;
  let draftCalls = 0;
  const api = createWechatApi({ appId, appSecret, fetchImpl: async (url) => {
    if (new URL(url).pathname === "/cgi-bin/stable_token") {
      tokenCalls++;
      if (tokenCalls === 1) return new Promise((resolve) => { resolveToken = resolve; });
      return tokenResponse();
    }
    return jsonResponse({ media_id: `draft-${++draftCalls}` });
  } });
  const first = api.createDraft(draft);
  const second = api.createDraft(draft);
  assert.equal(tokenCalls, 1);
  resolveToken(tokenResponse());
  await Promise.all([first, second]);
  t.mock.timers.setTime(100_000 + 7_139_999);
  await api.createDraft(draft);
  assert.equal(tokenCalls, 1);
  t.mock.timers.setTime(100_000 + 7_140_000);
  await api.createDraft(draft);
  assert.equal(tokenCalls, 2);
});

test("failed token acquisition is not cached and never sends a draft creation request", async () => {
  const { api, calls } = fixture([jsonResponse({ errcode: 40125, errmsg: `raw-error-detail ${appSecret}` }), tokenResponse(), jsonResponse({ media_id: "draft-1" })]);
  await assert.rejects(api.createDraft(draft), (error) => assertControlledError(error, "rejected", 40125));
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token"]);
  assert.equal(await api.createDraft(draft), "draft-1");
});

test("a clear WeChat refusal is rejected without exposing errmsg or retrying the write", async () => {
  for (const errcode of [40164, 48001, 45009, 54321]) {
    const { api, calls } = fixture([tokenResponse(), jsonResponse({ errcode, errmsg: `raw-error-detail https://api.weixin.qq.com/?access_token=${accessToken}&secret=${appSecret}` })]);
    await assert.rejects(api.createDraft(draft), (error) => assertControlledError(error, "rejected", errcode));
    assert.equal(calls.length, 2);
  }
});

test("network, HTTP, invalid JSON, malformed responses and missing IDs leave creation uncertain without retry", async () => {
  for (const response of [
    () => { throw new Error(`raw-error-detail https://api.weixin.qq.com/?access_token=${accessToken}`); },
    jsonResponse({ errcode: 500 }, 503),
    new Response(`raw-error-detail ${appSecret}`),
    jsonResponse(null),
    jsonResponse([]),
    jsonResponse({ errcode: "0", media_id: "draft-1" }),
    jsonResponse({ errcode: 0 }),
    jsonResponse({ media_id: "" }),
  ]) {
    const { api, calls } = fixture([tokenResponse(), response]);
    await assert.rejects(api.createDraft(draft), (error) => assertControlledError(error, "uncertain"));
    assert.equal(calls.length, 2);
  }
});

test("a hung request is aborted after 30 seconds and is not retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const { api, calls } = fixture([(_url, options) => { signal = options.signal; return new Promise(() => {}); }]);
  const request = api.createDraft(draft);
  const rejected = assert.rejects(request, (error) => assertControlledError(error, "uncertain"));
  t.mock.timers.tick(29_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 1);
});

test("draft readback requires the exact newspic title, plain text and image order", async () => {
  for (const response of [
    draftResponse({ article_type: "news" }),
    draftResponse({ article_type: undefined }),
    draftResponse({ title: `${draft.title}改` }),
    draftResponse({ content: draft.body.replace("\n\n", "\n") }),
    draftResponse({ content: `<p>${draft.body}</p>` }),
    draftResponse({ image_info: { image_list: [{ image_media_id: "picture-2" }, { image_media_id: "picture-1" }] } }),
    draftResponse({ image_info: { image_list: [{ image_media_id: "picture-1" }] } }),
    draftResponse({ image_info: { image_list: [{ image_media_id: "picture-1" }, null] } }),
    draftResponse({ image_info: undefined }),
    jsonResponse({ articles: [] }),
    jsonResponse({ news_item: [] }),
    jsonResponse({ news_item: [null] }),
    jsonResponse({ news_item: [{}, {}] }),
  ]) {
    const { api, calls } = fixture([tokenResponse(), response]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, false);
    assert.match(result.message, /尚未通过/);
    assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/get"]);
  }
});

test("failed readback never causes another draft creation", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ media_id: "draft-1" }), () => { throw new Error("network lost"); }]);
  const draftId = await api.createDraft(draft);
  await assert.rejects(api.verifyDraft({ draftId, ...draft }), (error) => assertControlledError(error, "uncertain"));
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/add", "/cgi-bin/draft/get"]);
});

test("invalid input is rejected before any account request", async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(api.uploadImage({ blob: new Blob(["svg"], { type: "image/svg+xml" }), name: "image.svg" }), TypeError);
  await assert.rejects(api.createDraft({ ...draft, imageMediaIds: [] }), TypeError);
  await assert.rejects(api.createDraft({ ...draft, imageMediaIds: Array(21).fill("picture") }), TypeError);
  await assert.rejects(api.verifyDraft({ draftId: "", ...draft }), TypeError);
  assert.equal(calls.length, 0);
  assert.throws(() => createWechatApi({ appId, appSecret: "" }), TypeError);
});
