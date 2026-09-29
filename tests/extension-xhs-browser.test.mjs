import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
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
  const session = {}, values = new Map(), calls = [], pages = new Map(); let nextId = 10, nextDocument = 1;
  const accountId = (await sha256(`xiaohongshu-account:${identifier}`)).slice(0, 20);
  const record = { id: "test-job", accountId, accountName: "测试账号", title: "测试标题", body: "测试正文", imageCount: 1,
    images: [{ blob: new Blob(["test"]), mime: "image/png", name: "one.png" }], uploadedCount: 1,
    prepared: { jobId: "test-job", title: "测试标题", images: [key], beforeIds: [] } };
  let phase = initialPhase, imageKeys = initialPhase === "editing" ? [key] : [];
  const control = { accountIdentifier, holdReload: false };
  const freshDocument = (page) => {
    page.documentId = `document-${nextDocument++}`; page.status = "complete";
    page.accountIdentifier = control.accountIdentifier; delete page.pendingUrl;
  };
  const evidence = () => ({ title: phase === "editing" ? record.title : null, body: phase === "editing" ? record.body : null,
    images: ["editing", "uploading"].includes(phase) ? imageKeys.map((_key, index) => ({ loaded: true, ready: true, failed: false, processing: false, key: null, source: `blob:image-${index}` })) : [],
    drafts: phase === "drafts" ? [{ id: "draft-one", text: record.title }] : [], blocked: false });
  const api = {
    storage: { session: { get: async (key) => ({ [key]: structuredClone(session[key]) }), set: async (items) => Object.assign(session, structuredClone(items)) } },
    tabs: {
      async create(options) { calls.push(["create", options]); const value = { id: nextId++, ...options }; freshDocument(value); pages.set(value.id, value); return value; },
      async get(id) { if (!pages.has(id)) throw Error("closed"); return pages.get(id); },
      async update(id, change) {
        calls.push(["update", id, change]); Object.assign(pages.get(id), change); freshDocument(pages.get(id));
        if (change.url?.includes("/publish/publish")) { phase = "empty"; imageKeys = []; }
        return pages.get(id);
      },
      async reload(id, options) {
        calls.push(["reload", id, options]);
        if (!pages.has(id)) throw Error("closed");
        // Chrome may report the previous complete page briefly after reload
        // resolves. Tests deliberately retain its DOM and document ID here.
        if (!control.holdReload) freshDocument(pages.get(id));
      },
      async remove(id) { calls.push(["remove", id]); pages.delete(id); },
      query() { assert.fail("Never discover or select a user's existing editor"); },
    },
    scripting: { async executeScript({ target, world, func, args }) {
      calls.push(["execute", target.tabId, world, func.name, args, target]);
      const page = pages.get(target.tabId);
      control.beforeScript?.({ target, page, func });
      if (target.documentIds && !target.documentIds.includes(page.documentId)) throw Error("No document with the requested ID");
      const documentId = page.documentId;
      let result;
      if (func.name === "readAccountEvidence") result = { identifier: page.accountIdentifier, name: "测试账号" };
      else if (["refreshAccountPage", "readAccountLocation"].includes(func.name)) {
        const url = new URL(page.url);
        const location = { origin: url.origin, pathname: url.pathname, reload: () => {
          calls.push(["reload", page.id, { source: "document", documentId }]);
          if (!control.holdReload) freshDocument(page);
        } };
        if (func.name === "refreshAccountPage") {
          assert.deepEqual(target.documentIds, [documentId], "refresh must be bound to the checked document");
          assert.equal(target.frameIds, undefined, "a refresh must not target whichever document is current later");
        }
        result = runInNewContext(`(${func.toString()})()`, { location, document: { readyState: page.status } });
      }
      else if (func.name === "readPageEvidence") result = evidence();
      else if (func.name === "readImageFingerprints") result = [...imageKeys];
      else if (func.name === "saveNativeDraft") { assert.equal(record.saveAttempted, true, "save intent must be durable before native click"); phase = "drafts"; result = saved ? "invoked" : "disabled"; }
      else if (func.name === "draftPageCommand") {
        const action = args[0].action;
        if (action === "list-state") result = { ok: true, entryCount: phase === "empty" ? 1 : 0, tabCount: phase === "drafts" ? 1 : 0, count: phase === "drafts" ? 1 : null };
        else if (action === "open-drafts") { phase = "drafts"; result = { ok: true }; }
        else if (action === "image-tab") result = { ok: true };
        else if (action === "edit-draft") { phase = "editing"; imageKeys = [key]; result = { ok: true }; }
        else if (action === "upload") {
          assert.equal(args[0].expectedCount, imageKeys.length);
          assert.equal(record.appendAttempted, imageKeys.length, "append intent must be durable before upload");
          imageKeys.push(`pixels:1x1:${String(imageKeys.length + 1).repeat(64)}`); phase = "uploading"; result = { ok: true };
        } else if (action === "fill") { assert.equal(args[0].title, record.title); assert.equal(args[0].body, record.body); phase = "editing"; result = { ok: true }; }
        else throw Error(`unexpected action ${action}`);
      } else throw Error(`unexpected function ${func.name}`);
      control.afterScript?.({ target, page, func, result, documentId });
      return [{ frameId: 0, documentId, result }];
    } },
  };
  const store = { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); } };
  // A user-created editor exists and contains work; ownership never includes it.
  for (const id of [1, 2]) { const page = { id, url: editor }; freshDocument(page); pages.set(id, page); }
  record.tab = { id: 2, owner: "our-tab" }; session[ownerKey] = { 2: "our-tab" };
  return { api, store, calls, record, session, pages, accountId, control, finishReload: (id) => freshDocument(pages.get(id)) };
}

