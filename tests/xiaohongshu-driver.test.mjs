import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { compareDraftEvidence, createXhsBrowserDriver, readAccountEvidence, readLoginEvidence, readPageEvidence, saveNativeDraft, SELECTORS, validDraftRef, XhsDriverError } from "../server/xiaohongshu/driver.mjs";
import { readImageFingerprints } from "../server/xiaohongshu/image-evidence.mjs";

const imageKey = (index) => `pixels:1080x1440:${String(index).padStart(64, "0")}`;
const EDITOR_URL = "https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image";
const draftCard = (id, title, type = "image") => `<div class="draft-item" data-draft-id="${id}" data-draft-type="${type}"><div class="draft-title-text">${title}</div><div class="btn"><span>编辑</span></div></div>`;

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

test("login evidence requires a visible phone form or QR code rather than login text alone", () => {
  for (const { html = "", text, expected, size = 120 } of [
    { text: "", expected: false },
    { text: "登录页面发生错误，请稍后重试", expected: false },
    { text: "扫码登录", expected: false },
    { html: '<input type="tel">', text: "欢迎登录", expected: true },
    { html: '<input placeholder="请输入手机号">', text: "登录", expected: true },
    { html: '<input placeholder="请输入验证码">', text: "验证码登录", expected: true },
    { html: '<input type="tel">', text: "填写联系方式", expected: false },
    { html: '<input type="tel">', text: "登录中，请稍候", expected: false },
    { html: '<canvas></canvas>', text: "扫码登录 加载中", expected: false },
    { html: '<div hidden><input type="tel"></div>', text: "登录", expected: false },
    { html: '<div aria-hidden="true"><input placeholder="手机号"></div>', text: "登录", expected: false },
    { html: '<div style="display:none"><input placeholder="验证码"></div>', text: "登录", expected: false },
    { html: '<input type="tel" style="visibility:hidden">', text: "登录", expected: false },
    { html: '<input type="tel">', text: "登录", expected: false, size: 0 },
    { html: "<canvas></canvas>", text: "请扫码登录", expected: true },
    { html: '<img class="qrcode" alt="登录二维码">', text: "请扫码登录", expected: true },
    { html: '<img alt="二维码">', text: "请扫码登录", expected: true },
    { html: '<img alt="网站标志">', text: "请扫码登录", expected: false },
    { html: '<div hidden><canvas></canvas></div>', text: "请扫码登录", expected: false },
    { html: "<canvas></canvas>", text: "请扫码登录", expected: false, size: 80 },
    { html: '<img class="qrcode">', text: "登录", expected: false },
  ]) {
    const dom = new JSDOM(`<body>${html}</body>`, { runScripts: "outside-only" });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: size, height: size });
    Object.defineProperty(dom.window.document.body, "innerText", { value: text });
    assert.equal(dom.window.eval(`(${readLoginEvidence.toString()})()`).loginVisible, expected, `${text}: ${html}`);
    dom.window.close();
  }
});

test("DOM evidence reads exact paragraph spacing and leaves image identity to pixel hashing", () => {
  const state = domEvidence(`<input placeholder="填写标题" value="测试标题"><div class="tiptap ProseMirror" contenteditable="true"><p>首段</p><p><br class="ProseMirror-trailingBreak"></p><p>末段</p><p><br class="ProseMirror-trailingBreak"></p></div>
    <div class="img-preview-area">${card("https://cdn.example/first")}${card("https://cdn.example/second")}</div>`);
  assert.equal(state.body, "首段\n\n末段\n");
  assert.deepEqual(state.images.map((image) => image.key), [null, null]);
  assert.ok(state.images.every((image) => image.loaded && image.ready));
});

test("a decoded blob preview alone does not prove image identity", () => {
  const state = domEvidence(`<div class="img-preview-area">${card("blob:https://creator.xiaohongshu.com/preview")}</div>`);
  assert.equal(state.images[0].loaded, true); assert.equal(state.images[0].key, null);
});

test("draft verification rejects reordered, missing, broken or processing images and changed text", () => {
  const draftRef = { kind: "local", id: "one", images: [imageKey(1), imageKey(2)] };
  const expected = { title: "测试", body: "正文\n", draftRef };
  const correct = { title: "测试", body: "正文\n", blocked: false, images: draftRef.images.map((key) => ({ key, loaded: true, processing: false, failed: false })) };
  assert.equal(validDraftRef(draftRef, 2), true); assert.equal(compareDraftEvidence(correct, expected), true);
  for (const altered of [
    { ...correct, images: correct.images.toReversed() }, { ...correct, images: correct.images.slice(0, 1) },
    { ...correct, images: correct.images.map((image) => ({ ...image, loaded: false })) },
    { ...correct, images: correct.images.map((image) => ({ ...image, failed: true })) },
    { ...correct, images: correct.images.map((image) => ({ ...image, processing: true })) },
    { ...correct, images: correct.images.map((image) => ({ ...image, key: null })) },
    { ...correct, title: "另一个标题" }, { ...correct, body: "正文" }, { ...correct, blocked: true },
  ]) assert.equal(compareDraftEvidence(altered, expected), false);
  for (const invalid of [
    { ...draftRef, images: [null, null] }, { ...draftRef, images: [imageKey(1)] },
    { ...draftRef, images: ["https://cdn.example/1", "https://cdn.example/2"] },
    { ...draftRef, images: [imageKey(1).replace("1080x", "0x"), imageKey(2)] },
    { ...draftRef, images: [imageKey(1).slice(0, -1), imageKey(2)] },
    { ...draftRef, kind: undefined }, { ...draftRef, kind: "remote" },
    { ...draftRef, id: "" }, { ...draftRef, id: "a".repeat(129) }, { ...draftRef, id: 'one"] .btn' },
    { id: "one", url: `${EDITOR_URL}&draft_id=one`, images: draftRef.images },
  ]) assert.equal(validDraftRef(invalid, 2), false);
});

