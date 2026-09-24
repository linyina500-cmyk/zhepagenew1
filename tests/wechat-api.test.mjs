import assert from "node:assert/strict";
import { test } from "node:test";
import { createWechatApi, normalizeDraftCoverInfo, normalizeDraftCoverSource, normalizeDraftVerificationMismatches, WechatApiError } from "../lib/wechat/api.mjs";

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

test("whitelist errors expose only a strictly validated IPv4 and never adjacent credentials", async () => {
  const { api, calls } = fixture([jsonResponse({
    errcode: 40164,
    errmsg: `invalid ip 203.0.113.27 ipv6 ::ffff:203.0.113.27, not in whitelist; raw-error-detail https://api.weixin.qq.com/?access_token=${accessToken}&secret=${appSecret}`,
  })]);
  await assert.rejects(api.checkConnection(), (error) => {
    assertControlledError(error, "rejected", 40164);
    assert.match(error.message, /出口 IPv4 为 203\.0\.113\.27/);
    assert.doesNotMatch(error.message, /ipv6|::ffff|not in whitelist/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("invalid, ambiguous and unrelated error addresses are not echoed as whitelist guidance", async () => {
  for (const [errcode, errmsg] of [
    [40164, "invalid ip 999.1.2.3, not in whitelist"],
    [40164, "invalid ip 01.2.3.4, not in whitelist"],
    [40164, "invalid ip 1.2.3.4.5, not in whitelist"],
    [40164, "invalid ip 203.0.113.27.example.com, not in whitelist"],
    [40164, "invalid ip 2001:db8::1, not in whitelist"],
    [40164, "request failed at https://203.0.113.27/"],
    [40164, { ip: "203.0.113.27" }],
    [48001, "invalid ip 203.0.113.27, not in whitelist"],
  ]) {
    const { api } = fixture([jsonResponse({ errcode, errmsg })]);
    await assert.rejects(api.checkConnection(), (error) => {
      assertControlledError(error, "rejected", errcode);
      assert.doesNotMatch(error.message, /(?:\d{1,3}\.){3}\d{1,3}|2001:db8|example\.com/);
      return true;
    });
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
    assert.match(result.message, /公众号后台核对.*无需重复同步/u);
    assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/get"]);
  }
});

test("failed readback never causes another draft creation", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ media_id: "draft-1" }), () => { throw new Error("network lost"); }]);
  const draftId = await api.createDraft(draft);
  await assert.rejects(api.verifyDraft({ draftId, ...draft }), (error) => assertControlledError(error, "uncertain"));
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/add", "/cgi-bin/draft/get"]);
});

test("cover saves may trim outer title spaces without accepting changed text or body", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ media_id: "draft-1" }), draftResponse()]);
  await api.createDraft({ ...draft, title: ` ${draft.title} ` });
  assert.equal(JSON.parse(calls[1].options.body).articles[0].title, draft.title);
  const result = await api.verifyDraft({ ...draft, title: ` ${draft.title} `, draftId: "draft-1" });
  assert.equal(result.verified, true);
  for (const patch of [{ title: "海报 草稿" }, { title: "海报草稿！" }, { content: ` ${draft.body} ` }]) {
    const changed = fixture([tokenResponse(), draftResponse(patch)]);
    assert.equal((await changed.api.verifyDraft({ ...draft, draftId: "draft-1" })).verified, false);
  }
});

