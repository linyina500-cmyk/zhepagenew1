import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { compareDraftEvidence, createXhsBrowserDriver, readPageEvidence, SELECTORS, validDraftRef } from "../server/xiaohongshu/driver.mjs";

function domEvidence(html) {
  const dom = new JSDOM(html, { url: "https://creator.xiaohongshu.com/publish/publish?target=image", runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 });
  for (const image of dom.window.document.querySelectorAll("img")) {
    Object.defineProperty(image, "complete", { value: true }); Object.defineProperty(image, "naturalWidth", { value: 1080 });
  }
  const result = dom.window.eval(`(${readPageEvidence.toString()})(${JSON.stringify({ selectors: SELECTORS })})`);
  dom.window.close();
  return JSON.parse(JSON.stringify(result));
}
const card = (source) => `<div class="pr"><img src="${source}"><div class="image-editor-control"><button class="edit-btn">编辑</button></div></div>`;

test("DOM evidence reads exact paragraph spacing and requires account identity in the header", () => {
  const state = domEvidence(`<header><a href="https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567">测试账号</a></header>
    <input placeholder="填写标题" value="测试标题"><div class="tiptap ProseMirror" contenteditable="true"><p>首段</p><p><br class="ProseMirror-trailingBreak"></p><p>末段</p><p><br class="ProseMirror-trailingBreak"></p></div>
    <div class="img-preview-area">${card("https://cdn.example/first")}${card("https://cdn.example/second")}</div>`);
  assert.equal(state.body, "首段\n\n末段\n"); assert.equal(state.account.uid, "0123456789abcdef01234567");
  assert.deepEqual(state.images.map((image) => image.key), ["https://cdn.example/first", "https://cdn.example/second"]);
  assert.equal(domEvidence('<a href="https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567">其他笔记作者</a>').account, null);
  assert.equal(domEvidence("<header>只有昵称</header>").account, null);
});

test("blob previews and hidden ambiguous account identities never become stable evidence", () => {
  const state = domEvidence(`<header><a href="https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567">甲</a><a href="https://www.xiaohongshu.com/user/profile/abcdef012345678901234567">乙</a></header><div class="img-preview-area">${card("blob:https://creator.xiaohongshu.com/preview")}</div>`);
  assert.equal(state.account, null); assert.equal(state.images[0].loaded, true); assert.equal(state.images[0].key, null);
});

test("draft verification rejects reordered, missing, broken or processing images and changed text", () => {
  const draftRef = { id: "one", url: "https://creator.xiaohongshu.com/publish/publish?target=image&draft_id=one", images: ["https://cdn.example/1", "https://cdn.example/2"] };
  const expected = { title: "测试", body: "正文\n", draftRef };
  const correct = { title: "测试", body: "正文\n", blocked: false, images: draftRef.images.map((key) => ({ key, loaded: true, processing: false, failed: false })) };
  assert.equal(validDraftRef(draftRef, 2), true); assert.equal(compareDraftEvidence(correct, expected), true);
  for (const altered of [
    { ...correct, images: correct.images.toReversed() }, { ...correct, images: correct.images.slice(0, 1) },
    { ...correct, images: correct.images.map((image) => ({ ...image, loaded: false })) },
    { ...correct, images: correct.images.map((image) => ({ ...image, processing: true })) },
    { ...correct, title: "另一个标题" }, { ...correct, body: "正文" }, { ...correct, blocked: true },
  ]) assert.equal(compareDraftEvidence(altered, expected), false);
  assert.equal(validDraftRef({ ...draftRef, images: [null, null] }, 2), false);
  assert.equal(validDraftRef({ ...draftRef, url: "https://creator.xiaohongshu.com/publish/publish?target=image&draft_id=two" }, 2), false);
  assert.equal(validDraftRef({ ...draftRef, url: "https://evil.test/publish/publish?target=image&draft_id=one" }, 2), false);
});