test("DOM draft evidence uses native image card IDs and titles without requiring links", () => {
  const id = "a57759f1-b490-4e80-aa79-cdf673d4d2fd";
  const html = `${draftCard(id, "标题一")}${draftCard("two", "标题二")}${draftCard("video", "视频", "video")}
    <div hidden>${draftCard("hidden", "隐藏草稿")}</div>
    <a href="${EDITOR_URL}&draft_id=legacy">旧链接不是本地草稿卡片</a>`;
  assert.deepEqual(domEvidence(html).drafts, [{ id, text: "标题一" }, { id: "two", text: "标题二" }]);
});

test("DOM draft evidence rejects malformed or ambiguous cards and preserves duplicate IDs for validation", () => {
  for (const html of [
    draftCard("", "缺少ID"), draftCard("a".repeat(129), "过长ID"), draftCard("bad/id", "无效ID"),
    draftCard("one", "标题").replace('class="draft-title-text"', 'class="other-title"'),
    draftCard("one", "标题").replace('<div class="btn">', '<div class="draft-title-text">重复标题</div><div class="btn">'),
  ]) assert.deepEqual(domEvidence(html).drafts, []);
  assert.deepEqual(domEvidence(draftCard("one", "标题") + draftCard("one", "标题")).drafts, [{ id: "one", text: "标题" }, { id: "one", text: "标题" }]);
});

function nativeSaveFixture(t, html = "<xhs-publish-btn></xhs-publish-btn>") {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 40 });
  const calls = [];
  class NativePublishButton extends dom.window.HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      root.innerHTML = '<button>暂存离开</button><button>发布</button>';
      const [save, publish] = root.querySelectorAll("button");
      save.addEventListener("click", () => this._onSave());
      publish.addEventListener("click", () => this._onPublish());
    }
    _onSave() { calls.push(["save-handler", this]); this.dispatchEvent(new dom.window.CustomEvent("save")); }
    _onPublish() { calls.push(["publish-handler", this]); this.dispatchEvent(new dom.window.CustomEvent("publish")); }
  }
  dom.window.customElements.define("xhs-publish-btn", NativePublishButton);
  for (const host of dom.window.document.querySelectorAll("xhs-publish-btn")) {
    for (const [name, value] of Object.entries({ "is-save-draft": "true", "save-text": "暂存离开", "save-disabled": "false" })) host.setAttribute(name, value);
    host.addEventListener("save", () => calls.push(["save-event", host]));
    host.addEventListener("publish", () => calls.push(["publish-event", host]));
  }
  return { dom, calls, hosts: [...dom.window.document.querySelectorAll("xhs-publish-btn")],
    save: () => dom.window.eval(`(${saveNativeDraft.toString()})()`) };
}

test("native closed-shadow control invokes only its draft handler once", (t) => {
  const f = nativeSaveFixture(t);
  assert.equal(f.hosts[0].shadowRoot, null, "the platform button is genuinely closed to ordinary selectors");
  assert.equal(f.dom.window.document.querySelectorAll("button").length, 0);
  assert.equal(f.save(), "invoked");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["save-handler", "save-event"]);
  assert.ok(f.calls.every(([, host]) => host === f.hosts[0]), "the native handler keeps its host receiver");
});

test("native save ignores hidden controls and never invokes missing or ambiguous hosts", (t) => {
  for (const markup of [
    '<div hidden><xhs-publish-btn></xhs-publish-btn></div>',
    '<div aria-hidden="true"><xhs-publish-btn></xhs-publish-btn></div>',
    '<div style="display:none"><xhs-publish-btn></xhs-publish-btn></div>',
    '<div style="visibility:hidden"><xhs-publish-btn></xhs-publish-btn></div>',
  ]) {
    const hiddenOnly = nativeSaveFixture(t, markup);
    assert.equal(hiddenOnly.save(), "missing"); assert.deepEqual(hiddenOnly.calls, []);
    const f = nativeSaveFixture(t, `${markup}<xhs-publish-btn></xhs-publish-btn>`);
    assert.equal(f.save(), "invoked");
    assert.deepEqual(f.calls.map(([kind]) => kind), ["save-handler", "save-event"]);
    assert.ok(f.calls.every(([, host]) => host === f.hosts[1]));
  }
  for (const markup of ["", '<xhs-publish-btn></xhs-publish-btn><xhs-publish-btn></xhs-publish-btn>', '<button>暂存离开</button>']) {
    const f = nativeSaveFixture(t, markup);
    assert.equal(f.save(), "missing"); assert.deepEqual(f.calls, []);
  }
  for (const rect of [{ width: 0, height: 40 }, { width: 100, height: 0 }]) {
    const f = nativeSaveFixture(t);
    f.hosts[0].getBoundingClientRect = () => rect;
    assert.equal(f.save(), "missing"); assert.deepEqual(f.calls, []);
  }
});

test("native save requires explicit availability and exact draft semantics", (t) => {
  for (const value of ["true", "", "0", null]) {
    const f = nativeSaveFixture(t);
    if (value === null) f.hosts[0].removeAttribute("save-disabled"); else f.hosts[0].setAttribute("save-disabled", value);
    assert.equal(f.save(), "disabled"); assert.deepEqual(f.calls, []);
  }
  for (const [attribute, value] of [["is-save-draft", "false"], ["is-save-draft", null], ["save-text", "发布"], ["save-text", null]]) {
    const f = nativeSaveFixture(t);
    if (value === null) f.hosts[0].removeAttribute(attribute); else f.hosts[0].setAttribute(attribute, value);
    assert.equal(f.save(), "unsupported"); assert.deepEqual(f.calls, []);
  }
  for (const handler of [null, undefined, "save"]) {
    const f = nativeSaveFixture(t);
    f.hosts[0]._onSave = handler;
    assert.equal(f.save(), "unsupported"); assert.deepEqual(f.calls, []);
  }
});

