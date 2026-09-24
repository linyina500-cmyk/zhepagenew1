import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { compareDraftEvidence, createXhsBrowserDriver, readAccountEvidence, readPageEvidence, SELECTORS, validDraftRef, XhsDriverError } from "../server/xiaohongshu/driver.mjs";

function domEvidence(html, reader = readPageEvidence) {
  const dom = new JSDOM(html, { url: "https://creator.xiaohongshu.com/publish/publish?target=image", runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 });
  for (const image of dom.window.document.querySelectorAll("img")) {
    Object.defineProperty(image, "complete", { value: true }); Object.defineProperty(image, "naturalWidth", { value: 1080 });
  }
  const result = dom.window.eval(`(${reader.toString()})(${JSON.stringify({ selectors: SELECTORS })})`);
  dom.window.close();
  return JSON.parse(JSON.stringify(result));
}
const card = (source) => `<div class="pr"><img src="${source}"><div class="image-editor-control"><button class="edit-btn">编辑</button></div></div>`;
const accountCard = (identifier = "test_account_123", name = "测试账号") => `<div class="home-card-wrapper"><div class="personal"><div class="base"><div class="text"><div><span class="account-name">${name}</span></div><div class="static description-text">123 粉丝</div><div class="others description-text"><div>小红书账号: ${identifier}</div><div></div><div>账号简介</div></div></div></div></div></div>`;

test("homepage account evidence reads the explicit identifier and name from one visible account card", () => {
  assert.deepEqual(domEvidence(accountCard(), readAccountEvidence), { identifier: "test_account_123", name: "测试账号" });
  assert.deepEqual(domEvidence(accountCard("9876543210", "数字编号账号").replace("账号:", "账号："), readAccountEvidence), { identifier: "9876543210", name: "数字编号账号" });
  assert.deepEqual(domEvidence(`<div hidden>${accountCard("other", "隐藏账号")}</div>${accountCard()}`, readAccountEvidence), { identifier: "test_account_123", name: "测试账号" });
});

test("account evidence rejects ambiguity, partial cards, header links and identifier-like biography text", () => {
  for (const html of [
    accountCard() + accountCard("other", "另一个账号"),
    `<div style="display:none">${accountCard()}</div>`,
    accountCard(""), accountCard("test_account_123", ""),
    accountCard().replace('class="account-name"', 'class="other-name"'),
    accountCard().replace("小红书账号:", "简介: 小红书账号:"),
    accountCard().replace("小红书账号: test_account_123", "小红书账号: test_account_123 关注我"),
    accountCard().replace("账号简介", "小红书账号: other"),
    `<header><a href="https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567">测试账号</a></header>`,
  ]) assert.equal(domEvidence(html, readAccountEvidence), null);
});

test("DOM evidence reads exact paragraph spacing and image order", () => {
  const state = domEvidence(`<input placeholder="填写标题" value="测试标题"><div class="tiptap ProseMirror" contenteditable="true"><p>首段</p><p><br class="ProseMirror-trailingBreak"></p><p>末段</p><p><br class="ProseMirror-trailingBreak"></p></div>
    <div class="img-preview-area">${card("https://cdn.example/first")}${card("https://cdn.example/second")}</div>`);
  assert.equal(state.body, "首段\n\n末段\n");
  assert.deepEqual(state.images.map((image) => image.key), ["https://cdn.example/first", "https://cdn.example/second"]);
});