test("verification diagnostics identify exact mismatched fields without retaining article values", async () => {
  for (const [patch, expected] of [
    [{}, []],
    [{ article_type: "news" }, ["type"]],
    [{ title: "private-changed-title" }, ["title"]],
    [{ content: "private-changed-body" }, ["content"]],
    [{ image_info: { image_list: [{ image_media_id: "picture-1" }] } }, ["imageCount"]],
    [{ image_info: null }, ["imageCount"]],
    [{ image_info: { image_list: [{ image_media_id: "picture-2" }, { image_media_id: "picture-1" }] } }, ["imageOrder"]],
    [{ image_info: { image_list: [{ image_media_id: "picture-1" }, null] } }, ["imageOrder"]],
    [{ article_type: "news", title: "private-changed-title", content: "private-changed-body", image_info: null }, ["type", "title", "content", "imageCount"]],
  ]) {
    const { api } = fixture([tokenResponse(), draftResponse(patch)]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.deepEqual(result.verificationMismatches, expected);
    assert.equal(result.verified, expected.length === 0);
    assert.doesNotMatch(JSON.stringify(result), /private-changed-title|private-changed-body/);
  }
  assert.deepEqual(normalizeDraftVerificationMismatches(["imageOrder", "title"]), ["title", "imageOrder"]);
  assert.deepEqual(normalizeDraftVerificationMismatches([]), []);
  for (const invalid of [undefined, null, {}, ["content", "content"], ["private-body"], [123], Array(6).fill("title")]) {
    assert.equal(normalizeDraftVerificationMismatches(invalid), undefined);
  }
});

test("readback messages name content differences without implying that upload must be repeated", async () => {
  for (const [patch, label] of [
    [{ title: "后台新标题" }, "标题"],
    [{ content: "后台新配文" }, "配文"],
    [{ image_info: { image_list: [] } }, "图片数量"],
    [{ image_info: { image_list: [{ image_media_id: "picture-2" }, { image_media_id: "picture-1" }] } }, "图片或顺序"],
    [{ title: "后台新标题", content: "后台新配文" }, "标题、配文"],
  ]) {
    const { api } = fixture([tokenResponse(), draftResponse(patch)]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, false);
    assert.equal(result.message, `草稿已存在，但${label}与本次同步记录不一致。请在公众号后台核对，无需重复同步。`);
  }
  for (const [response, message] of [
    [jsonResponse({ news_item: [] }), "暂未读到完整的草稿详情。请在公众号后台核对，无需重复同步。"],
    [draftResponse({ article_type: "news" }), "读取的草稿类型与本次贴图不一致。请在公众号后台核对，无需重复同步。"],
  ]) {
    const { api } = fixture([tokenResponse(), response]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, false);
    assert.equal(result.message, message);
    assert.doesNotMatch(result.message, /草稿已存在|已核对|上传失败/u);
  }
});

test("draft readback keeps only bounded cover crop diagnostics without judging cover appearance", async () => {
  const crops = [
    { ratio: "3_4", x1: 0, y1: 0, x2: 1, y2: 1 },
    { ratio: "future-ratio:3/4", x1: 0.125, y1: 0.25, x2: 0.875, y2: 0.75 },
  ];
  for (const verified of [true, false]) {
    const { api, calls } = fixture([tokenResponse(), draftResponse({
      ...(verified ? {} : { title: "后台已修改的标题" }),
      cover_info: { thumb_url: "https://private.example/cover?secret=hidden", unknown: "hidden",
        crop_percent_list: crops.map((crop) => ({ ...crop, x1: String(crop.x1), y1: String(crop.y1), x2: String(crop.x2), y2: String(crop.y2), thumb_url: "hidden", extra: "hidden" })) },
    })]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, verified);
    assert.deepEqual(result.coverInfo, { crop_percent_list: crops });
    assert.doesNotMatch(JSON.stringify(result.coverInfo), /hidden|thumb_url|private\.example|extra/);
    assert.doesNotMatch(JSON.stringify(result), /hidden|private\.example/);
    assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/get"]);
  }
});

test("missing or invalid crop diagnostics do not change successful content verification", async () => {
  const crop = { ratio: "1_1", x1: 0, y1: 0, x2: 1, y2: 1 };
  const invalid = [undefined, null, {}, { crop_percent_list: {} },
    { crop_percent_list: Array(9).fill(crop) },
    ...[null, { ...crop, ratio: "" }, { ...crop, ratio: "a".repeat(33) }, { ...crop, ratio: "1_1\n" },
      { ...crop, x1: "" }, { ...crop, x1: " 0" }, { ...crop, x1: "0 " }, { ...crop, x1: "0e0" },
      { ...crop, x1: "0." }, { ...crop, x1: ".1" }, { ...crop, x1: "00" }, { ...crop, x1: "-0" },
      { ...crop, x1: "0." + "0".repeat(31) }, { ...crop, x2: "1.01" }, { ...crop, x1: null }, { ...crop, x1: false },
      { ...crop, x1: -0.01 }, { ...crop, x2: 1.01 },
      { ...crop, y1: 1 }, { ...crop, y2: 0 }, { ...crop, x2: 0 },
      { ...crop, x1: NaN }, { ...crop, y2: Infinity },
    ].map((value) => ({ crop_percent_list: [crop, value] })),
  ];
  for (const cover_info of invalid) {
    assert.equal(normalizeDraftCoverInfo(cover_info), undefined);
    const { api } = fixture([tokenResponse(), draftResponse({ cover_info })]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, true);
    assert.equal(Object.hasOwn(result, "coverInfo"), false);
  }
  assert.deepEqual(normalizeDraftCoverInfo({ crop_percent_list: [] }), { crop_percent_list: [] });
  assert.deepEqual(normalizeDraftCoverInfo({ crop_percent_list: [{ ...crop, x1: "0.0", x2: "1.00" }] }), { crop_percent_list: [crop] });
  assert.equal(normalizeDraftCoverInfo({ crop_percent_list: Array(8).fill(crop) }).crop_percent_list.length, 8);
});

test("cover source readback compares only valid media IDs and retains field names without other values", async () => {
  for (const thumb_media_id of ["picture-1", "another-cover"]) {
    const { api, calls } = fixture([tokenResponse(), draftResponse({
      thumb_media_id, thumb_url: "https://private.example/cover?secret=hidden",
      cover_info: { crop_percent_list: [], unknown_crop_setting: "hidden-value" },
    })]);
    const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
    assert.equal(result.verified, true);
    assert.deepEqual(result.coverSource, {
      thumbMediaId: thumb_media_id, firstImageMediaId: "picture-1", isFirstImage: thumb_media_id === "picture-1",
      articleFieldNames: ["article_type", "title", "content", "image_info", "thumb_media_id", "thumb_url", "cover_info"],
      coverFieldNames: ["crop_percent_list", "unknown_crop_setting"],
    });
    assert.doesNotMatch(JSON.stringify(result), /private\.example|secret=|hidden-value/);
    assert.deepEqual(calls.map((call) => call.url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/draft/get"]);
  }
});

test("cover source bounds field names and rejects invalid IDs without inventing a comparison", async () => {
  const names = { articleFieldNames: ["thumb_media_id"], coverFieldNames: [] };
  for (const invalid of [undefined, null, false, 123, "", "has space", "line\nbreak", "null\0byte", "x".repeat(513),
    "https://private.example/image", "//private.example/image", "data:image/png;base64,private"]) {
    const source = normalizeDraftCoverSource({ ...names, thumbMediaId: invalid, firstImageMediaId: "picture-1", isFirstImage: true });
    assert.deepEqual(source, { ...names, firstImageMediaId: "picture-1" });
    assert.deepEqual(normalizeDraftCoverSource({ ...names, thumbMediaId: "picture-1", firstImageMediaId: invalid, isFirstImage: true }),
      { ...names, thumbMediaId: "picture-1" });
  }
  assert.equal(normalizeDraftCoverSource({ ...names, thumbMediaId: "x".repeat(512) }).thumbMediaId.length, 512);
  for (const invalid of [undefined, null, [], {}, { ...names, articleFieldNames: Array(65).fill("key") },
    { ...names, coverFieldNames: ["key".repeat(22)] }, { ...names, coverFieldNames: ["bad-key"] },
    { ...names, coverFieldNames: ["https://private.example"] }, { ...names, coverFieldNames: [123] }]) {
    assert.equal(normalizeDraftCoverSource(invalid), undefined);
  }
  const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`key_${index}`, "hidden"]));
  const { api } = fixture([tokenResponse(), draftResponse({ ...many, "invalid-key": "hidden", ["x".repeat(65)]: "hidden", cover_info: many })]);
  const result = await api.verifyDraft({ draftId: "draft-1", ...draft });
  assert.equal(result.coverSource.articleFieldNames.length, 64);
  assert.equal(result.coverSource.coverFieldNames.length, 64);
  assert.equal(Object.hasOwn(result.coverSource, "isFirstImage"), false);
  assert.doesNotMatch(JSON.stringify(result), /hidden|invalid-key/);
  const missing = fixture([tokenResponse(), jsonResponse({ news_item: [] })]);
  assert.equal(Object.hasOwn(await missing.api.verifyDraft({ draftId: "draft-1", ...draft }), "coverSource"), false);
});