test("a native draft handler exception never calls publish or a replacement handler", (t) => {
  const f = nativeSaveFixture(t);
  let attempts = 0;
  f.hosts[0]._onSave = () => { attempts++; throw new Error("native save interrupted"); };
  f.hosts[0]._onSaveDraft = () => assert.fail("must not guess a replacement handler");
  f.hosts[0]._onDraft = () => assert.fail("must not guess a replacement handler");
  assert.throws(f.save, /native save interrupted/);
  assert.equal(attempts, 1); assert.deepEqual(f.calls, []);
});

async function browserFixture(t, { saveError = false, nativeSaveResult = "invoked", reverseReadback = false, reverseUpload = false, fingerprintResult, uploadDelay = false,
  initialDrafts = [], imageDraftCount, otherDraftCount = 4, autoOpenDrawer = true, onSave, onEdit, onDraftRead,
  accountError, accountCloseError = false, focusError = false, accountRedirect, loginRedirect, loginVisible = true,
  onNavigate, onAccountNavigate, onAccountRead, timeoutMs = 300 } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-driver-"));
  const calls = [];
  let currentAccount = { identifier: "test_account_123", name: "测试账号" };
  let url = "about:blank", state = { title: "", body: "", images: [], drafts: structuredClone(initialDrafts), blocked: false }, stored;
  let drawerOpen = false, pendingImages = [], fingerprintReads = 0, draftReads = 0;
  const control = { setState: (value) => { state = { ...state, ...value }; }, setAccount: (value) => { currentAccount = value; }, setDrawerOpen: (value) => { drawerOpen = value; } };
  const makeLocator = (kind, id, filters = {}) => ({
    filter(options) { return makeLocator(kind, id, { ...filters, ...options }); },
    locator(selector) { assert.equal(kind, "card"); assert.equal(selector, ".btn"); return makeLocator("edit", id); },
    async count() {
      if (kind === "tab") return drawerOpen ? 1 : 0;
      if (kind === "card" || kind === "edit") return drawerOpen ? state.drafts.filter((draft) => draft.id === id).length : 0;
      return 1;
    },
    async isEnabled() { return true; },
    async innerText() {
      if (kind === "tab") {
        await onDraftRead?.({ readCount: ++draftReads, ...control });
        const count = imageDraftCount ?? state.drafts.length;
        calls.push(["draft-count", count]); return `图文笔记（${count}）`;
      }
      assert.equal(kind, "drafts"); return `草稿箱(${state.drafts.length + otherDraftCount})`;
    },
    async fill(value) { calls.push(["fill", kind, value]); state[kind] = value; },
    async setInputFiles(path) {
      calls.push(["file", path]);
      const previous = structuredClone(state.images), index = state.images.length;
      state.images.push({ key: imageKey(index + 1), loaded: true, ready: true, processing: false, failed: false });
      if (index === 1 && reverseUpload) state.images.reverse();
      if (uploadDelay) {
        const pending = structuredClone(state.images);
        pending[index] = { ...pending[index], loaded: false, ready: false, processing: true };
        const decoded = structuredClone(state.images);
        decoded[index] = { ...decoded[index], ready: false, processing: false };
        pendingImages = [previous, pending, decoded, structuredClone(state.images)];
      }
    },
    async click() {
      if (kind === "drafts") { calls.push(["drafts-click"]); drawerOpen = true; return; }
      if (kind === "tab") { calls.push(["tab-click"]); assert.equal(drawerOpen, true); return; }
      if (kind === "edit") {
        assert.equal(filters.hasText?.source, "^编辑$");
        calls.push(["edit", id]); assert.equal(id, "one"); drawerOpen = false;
        state = { ...state, title: stored.title, body: stored.body, images: structuredClone(reverseReadback ? stored.images.toReversed() : stored.images) };
        await onEdit?.(control); return;
      }
      assert.fail(`unexpected locator click: ${kind}`);
    },
  });
  const page = {
    url: () => url, isClosed: () => false, async bringToFront() { if (focusError) throw new Error("private browser focus error"); },
    async goto(target, options) {
      calls.push(["goto", target, options]); url = target.endsWith("/login") ? loginRedirect ?? target : target;
      assert.equal(new URL(target).searchParams.has("draft_id"), false, "native local drafts must not use invented navigation URLs");
      state = { ...state, title: "", body: "", images: [] }; drawerOpen = false;
      await onNavigate?.({ target, options, setUrl: (value) => { url = value; }, ...control });
    },
    async evaluate(reader) {
      if (reader === saveNativeDraft) {
        calls.push(["save-evaluate"]);
        if (nativeSaveResult !== "invoked") return nativeSaveResult;
        calls.push(["save"]);
        stored = structuredClone(state);
        if (saveError) throw new Error("private native save result unknown");
        state = { ...state, title: "", body: "", images: [], drafts: [...state.drafts, { id: "one", text: stored.title }] };
        drawerOpen = autoOpenDrawer;
        await onSave?.(control);
        return "invoked";
      }
      if (reader === readPageEvidence) {
        if (pendingImages.length) state.images = pendingImages.shift();
        const result = structuredClone(state);
        if (!drawerOpen) result.drafts = [];
        result.images.forEach((image) => { image.key = null; });
        calls.push(["page-read", result.images.map(({ loaded, ready, processing }) => ({ loaded, ready, processing }))]);
        return result;
      }
      if (reader === readImageFingerprints) {
        const keys = state.images.map((image) => image.key);
        const value = fingerprintResult ? await fingerprintResult({ keys, readCount: ++fingerprintReads, ...control }) : keys;
        calls.push(["fingerprints", value]); return structuredClone(value);
      }
      if (reader === readLoginEvidence) { calls.push(["login-read"]); return { loginVisible }; }
      assert.equal(reader, readAccountEvidence);
      calls.push(["visible-account-read"]);
      return structuredClone(currentAccount);
    },
    getByText(pattern) {
      calls.push(["drafts-find", pattern.source]);
      const current = new URL(url);
      assert.equal(current.pathname, "/publish/publish", "the draft list is only available after entering the editor");
      assert.equal(current.searchParams.get("target"), "image");
      if (pattern.test("图文笔记（0）")) return makeLocator("tab");
      assert.ok(pattern.test("草稿箱(0)")); return makeLocator("drafts");
    },
    locator(selector) {
      if (selector === SELECTORS.input) return makeLocator("input");
      if (selector === SELECTORS.title) return makeLocator("title");
      if (selector === SELECTORS.body) return makeLocator("body");
      const match = /^\.draft-item\[data-draft-type="image"\]\[data-draft-id="([A-Za-z0-9_-]+)"\]$/.exec(selector);
      if (match) { calls.push(["card", match[1]]); return makeLocator("card", match[1]); }
      assert.fail(`unexpected locator: ${selector}`);
    },
  };
  const context = {
    setDefaultTimeout() {}, on() {}, pages: () => [page],
    async newPage() {
      calls.push(["account-open"]);
      let accountUrl = "about:blank", closed = false, readCount = 0;
      const accountControl = { setUrl: (value) => { accountUrl = value; }, close: () => { closed = true; } };
      return {
        url: () => accountUrl, isClosed: () => closed,
        async goto(target, options) {
          calls.push(["account-goto", target]);
          if (accountError === "goto") throw new Error("private browser error");
          accountUrl = accountRedirect ?? target;
          await onAccountNavigate?.(options, accountControl);
        },
        async evaluate(reader) {
          assert.ok(reader === readAccountEvidence || reader === readLoginEvidence);
          calls.push([reader === readLoginEvidence ? "account-login-read" : "account-read"]);
          const result = await onAccountRead?.({ reader, readCount: ++readCount, ...accountControl });
          if (result !== undefined) return result;
          if (accountError === "read") throw new Error("private browser error");
          return reader === readLoginEvidence ? { loginVisible } : structuredClone(currentAccount);
        },
        async close() { calls.push(["account-close"]); closed = true; if (accountCloseError) throw new Error("private browser close error"); },
      };
    },
    async close() { calls.push(["close"]); },
  };
  const chromium = { async launchPersistentContext(path, options) { calls.push(["launch", path, options]); return context; } };
  const driver = createXhsBrowserDriver({ profileDir, chromium, timeoutMs });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  return { driver, calls, profileDir, setAccount: control.setAccount, editor: () => structuredClone(state),
    pageUrl: () => url, setPageUrl: (value) => { url = value; }, setEditor: control.setState };
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

test("login retries navigate explicitly after a timeout has already changed the address to the editor", async (t) => {
  let navigations = 0;
  const f = await browserFixture(t, { timeoutMs: 60_000, onNavigate: ({ target, options, setUrl }) => {
    navigations++;
    assert.equal(target, "https://creator.xiaohongshu.com/login");
    assert.deepEqual(options, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (navigations === 1) {
      setUrl("https://creator.xiaohongshu.com/publish/publish?target=image");
      throw new Error("private browser navigation error");
    }
  } });
  const failed = await f.driver.openLogin();
  assert.equal(failed.status, "needs_attention");
  assert.match(failed.message, /登录页未正常加载/); assert.doesNotMatch(failed.message, /private/);
  assert.equal(navigations, 1, "failed navigation must not retry in the background");
  assert.match(f.pageUrl(), /\/publish\/publish/);
  assert.equal((await f.driver.openLogin()).status, "login_required");
  assert.equal(f.pageUrl(), "https://creator.xiaohongshu.com/login");
  assert.equal(f.calls.filter(([kind]) => kind === "launch").length, 1); assert.equal(navigations, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open" || kind === "account-close").length, 0);
});

test("a visible login page remains open without spawning or closing a temporary account page", async (t) => {
  const f = await browserFixture(t);
  const result = await f.driver.openLogin();
  assert.equal(result.status, "login_required");
  assert.equal(f.pageUrl(), "https://creator.xiaohongshu.com/login");
  assert.equal(f.calls.filter(([kind]) => kind === "goto").length, 1, "opening login must not navigate twice");
  assert.equal(f.calls.filter(([kind]) => kind === "login-read").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open" || kind === "account-close" || kind === "close").length, 0);
});

test("a blank login page, unexpected redirect or absent homepage identity never reports a usable login", async (t) => {
  for (const options of [
    { loginVisible: false },
    { loginRedirect: "https://creator.xiaohongshu.com/publish/publish?target=image" },
    { loginRedirect: "https://example.test/" },
    { loginRedirect: "https://creator.xiaohongshu.com/new/home" },
  ]) {
    const f = await browserFixture(t, { ...options, timeoutMs: 20 });
    if (options.loginRedirect?.endsWith("/new/home")) f.setAccount(null);
    const result = await f.driver.openLogin();
    assert.equal(result.status, "needs_attention"); assert.equal(result.account, undefined);
    assert.equal(f.calls.filter(([kind]) => kind === "account-open" || kind === "file" || kind === "save").length, 0);
  }
});

test("an authenticated login redirect reads the visible homepage without navigating an extra tab", async (t) => {
  const f = await browserFixture(t, { loginRedirect: "https://creator.xiaohongshu.com/new/home" });
  const result = await f.driver.openLogin();
  assert.equal(result.status, "connected"); assert.equal(result.account.name, "测试账号");
  assert.equal(f.calls.filter(([kind]) => kind === "visible-account-read").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open" || kind === "account-close").length, 0);
  assert.deepEqual((await f.driver.checkConnection()).account, result.account, "fresh checks use the same account identity");
});

test("login reopens a closed page and a closed browser with the same dedicated profile", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "zhepage-xhs-reopen-"));
  const contexts = [], launches = [], navigations = [];
  const chromium = { async launchPersistentContext(path, options) {
    launches.push({ path, options });
    const pages = [];
    let onClose;
    const context = {
      setDefaultTimeout() {}, on(event, callback) { assert.equal(event, "close"); onClose = callback; }, pages: () => pages,
      async newPage() {
        let url = "about:blank", closed = false;
        const page = {
          url: () => url, isClosed: () => closed, async bringToFront() { assert.equal(closed, false); },
          async goto(target) { assert.equal(closed, false); url = target; navigations.push(target); },
          async evaluate(reader) {
            assert.equal(closed, false);
            if (reader === readPageEvidence) return { images: [], title: "", body: "", blocked: false };
            assert.equal(reader, readLoginEvidence); return { loginVisible: true };
          },
          close() { closed = true; pages.splice(pages.indexOf(page), 1); },
        };
        pages.push(page); return page;
      },
      async close() { for (const page of [...pages]) page.close(); onClose?.(); },
    };
    contexts.push(context); await context.newPage(); return context;
  } };
  const driver = createXhsBrowserDriver({ profileDir, chromium, timeoutMs: 300 });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  assert.equal((await driver.openLogin()).status, "login_required");
  contexts[0].pages()[0].close();
  assert.equal((await driver.openLogin()).status, "login_required");
  assert.equal(launches.length, 1, "a closed tab needs a new page, not a second browser");
  await contexts[0].close();
  assert.equal((await driver.openLogin()).status, "login_required");
  assert.equal(launches.length, 2);
  assert.ok(launches.every(({ path, options }) => path === profileDir && options.chromiumSandbox === true));
  assert.deepEqual(navigations, Array(3).fill("https://creator.xiaohongshu.com/login"));
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
  assert.equal(f.calls[0][2].chromiumSandbox, true);
  for (const signal of ["handleSIGTERM", "handleSIGINT", "handleSIGHUP"]) assert.equal(f.calls[0][2][signal], false, `${signal} must leave shutdown to the service`);
  const images = [{ path: "/original/a.png" }, { path: "/original/b.jpg" }], progress = [];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images, onProgress: async (count) => progress.push(count) });
  assert.deepEqual(prepared.images, [imageKey(1), imageKey(2)]);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 3, "preparation rechecks the account before entering and before uploading");
  const saved = await f.driver.saveDraft({ prepared });
  assert.deepEqual(saved, { draftId: "one", draftRef: { kind: "local", id: "one", images: prepared.images } });
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 4, "saving rechecks the current account");
  assert.deepEqual(f.calls.filter(([kind]) => kind === "file"), [["file", "/original/a.png"], ["file", "/original/b.jpg"]]);
  assert.deepEqual(progress, [1, 2]); assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "配文", images })).verified, true);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "edit"), [["edit", "one"]]);
  assert.equal(f.calls.filter(([kind]) => kind === "drafts-click").length, 1, "saving opens the native drawer automatically");
  assert.equal(f.calls.filter(([kind]) => kind === "tab-click").length, 3);
  assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 5, "readback checks the current account after reopening the native card");
  assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 5);
  assert.equal(f.pageUrl(), EDITOR_URL);
  assert.deepEqual({ title: f.editor().title, body: f.editor().body, images: f.editor().images }, { title: "", body: "", images: [] });
  await f.driver.close();
  await f.driver.close();
  assert.equal(f.calls.filter(([kind]) => kind === "close").length, 1, "closing an already closed context must not close it again");
});