test("login uses a new normal-profile tab and fresh homepage ID without touching existing editor", async () => {
  const f = await fakeChrome(); const driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  const state = await driver.openLogin(); assert.equal(state.status, "connected"); assert.equal(state.account.id, f.accountId);
  assert.deepEqual(f.calls[0], ["create", { url: `${origin}/new/home`, active: true }]);
  assert.equal(f.calls.some(([action, id]) => ["update", "remove", "execute"].includes(action) && id === 1), false);
});

test("repeated account checks reuse one inactive page without activating or closing tabs", async () => {
  const f = await fakeChrome(), driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  for (let index = 0; index < 11; index++) assert.equal((await driver.accountState()).account.id, f.accountId);
  const created = f.calls.filter(([action]) => action === "create");
  assert.deepEqual(created, [["create", { url: `${origin}/new/home`, active: false }]]);
  const accountTab = f.session["zhepage:xhs:account-tab"];
  assert.equal(f.calls.filter(([action, id]) => action === "reload" && id === accountTab.id).length, 10);
  assert.equal(f.calls.some(([action]) => ["remove", "update"].includes(action)), false);
  assert.equal(f.pages.get(accountTab.id).active, false);
});

test("a restarted worker reuses the session-owned account page and refreshes its identity", async () => {
  const f = await fakeChrome();
  await createXhsBrowser({ store: f.store, chromeApi: f.api }).accountState();
  const firstRef = structuredClone(f.session["zhepage:xhs:account-tab"]);
  const firstDocument = f.pages.get(firstRef.id).documentId;
  const restarted = createXhsBrowser({ store: f.store, chromeApi: f.api });
  assert.equal((await restarted.accountState()).account.id, f.accountId);
  assert.deepEqual(f.session["zhepage:xhs:account-tab"], firstRef);
  assert.notEqual(f.pages.get(firstRef.id).documentId, firstDocument);
  assert.equal(f.calls.filter(([action]) => action === "create").length, 1);
});

test("reload cannot accept the previous complete document's stale account", async () => {
  const f = await fakeChrome(); let pauses = 0, accountTab;
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api, timeoutMs: 1000, pause: async () => {
    pauses++; assert.equal(f.pages.get(accountTab.id).accountIdentifier, identifier);
    f.finishReload(accountTab.id);
  } });
  assert.equal((await driver.accountState()).account.id, f.accountId);
  accountTab = f.session["zhepage:xhs:account-tab"];
  f.control.holdReload = true; f.control.accountIdentifier = "switched-account";
  const state = await driver.accountState();
  assert.equal(pauses, 1, "old complete document must not pass during reload");
  assert.equal(state.account.id, (await sha256("xiaohongshu-account:switched-account")).slice(0, 20));
  assert.notEqual(state.account.id, f.accountId);
});

test("an account page becoming an editor immediately before refresh keeps all editing state", async () => {
  for (const navigation of ["new-document", "same-document"]) {
    const f = await fakeChrome(), driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
    await driver.accountState(); const ref = f.session["zhepage:xhs:account-tab"];
    const originalDocument = f.pages.get(ref.id).documentId; let changed = false, retained;
    f.control.beforeScript = ({ page, func }) => {
      if (func.name !== "refreshAccountPage") return;
      changed = true; page.url = editor; page.unsavedTitle = "用户正在编辑，不能刷新";
      if (navigation === "new-document") f.finishReload(page.id);
      retained = structuredClone(page);
    };
    f.calls.length = 0;
    await assert.rejects(driver.accountState(), (error) => error.name === "XhsError");
    assert.equal(changed, true, navigation);
    assert.deepEqual(f.pages.get(ref.id), retained, navigation);
    assert.equal(f.calls.some(([action, id]) => ["reload", "update", "remove"].includes(action) && id === ref.id), false, navigation);
    const attempt = f.calls.find((call) => call[3] === "refreshAccountPage");
    assert.deepEqual(attempt[5].documentIds, [originalDocument], navigation);
    assert.equal(attempt[5].frameIds, undefined);
  }
});

test("account evidence from a replaced HOME document cannot return the previous account", async () => {
  const f = await fakeChrome(); let replaced = false;
  f.control.afterScript = ({ page, func }) => {
    if (func.name !== "readAccountEvidence" || replaced) return;
    replaced = true;
    f.control.accountIdentifier = "replaced-home-account";
    f.finishReload(page.id);
  };
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api, timeoutMs: 1000, pause: async () => {} });
  const state = await driver.accountState();
  assert.equal(replaced, true);
  assert.equal(state.status, "connected");
  assert.notEqual(state.account.id, f.accountId, "same HOME URL does not make an older document's account trustworthy");
  assert.equal(state.account.id, (await sha256("xiaohongshu-account:replaced-home-account")).slice(0, 20));
});