test("blob previews never become stable image evidence", () => {
  const state = domEvidence(`<div class="img-preview-area">${card("blob:https://creator.xiaohongshu.com/preview")}</div>`);
  assert.equal(state.images[0].loaded, true); assert.equal(state.images[0].key, null);
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

async function browserFixture(t, { saveError = false, reverseReadback = false, reverseUpload = false, firstBlob = false, accountError, accountCloseError = false, focusError = false, accountRedirect, onAccountNavigate, timeoutMs = 300 } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-driver-"));
  const calls = [];
  let currentAccount = { identifier: "test_account_123", name: "测试账号" };
  let url = "about:blank", state = { title: "", body: "", images: [], drafts: [], blocked: false }, stored;
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
    url: () => url, isClosed: () => false, async bringToFront() { if (focusError) throw new Error("private browser focus error"); },
    async goto(target) {
      calls.push(["goto", target]); url = target;
      if (target.includes("draft_id=one")) state = { ...state, title: stored.title, body: stored.body, images: reverseReadback ? stored.images.toReversed() : stored.images };
      else state = { ...state, title: "", body: "", images: [] };
    },
    async evaluate() { return structuredClone(state); },
    getByText() { return makeLocator("drafts"); },
    locator(selector) { return makeLocator(selector === SELECTORS.input ? "input" : selector === SELECTORS.title ? "title" : selector === SELECTORS.body ? "body" : "save"); },
  };
  const context = {
    setDefaultTimeout() {}, pages: () => [page],
    async newPage() {
      calls.push(["account-open"]);
      let accountUrl = "about:blank";
      return {
        url: () => accountUrl,
        async goto(target, options) {
          calls.push(["account-goto", target]);
          if (accountError === "goto") throw new Error("private browser error");
          accountUrl = accountRedirect ?? target;
          await onAccountNavigate?.(options);
        },
        async evaluate(reader) {
          assert.equal(reader, readAccountEvidence);
          calls.push(["account-read"]);
          if (accountError === "read") throw new Error("private browser error");
          return structuredClone(currentAccount);
        },
        async close() { calls.push(["account-close"]); if (accountCloseError) throw new Error("private browser close error"); },
      };
    },
    async close() { calls.push(["close"]); },
  };
  const chromium = { async launchPersistentContext(path, options) { calls.push(["launch", path, options]); return context; } };
  const driver = createXhsBrowserDriver({ profileDir, chromium, timeoutMs });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  return { driver, calls, profileDir, setAccount: (account) => { currentAccount = account; }, editor: () => structuredClone(state) };
}

test("launch failures are classified without exposing browser errors or a profile path", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-launch-"));
  const driver = createXhsBrowserDriver({ profileDir, chromium: { async launchPersistentContext() { throw new Error(`private browser error ${profileDir}`); } } });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  await assert.rejects(driver.openLogin(), (error) => {
    assert.ok(error instanceof XhsDriverError); assert.equal(error.status, 503); assert.equal(error.code, "browser_open_failed");
    assert.match(error.message, /小红书专用窗口未能启动/); assert.doesNotMatch(error.message, /private|zhepage-xhs-launch/);
    return true;
  });
});

test("initial navigation has a bounded DOM deadline and an explicit retry reuses the same window", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-navigation-"));
  let launches = 0, navigations = 0, url = "about:blank";
  const page = { url: () => url, isClosed: () => false, async bringToFront() {}, async goto(target, options) {
    navigations++;
    assert.deepEqual(options, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (navigations === 1) throw new Error("private browser navigation error");
    url = target;
  } };
  const context = { pages: () => [page], setDefaultTimeout() {}, async close() {}, async newPage() {
    return { async goto() {}, url: () => "https://creator.xiaohongshu.com/login", async close() {} };
  } };
  const driver = createXhsBrowserDriver({ profileDir, chromium: { async launchPersistentContext() { launches++; return context; } } });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  await assert.rejects(driver.openLogin(), (error) => {
    assert.ok(error instanceof XhsDriverError); assert.equal(error.status, 503); assert.equal(error.code, "page_open_failed");
    assert.match(error.message, /小红书页面暂时打不开/); assert.doesNotMatch(error.message, /private/); return true;
  });
  assert.equal(navigations, 1, "failed navigation must not retry in the background");
  assert.equal((await driver.openLogin()).status, "login_required");
  assert.equal(launches, 1); assert.equal(navigations, 2);
});

test("focus failures identify the XHS window and account-tab cleanup does not replace the account result", async (t) => {
  const failed = await browserFixture(t, { focusError: true });
  await assert.rejects(failed.driver.openLogin(), (error) => {
    assert.ok(error instanceof XhsDriverError); assert.equal(error.code, "window_focus_failed"); assert.equal(error.status, 503);
    assert.match(error.message, /小红书专用窗口无法显示/); assert.doesNotMatch(error.message, /private/); return true;
  });
  for (const [accountError, expected] of [[undefined, "connected"], ["read", "needs_attention"]]) {
    const f = await browserFixture(t, { accountError, accountCloseError: true });
    const result = await f.driver.checkConnection();
    assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
});

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
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 6, "connection and every critical identity check must read afresh");
  assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 6);
});