test("opening login preserves a populated editor without navigation or a temporary account tab", async (t) => {
  const f = await browserFixture(t), { account } = await f.driver.checkConnection();
  await f.driver.prepare({ jobId: "job", account, title: "用户的原标题", body: "保留用户的配文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  const original = f.editor(), start = f.calls.length, url = f.pageUrl();
  const result = await f.driver.openLogin();
  assert.equal(result.status, "needs_attention"); assert.match(result.message, /原内容已保留/);
  assert.deepEqual(f.editor(), original); assert.equal(f.pageUrl(), url);
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "goto" || kind === "account-open" || kind === "save" || kind === "file").length, 0);
});

test("an unfinished modal prevents login navigation even without editor text or images", async (t) => {
  const f = await browserFixture(t);
  f.setEditor({ blocked: true });
  assert.equal((await f.driver.openLogin()).status, "needs_attention");
  assert.equal(f.editor().blocked, true);
  assert.equal(f.calls.filter(([kind]) => kind === "goto").length, 0);
});

test("entering the editor from login or home stops when XHS restores existing work", async (t) => {
  for (const loginRedirect of [undefined, "https://creator.xiaohongshu.com/new/home"]) {
    for (const content of [
      { title: "平台恢复的原标题" }, { body: "平台恢复的原配文" },
      { images: [{ key: "https://cdn.example/original", loaded: true, ready: true, processing: false, failed: false }] },
      { blocked: true },
    ]) {
      const restored = { title: "", body: "", images: [], drafts: [], blocked: false, ...content };
      const f = await browserFixture(t, { loginRedirect, onNavigate: ({ target, setState }) => {
        if (new URL(target).pathname === "/publish/publish") setState(structuredClone(restored));
      } });
      const { account } = await f.driver.checkConnection(), start = f.calls.length;
      await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "新标题", body: "新配文", images: [{ path: "/new.png" }], onProgress: async () => assert.fail("restored work must stop progress") }), /编辑器恢复了已有内容/);
      const actions = f.calls.slice(start);
      assert.equal(actions.filter(([kind]) => kind === "goto").length, 1, "the recovered editor must not be navigated a second time");
      assert.equal(actions.filter(([kind]) => ["drafts-find", "drafts-click", "file", "save"].includes(kind)).length, 0);
      assert.deepEqual(f.editor(), restored, "the restored text, images or modal remain intact");
    }
  }
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

