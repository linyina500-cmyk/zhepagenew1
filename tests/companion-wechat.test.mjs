import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { saveWechatDraft, verifyWechatAccount } from "../companion/providers/wechat.mjs";

const appId = "wx0123456789abcdef";
const secret = "test-secret-never-return";
const token = "test-token-never-return";
const account = { appId, appSecret: secret, remoteId: appId, displayName: "测试公众号" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fZkAAAAASUVORK5CYII=", "base64");
const makeDraft = () => ({
  title: "图片草稿",
  body: "第一段\n第二段",
  images: [1, 2].map((index) => ({ name: `${index}.png`, mime: "image/png", bytes: Buffer.from(png), width: 1, height: 1 })),
});

function mockApi(overrides = {}) {
  const calls = [];
  let createdArticle;
  let uploadCount = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const request = { url: parsed, options, json: typeof options.body === "string" ? JSON.parse(options.body) : undefined };
    calls.push(request);
    assert.equal(parsed.origin, "https://api.weixin.qq.com");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (overrides[parsed.pathname]) return overrides[parsed.pathname](request, calls);
    switch (parsed.pathname) {
      case "/cgi-bin/stable_token":
        return Response.json({ access_token: token, expires_in: 7200 });
      case "/cgi-bin/draft/count":
        return Response.json({ total_count: 4 });
      case "/cgi-bin/material/add_material":
        uploadCount += 1;
        return Response.json({ media_id: `image-${uploadCount}`, url: "https://ignored.invalid/image.png" });
      case "/cgi-bin/draft/add":
        createdArticle = request.json.articles[0];
        return Response.json({ media_id: "draft-1" });
      case "/cgi-bin/draft/get":
        return Response.json({ news_item: [createdArticle] });
      default:
        assert.fail(`Unexpected API endpoint: ${parsed.pathname}`);
    }
  };
  return { calls, fetchImpl };
}

test("account verification checks the selected AppID and draft read permission without returning credentials", async () => {
  const api = mockApi();
  const result = await verifyWechatAccount({ appId, appSecret: secret, fetchImpl: api.fetchImpl });
  assert.deepEqual(result, { remoteId: appId, displayName: appId });
  assert.deepEqual(api.calls.map(({ url, options }) => [url.pathname, options.method]), [
    ["/cgi-bin/stable_token", "POST"], ["/cgi-bin/draft/count", "GET"],
  ]);
  assert.deepEqual(api.calls[0].json, { grant_type: "client_credential", appid: appId, secret, force_refresh: false });
  assert.equal(api.calls[0].url.search, "");
  assert.equal(api.calls[1].url.searchParams.get("access_token"), token);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(token));
});

