import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createXhsBrowser } from "../browser-extension/xhs-browser.mjs";
import { sha256 } from "../browser-extension/xiaohongshu.mjs";
import { draftPageCommand, saveNativeDraft, SELECTORS, readPageEvidence } from "../browser-extension/xhs-dom.mjs";

const origin = "https://creator.xiaohongshu.com";
const editor = `${origin}/publish/publish?target=image`;
const key = `pixels:1x1:${"e".repeat(64)}`;
const identifier = "native-test-account";
const ownerKey = "zhepage:xhs:owned-tabs";
async function fakeChrome({ accountIdentifier = identifier, saved = true, initialPhase = "editing" } = {}) {
  const session = {}, values = new Map(), calls = [], pages = new Map(); let nextId = 10;
  const accountId = (await sha256(`xiaohongshu-account:${identifier}`)).slice(0, 20);
  const record = { id: "test-job", accountId, accountName: "测试账号", title: "测试标题", body: "测试正文", imageCount: 1,
    images: [{ blob: new Blob(["test"]), mime: "image/png", name: "one.png" }], uploadedCount: 1,
    prepared: { jobId: "test-job", title: "测试标题", images: [key], beforeIds: [] } };
  let phase = initialPhase;
  const evidence = () => ({ title: phase === "editing" ? record.title : null, body: phase === "editing" ? record.body : null,
    images: phase === "editing" ? [{ loaded: true, ready: true, failed: false, processing: false, key: null, source: "blob:x" }] : [],
    drafts: phase === "drafts" ? [{ id: "draft-one", text: record.title }] : [], blocked: false });
  const api = {
    storage: { session: { get: async (key) => ({ [key]: structuredClone(session[key]) }), set: async (items) => Object.assign(session, structuredClone(items)) } },
    tabs: {
      async create(options) { calls.push(["create", options]); const value = { id: nextId++, url: options.url, status: "complete" }; pages.set(value.id, value); return value; },
      async get(id) { if (!pages.has(id)) throw Error("closed"); return pages.get(id); },
      async update(id, change) { calls.push(["update", id, change]); Object.assign(pages.get(id), change); if (change.url?.includes("/publish/publish")) phase = "empty"; return pages.get(id); },
      async remove(id) { calls.push(["remove", id]); pages.delete(id); },
      query() { assert.fail("Never discover or select a user's existing editor"); },
    },
    scripting: { async executeScript({ target, world, func, args }) {
      calls.push(["execute", target.tabId, world, func.name, args]);
      let result;
      if (func.name === "readAccountEvidence") result = { identifier: accountIdentifier, name: "测试账号" };
      else if (func.name === "readPageEvidence") result = evidence();
      else if (func.name === "readImageFingerprints") result = [key];
      else if (func.name === "saveNativeDraft") { assert.equal(record.saveAttempted, true, "save intent must be durable before native click"); phase = "drafts"; result = saved ? "invoked" : "disabled"; }
      else if (func.name === "draftPageCommand") {
        const action = args[0].action;
        if (action === "list-state") result = { ok: true, entryCount: phase === "empty" ? 1 : 0, tabCount: phase === "drafts" ? 1 : 0, count: phase === "drafts" ? 1 : null };
        else if (action === "open-drafts") { phase = "drafts"; result = { ok: true }; }
        else if (action === "image-tab") result = { ok: true };
        else if (action === "edit-draft") { phase = "editing"; result = { ok: true }; }
        else throw Error(`unexpected action ${action}`);
      } else throw Error(`unexpected function ${func.name}`);
      return [{ frameId: 0, result }];
    } },
  };
  const store = { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); } };
  // A user-created editor exists and contains work; ownership never includes it.
  pages.set(1, { id: 1, url: editor, status: "complete" });
  pages.set(2, { id: 2, url: editor, status: "complete" });
  record.tab = { id: 2, owner: "our-tab" }; session[ownerKey] = { 2: "our-tab" };
  return { api, store, calls, record, session, pages, accountId };
}

test("login uses a new normal-profile tab and fresh homepage ID without touching existing editor", async () => {
  const f = await fakeChrome(); const driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  const state = await driver.openLogin(); assert.equal(state.status, "connected"); assert.equal(state.account.id, f.accountId);
  assert.deepEqual(f.calls[0], ["create", { url: `${origin}/new/home`, active: true }]);
  assert.equal(f.calls.some(([action, id]) => ["update", "remove", "execute"].includes(action) && id === 1), false);
});

test("only the fixed native draft save runs in MAIN and cannot be repeated", async () => {
  const f = await fakeChrome(), driver = createXhsBrowser({ store: f.store, chromeApi: f.api }); let writes = 0;
  const saved = await driver.save(f.record, async () => { writes++; });
  assert.equal(saved.draftId, "draft-one"); assert.equal(writes, 1);
  assert.deepEqual(f.calls.filter((call) => call[0] === "execute" && call[2] === "MAIN").map((call) => call[3]), ["saveNativeDraft"]);
  await assert.rejects(driver.save(f.record, async () => {}));
  assert.equal(f.calls.filter((call) => call[3] === "saveNativeDraft").length, 1);
});

test("account switch prevents native save and preserves all existing editors", async () => {
  const f = await fakeChrome({ accountIdentifier: "another-account" }), driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  await assert.rejects(driver.save(f.record, async () => {}), /账号发生变化/u);
  assert.equal(f.calls.some((call) => call[3] === "saveNativeDraft"), false);
  assert.equal(f.calls.some((call) => call[0] === "update"), false);
});