test("account checks wait through same-origin routes and loading login pages without reopening tabs", async (t) => {
  const scenarios = [
    { accountRedirect: "https://creator.xiaohongshu.com/new/initializing", onAccountNavigate(_options, { setUrl }) {
      setTimeout(() => setUrl("https://creator.xiaohongshu.com/new/home"), 0);
    } },
    { accountRedirect: "https://creator.xiaohongshu.com/login", loginVisible: false,
      onAccountRead({ reader, setUrl }) {
        if (reader === readLoginEvidence) { setUrl("https://creator.xiaohongshu.com/new/home"); return { loginVisible: false }; }
      } },
  ];
  for (const scenario of scenarios) {
    const f = await browserFixture(t, { ...scenario, timeoutMs: 1000 });
    const result = await f.driver.checkConnection();
    assert.equal(result.status, "connected");
    assert.equal(result.account.name, "测试账号");
    assert.equal(f.calls.filter(([kind]) => kind === "account-open").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "account-goto").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
});

test("account checks reread after transient execution-context replacement without retrying navigation", async (t) => {
  for (const message of ["Execution context was destroyed, most likely because of a navigation", "Cannot find context with specified id"]) {
    const f = await browserFixture(t, { timeoutMs: 1000, onAccountRead({ readCount }) {
      if (readCount === 1) throw new Error(message);
    } });
    assert.equal((await f.driver.checkConnection()).status, "connected");
    assert.equal(f.calls.filter(([kind]) => kind === "account-read").length, 2);
    assert.equal(f.calls.filter(([kind]) => kind === "account-goto").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
  const interrupted = await browserFixture(t, { onAccountNavigate() {
    throw new Error("Navigation to homepage is interrupted by another navigation");
  } });
  assert.equal((await interrupted.driver.checkConnection()).status, "connected");
  assert.equal(interrupted.calls.filter(([kind]) => kind === "account-goto").length, 1);
});

test("closing or leaving the account tab during a read cannot return its stale identity", async (t) => {
  for (const stop of [({ close }) => close(), ({ setUrl }) => setUrl("https://example.test/")]) {
    const f = await browserFixture(t, { timeoutMs: 1000, onAccountRead: stop });
    assert.equal((await f.driver.checkConnection()).status, "needs_attention");
    assert.equal(f.calls.filter(([kind]) => kind === "account-read").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "account-close").length, 1);
  }
});

test("transient read failures and late identity results never extend the shared account deadline", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const interrupted of [false, true]) {
    const f = await browserFixture(t, { timeoutMs: 60_000, onAccountRead() {
      now += 30_000;
      if (interrupted) throw new Error("Execution context was destroyed");
    } });
    assert.equal((await f.driver.checkConnection()).status, "needs_attention");
    assert.equal(f.calls.filter(([kind]) => kind === "account-read").length, 1);
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
  for (const timeoutMs of [300, 60_000]) {
    const budget = Math.min(timeoutMs, 30_000);
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
    async goto() {},
    async evaluate(reader) { assert.equal(reader, readPageEvidence); return { title: "", body: "", images: [], blocked: false }; },
  };
  let pages = [remaining, { url: () => "https://creator.xiaohongshu.com/home" }];
  const context = { setDefaultTimeout() {}, on() {}, pages: () => pages, async newPage() {
    return { async goto() {}, url: () => "https://creator.xiaohongshu.com/new/note-manager", isClosed: () => false, async close() {} };
  }, async close() {} };
  const driver = createXhsBrowserDriver({ profileDir, chromium: {
    async launchPersistentContext() { launches++; return context; },
  }, timeoutMs: 20 });
  t.after(async () => { await driver.close(); await rm(profileDir, { recursive: true, force: true }); });
  await assert.rejects(driver.checkConnection(), /多个小红书页面/);
  assert.equal(focused, 0);
  pages = [remaining];
  assert.equal((await driver.openLogin()).status, "needs_attention");
  assert.equal(focused, 1); assert.equal(launches, 1, "retry must reuse the same persistent context");
  assert.equal((await driver.checkConnection()).status, "needs_attention");
});

test("driver never retries an ambiguous native save invocation", async (t) => {
  const f = await browserFixture(t, { saveError: true }), { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  await assert.rejects(f.driver.saveDraft({ prepared }), /private native save result unknown/);
  await assert.rejects(f.driver.saveDraft({ prepared }), /不能重复/);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
});

test("driver stops once when native save is unavailable or unsupported", async (t) => {
  for (const nativeSaveResult of ["missing", "disabled", "unsupported", undefined, "unexpected"]) {
    const f = await browserFixture(t, { nativeSaveResult: nativeSaveResult ?? null });
    const { account } = await f.driver.checkConnection();
    const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "配文", images: [{ path: "/a.png" }], onProgress: async () => {} });
    await assert.rejects(f.driver.saveDraft({ prepared }), (error) => {
      assert.ok(error instanceof XhsDriverError);
      assert.match(error.message, nativeSaveResult === "disabled" ? /暂存草稿按钮尚不可用/ : /未找到唯一可用的暂存草稿按钮/);
      return true;
    });
    await assert.rejects(f.driver.saveDraft({ prepared }), /不能重复/);
    assert.equal(f.calls.filter(([kind]) => kind === "save-evaluate").length, 1);
    assert.equal(f.calls.filter(([kind]) => kind === "save").length, 0);
    assert.equal(f.editor().title, "标题"); assert.equal(f.editor().images.length, 1);
  }
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

test("a failed pixel fingerprint cannot be upgraded by a later successful fingerprint", async (t) => {
  const f = await browserFixture(t, { fingerprintResult: ({ keys, readCount }) => readCount === 1 ? [null] : keys });
  const { account } = await f.driver.checkConnection();
  await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }, { path: "/b.png" }], onProgress: async () => assert.fail("unproven images must stop before progress") }), /图片内容暂时无法核对/);
  assert.equal(f.calls.filter(([kind]) => kind === "fingerprints").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "file").length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "save" || kind === "fill").length, 0);
});