test("checking the account preserves a populated editor and detects a changed account before saving", async (t) => {
  const f = await browserFixture(t), { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  const editor = f.editor(), navigations = f.calls.filter(([kind]) => kind === "goto").length;
  assert.deepEqual((await f.driver.checkConnection()).account, account);
  assert.deepEqual(f.editor(), editor);
  assert.equal(f.calls.filter(([kind]) => kind === "goto").length, navigations);
  f.setAccount({ identifier: "another_account", name: account.name });
  await assert.rejects(f.driver.saveDraft({ prepared }), /账号尚未确认或发生变化/);
  assert.deepEqual(f.editor(), editor);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, f.calls.filter(([kind]) => kind === "account-close").length);
});

test("a successful prior identity check cannot authorize uploading after an account change", async (t) => {
  const f = await browserFixture(t), { account } = await f.driver.checkConnection();
  f.setAccount({ identifier: "another_account", name: account.name });
  await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images: [{ path: "/a.png" }], onProgress: async () => {} }), /账号尚未确认或发生变化/);
  assert.equal(f.calls.filter(([kind]) => kind === "file").length, 0);
});

test("temporary account pages close after redirects, read errors and navigation errors", async (t) => {
  for (const scenario of [
    { options: { accountRedirect: "https://creator.xiaohongshu.com/login" }, status: "login_required" },
    { options: { accountRedirect: "https://example.test/" }, status: "needs_attention" },
    { options: { accountError: "goto" }, status: "needs_attention" },
    { options: { accountError: "read" }, status: "needs_attention" },
  ]) {
    const f = await browserFixture(t, scenario.options);
    const result = await f.driver.checkConnection();
    assert.equal(result.status, scenario.status);
    assert.doesNotMatch(result.message, /private browser error/);
    assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
});

test("an absent homepage identity expires without reusing the previous successful account", async (t) => {
  const f = await browserFixture(t);
  assert.equal((await f.driver.checkConnection()).status, "connected");
  f.setAccount(null);
  assert.equal((await f.driver.checkConnection()).status, "needs_attention");
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "file" || kind === "save").length, 0);
});

test("homepage navigation and account rendering share one capped time budget", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const timeoutMs of [300, 30_000]) {
    const budget = Math.min(timeoutMs, 10_000);
    const f = await browserFixture(t, { timeoutMs, onAccountNavigate: (options) => {
      assert.equal(options.timeout, budget);
      now += budget;
    } });
    assert.equal((await f.driver.checkConnection()).status, "needs_attention");
    assert.equal(f.calls.filter(([kind]) => kind === "account-read").length, 0, "navigation must not grant rendering a new deadline");
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
});

test("driver can select the remaining creator page after an ambiguous first connection", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-reconnect-"));
  let launches = 0, focused = 0;
  const remaining = {
    url: () => "https://creator.xiaohongshu.com/publish/publish?target=image",
    isClosed: () => false,
    async bringToFront() { focused++; },
  };
  let pages = [remaining, { url: () => "https://creator.xiaohongshu.com/home" }];
  const context = { setDefaultTimeout() {}, pages: () => pages, async newPage() {
    return { async goto() {}, url: () => "https://creator.xiaohongshu.com/new/note-manager", async close() {} };
  }, async close() {} };
  const driver = createXhsBrowserDriver({ profileDir, chromium: {
    async launchPersistentContext() { launches++; return context; },
  } });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  await assert.rejects(driver.checkConnection(), /多个小红书页面/);
  assert.equal(focused, 0);
  pages = [remaining];
  assert.equal((await driver.openLogin()).status, "needs_attention");
  assert.equal(focused, 1); assert.equal(launches, 1, "retry must reuse the same persistent context");
  assert.equal((await driver.checkConnection()).status, "needs_attention");
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