test("an account check that never reaches a new document fails closed", async () => {
  const f = await fakeChrome(); const driver = createXhsBrowser({ store: f.store, chromeApi: f.api, timeoutMs: 20,
    pause: () => new Promise((resolve) => setTimeout(resolve, 1)) });
  await driver.accountState(); f.control.holdReload = true;
  assert.equal((await driver.accountState()).status, "needs_attention");
  assert.equal(f.calls.some(([action]) => action === "remove"), false);
});

test("closed or user-repurposed account pages are replaced without operating on the old page", async () => {
  for (const mode of ["closed", "editor", "pending-editor", "pending-external"]) {
    const f = await fakeChrome(), driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
    await driver.accountState(); const oldRef = f.session["zhepage:xhs:account-tab"];
    if (mode === "closed") f.pages.delete(oldRef.id);
    else {
      const page = f.pages.get(oldRef.id); page.active = true; page.unsavedTitle = "用户正在编辑";
      if (mode === "editor") page.url = editor;
      else page.pendingUrl = mode === "pending-editor" ? editor : "https://unrelated.example/new/home";
    }
    const oldPage = structuredClone(f.pages.get(oldRef.id)); f.calls.length = 0;
    assert.equal((await driver.accountState()).account.id, f.accountId);
    assert.notEqual(f.session["zhepage:xhs:account-tab"].id, oldRef.id);
    assert.equal(f.calls.some(([action, id]) => ["reload", "update", "remove", "execute"].includes(action) && id === oldRef.id), false, mode);
    assert.deepEqual(f.pages.get(oldRef.id), oldPage, mode);
    assert.deepEqual(f.calls.filter(([action]) => action === "create"), [["create", { url: `${origin}/new/home`, active: false }]]);
  }
});

test("six images use one background account page throughout import", async () => {
  const f = await fakeChrome({ initialPhase: "empty" });
  f.record.images = Array.from({ length: 6 }, (_item, index) => ({ blob: new Blob([`image-${index}`]), mime: "image/png", name: `image-${index}.png` }));
  f.record.imageCount = 6; f.record.uploadedCount = 0; delete f.record.prepared;
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api, pause: async () => {} });
  const prepared = await driver.prepare(f.record, async () => {});
  assert.equal(prepared.images.length, 6); assert.equal(f.record.uploadedCount, 6);
  assert.equal(f.calls.filter((call) => call[3] === "draftPageCommand" && call[4][0].action === "upload").length, 6);
  assert.deepEqual(f.calls.filter(([action]) => action === "create"), [["create", { url: `${origin}/new/home`, active: false }]]);
  assert.equal(f.calls.filter(([action]) => action === "reload").length, 6);
  assert.equal(f.calls.some(([action]) => action === "remove"), false);
  assert.equal(f.calls.some(([action, id]) => ["execute", "reload", "update", "remove"].includes(action) && id === 1), false);
});

test("account switch between images stops the batch before another upload or native save", async () => {
  const f = await fakeChrome({ initialPhase: "empty" });
  f.record.images = Array.from({ length: 6 }, (_item, index) => ({ blob: new Blob([`image-${index}`]), mime: "image/png", name: `image-${index}.png` }));
  f.record.imageCount = 6; f.record.uploadedCount = 0; delete f.record.prepared;
  const driver = createXhsBrowser({ store: f.store, chromeApi: f.api, pause: async () => {} });
  await assert.rejects(driver.prepare(f.record, async () => {
    if (f.record.uploadedCount === 1) f.control.accountIdentifier = "switched-during-upload";
  }), /账号发生变化/u);
  assert.equal(f.record.uploadedCount, 1); assert.equal(f.record.appendAttempted, 0);
  assert.equal(f.calls.filter((call) => call[3] === "draftPageCommand" && call[4][0].action === "upload").length, 1);
  assert.equal(f.calls.some((call) => call[3] === "saveNativeDraft" || (call[3] === "draftPageCommand" && call[4][0].action === "fill")), false);
  assert.equal(f.calls.filter(([action]) => action === "create").length, 1);
  assert.equal(f.calls.some(([action, id]) => ["execute", "reload", "update", "remove"].includes(action) && id === 1), false);
});

test("a fresh account change detected on reused page prevents native save", async () => {
  const f = await fakeChrome(), driver = createXhsBrowser({ store: f.store, chromeApi: f.api });
  await driver.accountState(); f.control.accountIdentifier = "changed-before-save";
  await assert.rejects(driver.save(f.record, async () => assert.fail("save intent must not be written")), /账号发生变化/u);
  assert.equal(f.calls.some((call) => call[3] === "saveNativeDraft"), false);
  assert.equal(f.calls.filter(([action]) => action === "reload").length, 1);
  assert.equal(f.calls.filter(([action]) => action === "create").length, 1);
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