test("upload waits for a missing image to appear, decode and become ready before recording progress", async (t) => {
  const f = await browserFixture(t, { uploadDelay: true, timeoutMs: 1500 });
  const { account } = await f.driver.checkConnection(), progress = [];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async (count) => {
    assert.equal(f.editor().images[0].ready, true); progress.push(count);
  } });
  const reads = f.calls.slice(f.calls.findIndex(([kind]) => kind === "file") + 1).filter(([kind]) => kind === "page-read");
  assert.deepEqual(reads.slice(0, 4).map(([, images]) => images), [
    [], [{ loaded: false, ready: false, processing: true }],
    [{ loaded: true, ready: false, processing: false }], [{ loaded: true, ready: true, processing: false }],
  ]);
  assert.deepEqual(prepared.images, [imageKey(1)]); assert.deepEqual(progress, [1]);
});

test("draft discovery uses the image tab count and a new native ID even when an old title matches", async (t) => {
  const f = await browserFixture(t, { initialDrafts: [{ id: "old", text: "标题" }], otherDraftCount: 7 });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  assert.deepEqual(prepared.beforeIds, ["old"]);
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal(saved.draftId, "one"); assert.equal(saved.draftRef.url, undefined);
  assert.equal(f.calls.filter(([kind]) => kind === "drafts-click").length, 1);
});