test("reused tab ID after browser restart cannot become an owned editor", async () => {
  const f = await fakeChrome(); f.session[ownerKey] = {};
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  await assert.rejects(driver.save(f.record, async () => {}), /浏览器已重启/u);
  assert.equal(f.calls.some((call) => call[0] === "execute" && call[1] === 2), false);
  assert.equal(f.pages.has(1), true); assert.equal(f.pages.has(2), true);
});

test("known saved draft is reopened in a new owned tab after browser restart without replaying save", async () => {
  const f = await fakeChrome({ initialPhase: "empty" }); f.session[ownerKey] = {};
  f.record.draftRef = { kind: "local", id: "draft-one", images: [key] };
  f.record.saveAttempted = true;
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api }); let persistedTab;
  const result = await driver.verify(f.record, async () => { persistedTab = structuredClone(f.record.tab); });
  assert.equal(result.verified, true); assert.equal(result.draftId, "draft-one");
  assert.ok(persistedTab.id > 2); assert.equal(f.session[ownerKey][persistedTab.id], persistedTab.owner);
  assert.equal(f.calls.some(([action, id]) => ["update", "remove", "execute"].includes(action) && [1, 2].includes(id)), false);
  assert.equal(f.calls.some((call) => call[3] === "saveNativeDraft" || call[4]?.[0]?.action === "upload"), false);
});

test("interrupted save without a durable reference cannot replace tabs or repeat save after restart", async () => {
  const f = await fakeChrome({ initialPhase: "empty" }); f.session[ownerKey] = {}; f.record.saveAttempted = true;
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  await assert.rejects(driver.verify(f.record, async () => assert.fail("must not replace unknown save")), /浏览器已重启/u);
  assert.equal(f.calls.some((call) => call[0] === "create" && call[1].url.includes("/publish/publish")), false);
  assert.equal(f.calls.some((call) => call[3] === "saveNativeDraft"), false);
});

function domFixture(t, html) {
  const dom = new JSDOM(html, { url: editor, runScripts: "outside-only" }); t.after(() => dom.window.close());
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 100 });
  const run = (func, args) => dom.window.eval(`(${func.toString()})(${JSON.stringify(args)})`);
  return { window: dom.window, run: (args) => JSON.parse(JSON.stringify(run(draftPageCommand, { selectors: SELECTORS, ...args }))), evaluate: run };
}

test("native save targets exactly one enabled closed-shadow host, never a publish control", (t) => {
  const f = domFixture(t, '<xhs-publish-btn is-save-draft="true" save-text="暂存离开" save-disabled="false"></xhs-publish-btn><button>发布</button>');
  let saved = 0, published = 0; const host = f.window.document.querySelector("xhs-publish-btn");
  host._onSave = () => saved++; host._onPublish = () => published++;
  assert.equal(f.evaluate(saveNativeDraft), "invoked"); assert.equal(saved, 1); assert.equal(published, 0);
  host.setAttribute("save-disabled", "true"); assert.equal(f.evaluate(saveNativeDraft), "disabled"); assert.equal(saved, 1);
  assert.equal(f.run({ action: "publish" }).ok, false); assert.equal(published, 0);
});

test("draft controls select exact visible labels and stable IDs; ambiguous controls are refused", (t) => {
  const f = domFixture(t, '<button id="open"><span>草稿箱(1)</span></button><div class="draft-item" data-draft-type="image" data-draft-id="draft-one"><div class="btn">编辑</div></div><button id="publish">发布</button>');
  let opened = 0, edited = 0, published = 0;
  f.window.document.querySelector("#open").onclick = () => opened++;
  f.window.document.querySelector(".btn").onclick = () => edited++;
  f.window.document.querySelector("#publish").onclick = () => published++;
  assert.equal(f.run({ action: "open-drafts" }).ok, true); assert.equal(opened, 1);
  assert.equal(f.run({ action: "edit-draft", draftId: "draft-one" }).ok, true); assert.equal(edited, 1);
  assert.equal(f.run({ action: "edit-draft", draftId: 'draft-one"] button' }).ok, false);
  f.window.document.body.insertAdjacentHTML("beforeend", "<button>草稿箱(2)</button>");
  assert.equal(f.run({ action: "open-drafts" }).ok, false); assert.equal(opened, 1); assert.equal(published, 0);
});

test("title uses native input events and body uses editing commands rather than DOM replacement", (t) => {
  const f = domFixture(t, '<input placeholder="填写标题"><div class="tiptap ProseMirror" contenteditable="true"><p><br></p></div>');
  let changes = 0; const commands = [];
  f.window.document.querySelector("input").addEventListener("input", () => changes++);
  f.window.document.execCommand = (...args) => { commands.push(args); return true; };
  assert.equal(f.run({ action: "fill", title: "标题", body: "首行\n下一行" }).ok, true);
  assert.equal(f.window.document.querySelector("input").value, "标题"); assert.equal(changes, 1);
  assert.deepEqual(commands, [["insertText", false, "首行\n下一行"]]);
  assert.equal(f.window.document.querySelector(".tiptap").innerHTML, "<p><br></p>");
  assert.equal(f.run({ action: "fill", title: "不得覆盖", body: "不得覆盖" }).ok, false);
  assert.equal(f.window.document.querySelector("input").value, "标题"); assert.equal(commands.length, 1);
});

test("readback distinguishes blank lines and cannot verify URL-only image identity", (t) => {
  const f = domFixture(t, '<input placeholder="标题" value="标题"><div class="tiptap ProseMirror" contenteditable="true"><p>一</p><p><br class="ProseMirror-trailingBreak"></p><p>三</p></div>');
  const evidence = f.evaluate(readPageEvidence, { selectors: SELECTORS });
  assert.equal(evidence.body, "一\n\n三");
  f.window.document.querySelector("br").removeAttribute("class");
  assert.equal(f.evaluate(readPageEvidence, { selectors: SELECTORS }).body, "一\n\n三");
});