test("only a matching newspic readback confirms a successful save, preserving image order", async () => {
  const api = mockApi();
  const draft = makeDraft();
  const result = await saveWechatDraft({ account, draft, fetchImpl: api.fetchImpl });
  assert.equal(result.status, "saved");
  assert.equal(result.draftId, "draft-1");
  assert.equal(result.url, "https://mp.weixin.qq.com/");
  const uploads = api.calls.filter(({ url }) => url.pathname === "/cgi-bin/material/add_material");
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(upload.url.searchParams.get("type"), "image");
    const file = upload.options.body.get("media");
    assert.equal(file.type, "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  }
  const add = api.calls.find(({ url }) => url.pathname === "/cgi-bin/draft/add");
  assert.deepEqual(add.json.articles, [{
    article_type: "newspic", title: draft.title, content: draft.body,
    need_open_comment: 0, only_fans_can_comment: 0,
    image_info: { image_list: [{ image_media_id: "image-1" }, { image_media_id: "image-2" }] },
  }]);
  assert.deepEqual(api.calls.at(-1).json, { media_id: "draft-1" });
  assert.ok(api.calls.every(({ url }) => !url.pathname.includes("freepublish")));
});

test("an ambiguous draft creation is never retried or reported as saved", async (t) => {
  for (const [name, response] of [
    ["timeout", () => { throw new Error(`request timed out: ${token} ${secret}`); }],
    ["HTTP failure", () => new Response("upstream unavailable", { status: 502 })],
    ["invalid JSON", () => new Response("truncated")],
    ["missing identifier", () => Response.json({ errcode: 0 })],
    ["unusable identifier", () => Response.json({ media_id: {} })],
  ]) {
    await t.test(name, async () => {
      const api = mockApi({ "/cgi-bin/draft/add": response });
      const result = await saveWechatDraft({ account, draft: makeDraft(), fetchImpl: api.fetchImpl });
      assert.equal(result.status, "needs_confirmation");
      assert.equal(result.draftId, undefined);
      assert.equal(api.calls.filter(({ url }) => url.pathname === "/cgi-bin/draft/add").length, 1);
      assert.equal(api.calls.filter(({ url }) => url.pathname === "/cgi-bin/draft/get").length, 0);
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(!JSON.stringify(result).includes(token));
    });
  }
});

test("an explicit API rejection reports a sanitized error and does not retry", async () => {
  const api = mockApi({ "/cgi-bin/draft/add": () => Response.json({ errcode: 48001, errmsg: `${token} ${secret}` }) });
  const result = await saveWechatDraft({ account, draft: makeDraft(), fetchImpl: api.fetchImpl });
  assert.equal(result.status, "failed");
  assert.match(result.message, /没有此接口权限/);
  assert.match(result.message, /素材库/);
  assert.ok(!result.message.includes(secret));
  assert.ok(!result.message.includes(token));
  assert.equal(api.calls.filter(({ url }) => url.pathname === "/cgi-bin/draft/add").length, 1);
});

test("readback failure or changed content requires confirmation while retaining the created draft ID", async (t) => {
  const original = {
    article_type: "newspic", title: "图片草稿", content: "第一段\n第二段",
    image_info: { image_list: [{ image_media_id: "image-1" }, { image_media_id: "image-2" }] },
  };
  const variants = [
    ["title changed", { ...original, title: "其他标题" }],
    ["body changed", { ...original, content: "其他正文" }],
    ["article type changed", { ...original, article_type: "news" }],
    ["images reordered", { ...original, image_info: { image_list: [...original.image_info.image_list].reverse() } }],
    ["image lost", { ...original, image_info: { image_list: original.image_info.image_list.slice(0, 1) } }],
    ["unreadable", null],
  ];
  for (const [name, entry] of variants) {
    await t.test(name, async () => {
      const api = mockApi({ "/cgi-bin/draft/get": () => {
        if (!entry) throw new Error("network lost");
        return Response.json({ news_item: [entry] });
      } });
      const result = await saveWechatDraft({ account, draft: makeDraft(), fetchImpl: api.fetchImpl });
      assert.equal(result.status, "needs_confirmation");
      assert.equal(result.draftId, "draft-1");
      assert.equal(api.calls.filter(({ url }) => url.pathname === "/cgi-bin/draft/add").length, 1);
    });
  }
});

test("account mismatch and invalid drafts never make network requests", async (t) => {
  const invalidDrafts = [
    { ...makeDraft(), title: "字".repeat(21) },
    { ...makeDraft(), title: "🌿".repeat(21) },
    { ...makeDraft(), title: `${"字".repeat(20)} ` },
    { ...makeDraft(), body: Array(11).fill("#话题").join(" ") },
    { ...makeDraft(), body: Array(11).fill("#话题#").join("") },
    { ...makeDraft(), body: "中".repeat(683) },
    { ...makeDraft(), body: "a".repeat(1001) },
    { ...makeDraft(), images: [] },
    { ...makeDraft(), images: Array(21).fill(makeDraft().images[0]) },
    { ...makeDraft(), images: [{ ...makeDraft().images[0], bytes: Buffer.alloc(10_000_001) }] },
    { ...makeDraft(), images: [{ ...makeDraft().images[0], mime: "image/jpeg" }] },
    { ...makeDraft(), images: [{ ...makeDraft().images[0], bytes: Buffer.from("not an image") }] },
  ];
  for (let i = 0; i < invalidDrafts.length; i += 1) {
    await t.test(`invalid draft ${i + 1}`, async () => {
      const api = mockApi();
      const result = await saveWechatDraft({ account, draft: invalidDrafts[i], fetchImpl: api.fetchImpl });
      assert.equal(result.status, "failed");
      assert.equal(api.calls.length, 0);
    });
  }
  const api = mockApi();
  const mismatch = await saveWechatDraft({ account: { ...account, remoteId: "another-account" }, draft: makeDraft(), fetchImpl: api.fetchImpl });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.message, /不一致/);
  assert.equal(api.calls.length, 0);
});