test("draft discovery tolerates display-only title trimming while readback keeps exact body spacing", async (t) => {
  const f = await browserFixture(t, {
    onSave: ({ setState }) => setState({ drafts: [{ id: "one", text: "测试" }] }),
  });
  const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const title = " 测试 ", body = " 正文\n\n";
  const prepared = await f.driver.prepare({ jobId: "job", account, title, body, images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal(saved.draftId, "one");
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title, body, images })).verified, true);
  const altered = { title, body: body.trim(), blocked: false,
    images: [{ key: imageKey(1), loaded: true, processing: false, failed: false }] };
  assert.equal(compareDraftEvidence(altered, { title, body, draftRef: saved.draftRef }), false);
});

test("saving waits for the native drawer to open without clicking through its overlay", async (t) => {
  const f = await browserFixture(t, { autoOpenDrawer: false, timeoutMs: 1000,
    onSave: ({ setDrawerOpen }) => { setTimeout(() => setDrawerOpen(true), 20); },
  });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  const start = f.calls.length;
  assert.equal((await f.driver.saveDraft({ prepared })).draftId, "one");
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "drafts-click").length, 0);
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "save").length, 1);
});

test("a missing post-save drawer stops without clicking the entry or saving again", async (t) => {
  const f = await browserFixture(t, { autoOpenDrawer: false, timeoutMs: 20 });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  const start = f.calls.length;
  await assert.rejects(f.driver.saveDraft({ prepared }), /图文草稿列表尚未加载/);
  await assert.rejects(f.driver.saveDraft({ prepared }), /不能重复/);
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "drafts-click").length, 0);
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "save").length, 1);
});

test("incomplete image draft counts and duplicate native IDs stop before uploading", async (t) => {
  for (const options of [
    { initialDrafts: [{ id: "same", text: "一" }, { id: "same", text: "二" }] },
    { initialDrafts: [{ id: "one", text: "一" }], imageDraftCount: 2 },
    { initialDrafts: [{ id: "one", text: "一" }], imageDraftCount: 0 },
  ]) {
    const f = await browserFixture(t, { ...options, timeoutMs: 20 }), { account } = await f.driver.checkConnection();
    await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} }), /草稿箱条目尚未完整读取/);
    assert.equal(f.calls.filter(([kind]) => kind === "file" || kind === "save").length, 0);
  }
});

test("two new same-title drafts cannot be guessed or trigger another native save", async (t) => {
  const f = await browserFixture(t, { onSave: ({ setState }) => setState({ drafts: [{ id: "one", text: "标题" }, { id: "two", text: "标题" }] }) });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  await assert.rejects(f.driver.saveDraft({ prepared }), /草稿箱条目尚未完整读取/);
  await assert.rejects(f.driver.saveDraft({ prepared }), /不能重复/);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
});

test("readback cannot substitute a same-title card with a different native ID", async (t) => {
  const f = await browserFixture(t), { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  f.setEditor({ drafts: [{ id: "replacement", text: "标题" }] });
  const result = await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images });
  assert.equal(result.verified, false); assert.match(result.message, /未找到原草稿/);
  assert.equal(f.calls.filter(([kind]) => kind === "edit").length, 0);
});

test("a changed account after reopening a draft prevents successful verification and preserves the editor", async (t) => {
  const f = await browserFixture(t, { onEdit: ({ setAccount }) => setAccount({ identifier: "another_account", name: "另一账号" }) });
  const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared }), start = f.calls.length;
  await assert.rejects(f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images }), /账号尚未确认或发生变化/);
  assert.equal(f.editor().title, "标题");
  assert.equal(f.calls.slice(start).filter(([kind]) => kind === "goto").length, 0);
  assert.deepEqual(f.calls.slice(start).filter(([kind]) => ["edit", "account-open", "account-close"].includes(kind)).map(([kind]) => kind), ["edit", "account-open", "account-close"]);
});