test("invalid input is rejected before any account request", async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(api.uploadImage({ blob: new Blob(["svg"], { type: "image/svg+xml" }), name: "image.svg" }), TypeError);
  await assert.rejects(api.createDraft({ ...draft, imageMediaIds: [] }), TypeError);
  await assert.rejects(api.createDraft({ ...draft, imageMediaIds: Array(21).fill("picture") }), TypeError);
  await assert.rejects(api.verifyDraft({ draftId: "", ...draft }), TypeError);
  await assert.rejects(api.submitPublication({ draftId: "" }), TypeError);
  await assert.rejects(api.getPublication({ publishId: "" }), TypeError);
  assert.equal(calls.length, 0);
  assert.throws(() => createWechatApi({ appId, appSecret: "" }), TypeError);
});

test("publication sends only the verified draft ID and polls the returned task without submitting again", async () => {
  const { api, calls } = fixture([tokenResponse(), jsonResponse({ errcode: 0, publish_id: "publish-1" }), jsonResponse({
    publish_id: "publish-1", publish_status: 0, article_id: "article-1",
    article_detail: { count: 1, item: [{ idx: 1, article_url: "https://mp.weixin.qq.com/s/fixture" }] },
  })]);
  assert.deepEqual(await api.submitPublication({ draftId: "draft-1" }), { publishId: "publish-1" });
  const result = await api.getPublication({ publishId: "publish-1" });
  assert.equal(result.status, "published");
  assert.equal(result.articleId, "article-1");
  assert.deepEqual(result.urls, ["https://mp.weixin.qq.com/s/fixture"]);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/cgi-bin/stable_token", "/cgi-bin/freepublish/submit", "/cgi-bin/freepublish/get"]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { media_id: "draft-1" });
  assert.deepEqual(JSON.parse(calls[2].options.body), { publish_id: "publish-1" });
});