async function browserFixture(t, { saveError = false, reverseReadback = false, reverseUpload = false, firstBlob = false } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-driver-"));
  const calls = [], uid = "0123456789abcdef01234567";
  let url = "about:blank", state = { title: "", body: "", images: [], drafts: [], account: { uid, name: "测试账号" }, blocked: false }, stored;
  const makeLocator = (kind) => ({
    filter() { return this; }, async count() { return 1; }, async isEnabled() { return true; },
    async innerText() { return `草稿箱(${state.drafts.length})`; },
    async fill(value) { state[kind] = value; },
    async setInputFiles(path) {
      calls.push(["file", path]);
      const index = state.images.length;
      state.images.push({ key: firstBlob && index === 0 ? null : `https://cdn.example/${index + 1}`, loaded: true, ready: true, processing: false, failed: false });
      if (index === 1 && reverseUpload) state.images.reverse();
      if (index === 1 && firstBlob) state.images[0].key = "https://cdn.example/1";
    },
    async click() {
      if (kind !== "save") return;
      calls.push(["save"]);
      stored = structuredClone(state);
      if (saveError) throw new Error("click result unknown");
      state = { ...state, title: "", body: "", images: [], drafts: [{ id: "one", url: "https://creator.xiaohongshu.com/publish/publish?target=image&draft_id=one", text: stored.title }] };
    },
  });
  const page = {
    url: () => url, isClosed: () => false, async bringToFront() {},
    async goto(target) {
      calls.push(["goto", target]); url = target;
      if (target.includes("draft_id=one")) state = { ...state, title: stored.title, body: stored.body, images: reverseReadback ? stored.images.toReversed() : stored.images };
      else state = { ...state, title: "", body: "", images: [] };
    },
    async evaluate() { return structuredClone(state); },
    getByText() { return makeLocator("drafts"); },
    locator(selector) { return makeLocator(selector === SELECTORS.input ? "input" : selector === SELECTORS.title ? "title" : selector === SELECTORS.body ? "body" : "save"); },
  };
  const context = { setDefaultTimeout() {}, pages: () => [page], async close() { calls.push(["close"]); } };
  const chromium = { async launchPersistentContext(path, options) { calls.push(["launch", path, options]); return context; } };
  const driver = createXhsBrowserDriver({ profileDir, chromium, timeoutMs: 300 });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  return { driver, calls, profileDir };
}

test("driver is lazy, uses a dedicated persistent profile and preserves native file order", async (t) => {
  const f = await browserFixture(t);
  assert.deepEqual(f.calls, []);
  const { account } = await f.driver.checkConnection();
  assert.equal(f.calls[0][0], "launch"); assert.equal(f.calls[0][1], f.profileDir); assert.equal(f.calls[0][2].headless, false); assert.equal(f.calls[0][2].channel, "chrome");
  const images = [{ path: "/original/a.png" }, { path: "/original/b.jpg" }], progress = [];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images, onProgress: async (count) => progress.push(count) });
  const saved = await f.driver.saveDraft({ prepared });
  assert.deepEqual(f.calls.filter(([kind]) => kind === "file"), [["file", "/original/a.png"], ["file", "/original/b.jpg"]]);
  assert.deepEqual(progress, [1, 2]); assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "配文", images })).verified, true);
});

test("driver never retries an ambiguous save click", async (t) => {
  const f = await browserFixture(t, { saveError: true }), { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  await assert.rejects(f.driver.saveDraft({ prepared }), /unknown/);
  await assert.rejects(f.driver.saveDraft({ prepared }), /不能重复/);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
});

test("driver readback cannot confirm a reordered draft", async (t) => {
  const f = await browserFixture(t, { reverseReadback: true }), { account } = await f.driver.checkConnection();
  const images = [{ path: "/a.png" }, { path: "/b.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "配文", images })).verified, false);
});

test("driver stops if already uploaded images are reordered during the next upload", async (t) => {
  const f = await browserFixture(t, { reverseUpload: true }), { account } = await f.driver.checkConnection();
  await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }, { path: "/b.png" }], onProgress: async () => {} }), /顺序发生变化/);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 0);
});

test("a blob preview cannot be upgraded to proven original identity by a later URL", async (t) => {
  const f = await browserFixture(t, { firstBlob: true }), { account } = await f.driver.checkConnection();
  const images = [{ path: "/a.png" }, { path: "/b.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  assert.deepEqual(prepared.images, [null, "https://cdn.example/2"]);
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images })).verified, false);
});