test("unavailable or changed pixel evidence on readback cannot confirm a draft or navigate away", async (t) => {
  for (const result of [null, [], [null], [imageKey(2)]]) {
    let reopened = false;
    const f = await browserFixture(t, { onEdit: () => { reopened = true; }, fingerprintResult: ({ keys }) => reopened ? result : keys });
    const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
    const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
    const saved = await f.driver.saveDraft({ prepared }), start = f.calls.length;
    assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images })).verified, false);
    assert.equal(f.calls.slice(start).filter(([kind]) => kind === "goto").length, 0);
    assert.equal(f.editor().title, "标题");
  }
});

test("saving waits for the new native ID when the image drawer initially reports zero drafts", async (t) => {
  const f = await browserFixture(t, { timeoutMs: 1000,
    onSave: ({ setState }) => setState({ drafts: [] }),
    onDraftRead: ({ readCount, setState }) => { if (readCount === 3) setState({ drafts: [{ id: "one", text: "标题" }] }); },
  });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal(saved.draftId, "one");
  assert.deepEqual(f.calls.filter(([kind]) => kind === "draft-count").map(([, count]) => count), [0, 0, 1]);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
});

test("text changes during asynchronous pixel hashing cannot authorize a stale save", async (t) => {
  let changeDuringHash = false;
  const f = await browserFixture(t, { fingerprintResult: ({ keys, setState }) => {
    if (changeDuringHash) { changeDuringHash = false; setState({ body: "用户在核对期间改过正文" }); }
    return keys;
  } });
  const { account } = await f.driver.checkConnection();
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} });
  changeDuringHash = true;
  await assert.rejects(f.driver.saveDraft({ prepared }), /保存前内容发生变化|处理结果尚未确认/);
  assert.equal(f.calls.filter(([kind]) => kind === "save").length, 0);
  assert.equal(f.editor().body, "用户在核对期间改过正文");
});

test("readback waits for restored text and pixel evidence to agree in the same stable read", async (t) => {
  let restoreDuringHash = false;
  const f = await browserFixture(t, { timeoutMs: 1500,
    onEdit: ({ setState }) => { setState({ body: "" }); restoreDuringHash = true; },
    fingerprintResult: ({ keys, setState }) => {
      if (restoreDuringHash) { restoreDuringHash = false; setState({ body: "正文" }); }
      return keys;
    },
  });
  const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images })).verified, true);
  assert.equal(f.editor().body, "");
});

test("readback from another empty creator page returns through the bounded editor entry", async (t) => {
  const f = await browserFixture(t), { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  f.setPageUrl("https://creator.xiaohongshu.com/new/home");
  const start = f.calls.length;
  assert.equal((await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images })).verified, true);
  const navigations = f.calls.slice(start).filter(([kind]) => kind === "goto");
  assert.equal(navigations.length, 2);
  assert.ok(navigations.every(([, target, options]) => target === EDITOR_URL && options.waitUntil === "domcontentloaded" && options.timeout === 300));
  assert.equal(f.pageUrl(), EDITOR_URL); assert.equal(f.editor().images.length, 0);
});

test("editor navigation errors are bounded and do not leak platform errors or upload files", async (t) => {
  const f = await browserFixture(t, { timeoutMs: 60_000, onNavigate: ({ target, options }) => {
    if (target !== EDITOR_URL) return;
    assert.deepEqual(options, { waitUntil: "domcontentloaded", timeout: 30_000 });
    throw new Error("private platform URL and browser error");
  } });
  const { account } = await f.driver.checkConnection();
  await assert.rejects(f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images: [{ path: "/a.png" }], onProgress: async () => {} }), (error) => {
    assert.ok(error instanceof XhsDriverError); assert.doesNotMatch(error.message, /private|platform URL/); return true;
  });
  assert.equal(f.calls.filter(([kind]) => kind === "file" || kind === "save").length, 0);
});


test("readback reports unavailable images only after allowing them to finish loading", async (t) => {
  for (const recovers of [false, true]) {
    const restored = [{ key: imageKey(1), loaded: true, ready: true, processing: false, failed: false }];
    const f = await browserFixture(t, { timeoutMs: 450, onEdit: ({ setState }) => {
      setState({ images: restored.map((image) => ({ ...image, loaded: false })) });
      if (recovers) setTimeout(() => setState({ images: restored }), 20);
    } });
    const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
    const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
    const saved = await f.driver.saveDraft({ prepared }), start = f.calls.length;
    const result = await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images });
    const reads = f.calls.slice(start).filter(([kind, entries]) => kind === "page-read" && entries.length === 1);
    assert.ok(reads.length >= 2, "an unloaded image must be rechecked rather than fail immediately");
    assert.equal(result.verified, recovers);
    if (recovers) {
      assert.equal(result.reason, undefined);
      assert.equal(f.editor().images.length, 0);
    } else {
      assert.equal(result.reason, "images_unavailable");
      assert.match(result.message, /草稿已保存.*图片暂时无法显示/);
      assert.equal(f.editor().images.length, 1, "the unavailable original draft remains open for inspection");
      assert.equal(f.calls.slice(start).filter(([kind]) => kind === "goto").length, 0);
    }
    assert.equal(f.calls.filter(([kind]) => kind === "save").length, 1);
  }
});

test("missing image cards remain a general mismatch rather than a confirmed image-loading issue", async (t) => {
  const f = await browserFixture(t, { timeoutMs: 20, onEdit: ({ setState }) => setState({ images: [] }) });
  const { account } = await f.driver.checkConnection(), images = [{ path: "/a.png" }];
  const prepared = await f.driver.prepare({ jobId: "job", account, title: "标题", body: "正文", images, onProgress: async () => {} });
  const saved = await f.driver.saveDraft({ prepared });
  const result = await f.driver.verifyDraft({ ...saved, account, title: "标题", body: "正文", images });
  assert.equal(result.verified, false); assert.equal(result.reason, undefined);
});