test("all documented publication states map without claiming an incomplete success", async () => {
  for (const [publish_status, status] of [[1, "publishing"], [2, "failed"], [3, "failed"], [4, "failed"], [5, "removed"], [6, "blocked"]]) {
    const { api } = fixture([tokenResponse(), jsonResponse({ publish_id: "publish-1", publish_status })]);
    const result = await api.getPublication({ publishId: "publish-1" });
    assert.equal(result.status, status);
    assert.deepEqual(result.urls, []);
  }
  const complete = { publish_id: "publish-1", publish_status: 0, article_id: "article-1", article_detail: { count: 1, item: [{ idx: 1, article_url: "https://mp.weixin.qq.com/s/fixture" }] } };
  for (const patch of [
    { publish_status: 99 }, { publish_status: "0" }, { publish_id: "another-task" },
    { article_id: undefined }, { article_detail: undefined },
    { article_detail: { count: 2, item: complete.article_detail.item } },
    { article_detail: { count: 1, item: [{ idx: 1, article_url: "https://attacker.example/" }] } },
    { article_detail: { count: 1, item: [{ idx: 1, article_url: "https://secret@mp.weixin.qq.com/" }] } },
    { article_detail: { count: 1, item: [{ idx: 1, article_url: "javascript:alert(1)" }] } },
  ]) {
    const { api, calls } = fixture([tokenResponse(), jsonResponse({ ...complete, ...patch })]);
    await assert.rejects(api.getPublication({ publishId: "publish-1" }), (error) => assertControlledError(error, "uncertain"));
    assert.equal(calls.length, 2);
  }
});

test("publication refusals are controlled and lost submit receipts never retry", async () => {
  for (const errcode of [48001, 53503, 53504, 53505]) {
    const { api, calls } = fixture([tokenResponse(), jsonResponse({ errcode, errmsg: `raw-error-detail ${appSecret} ${accessToken}` })]);
    await assert.rejects(api.submitPublication({ draftId: "draft-1" }), (error) => {
      assertControlledError(error, "rejected", errcode);
      assert.match(error.message, errcode === 48001 ? /权限/u : /后台/u);
      return true;
    });
    assert.equal(calls.length, 2);
  }
  for (const response of [
    () => { throw new Error(`raw-error-detail ${accessToken}`); },
    new Response("gateway failed", { status: 502 }),
    jsonResponse({ errcode: 0 }), new Response("invalid json"),
  ]) {
    const { api, calls } = fixture([tokenResponse(), response]);
    await assert.rejects(api.submitPublication({ draftId: "draft-1" }), (error) => {
      assertControlledError(error, "uncertain"); assert.match(error.message, /发表.*不会自动重试/u); return true;
    });
    assert.equal(calls.length, 2);
  }
});