test("direct Wechat saves accept twenty Unicode title characters and ten topics without treating Markdown or closing hashes as topics", async () => {
  const api = mockApi();
  const draft = {
    ...makeDraft(),
    title: "🌿中文A".repeat(5),
    body: `${Array.from({ length: 10 }, (_, index) => `#话题${index + 1}#`).join("\n")}\n#\n## 普通标题`,
  };
  const result = await saveWechatDraft({ account, draft, fetchImpl: api.fetchImpl });
  assert.equal(result.status, "saved");
  const article = api.calls.find(({ url }) => url.pathname === "/cgi-bin/draft/add").json.articles[0];
  assert.equal(article.title, draft.title);
  assert.equal(article.content, draft.body);
});

test("the submitted content is a snapshot even if caller state changes during upload", async () => {
  const draft = makeDraft();
  const api = mockApi();
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === "/cgi-bin/stable_token") {
      draft.title = "被更改的标题";
      draft.body = "被更改的正文";
      draft.images[0].bytes.fill(0);
      draft.images.reverse();
    }
    return api.fetchImpl(url, options);
  };
  const result = await saveWechatDraft({ account, draft, fetchImpl });
  assert.equal(result.status, "saved");
  const created = api.calls.find(({ url }) => url.pathname === "/cgi-bin/draft/add").json.articles[0];
  assert.equal(created.title, "图片草稿");
  assert.equal(created.content, "第一段\n第二段");
  const uploaded = api.calls.find(({ url }) => url.pathname === "/cgi-bin/material/add_material").options.body.get("media");
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png);
});

test("verification failures never reveal credentials or raw upstream error text", async (t) => {
  for (const response of [
    () => { throw new Error(`https://api.weixin.qq.com/?access_token=${token}&secret=${secret}`); },
    () => Response.json({ errcode: 40164, errmsg: `sensitive ${secret} ${token}` }),
    () => Response.json({ errcode: secret, errmsg: token }),
  ]) {
    await t.test("sanitized failure", async () => {
      const api = mockApi({ "/cgi-bin/stable_token": response });
      await assert.rejects(verifyWechatAccount({ appId, appSecret: secret, fetchImpl: api.fetchImpl }), (error) => {
        assert.ok(!String(error).includes(secret));
        assert.ok(!String(error).includes(token));
        assert.equal(error.cause, undefined);
        assert.equal(error.publicMessage, error.message);
        return true;
      });
    });
  }
});

test("pre-submission failures are failed without suggesting a draft may exist", async (t) => {
  for (const path of ["/cgi-bin/stable_token", "/cgi-bin/material/add_material"]) {
    await t.test(path, async () => {
      const api = mockApi({ [path]: () => { throw new Error(`network lost ${token} ${secret}`); } });
      const result = await saveWechatDraft({ account, draft: makeDraft(), fetchImpl: api.fetchImpl });
      assert.equal(result.status, "failed");
      assert.match(result.message, /未创建公众号草稿/);
      assert.equal(result.message.includes("素材库"), path.includes("add_material"));
      assert.ok(!result.message.includes(token));
      assert.ok(!result.message.includes(secret));
      assert.ok(!api.calls.some(({ url }) => url.pathname === "/cgi-bin/draft/add"));
    });
  }
});
