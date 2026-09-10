import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { JSDOM } from "jsdom";
import { loginXiaohongshu, saveXiaohongshuDraft } from "../cloud/providers/xiaohongshu.mjs";

const ORIGIN = "https://creator.xiaohongshu.com";
const account = { remoteId: "creator-123", displayName: "测试账号" };
const payload = { success: true, code: 0, data: { userId: account.remoteId, userName: "测试账号", phone: "private-phone" } };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2fZkAAAAASUVORK5CYII=", "base64");
const makeDraft = () => ({ title: "测试标题", body: "第一段\n第二段", images: [1, 2].map((index) => ({ name: `${index}.png`, mime: "image/png", bytes: Buffer.from(png), width: 1, height: 1 })) });

// Run the adapter's actual browser callbacks against DOM fixtures. These tests
// never launch a browser, contact Xiaohongshu, or use a real account/profile.
function fixture(options = {}) {
  class Page extends EventEmitter {
    constructor() {
      super();
      this.uploads = [];
      this.fills = [];
      this.visits = [];
      this.identityReads = 0;
      this.saveCalls = 0;
      this.closed = false;
    }
    async goto(url) {
      this.visits.push(url);
      this.dom?.window.close();
      this.dom = new JSDOM(url.includes("/publish/") ? `
        <input type="file" accept="image/png,image/jpeg" style="display:none">
        <div class="img-preview-area"></div>
        ${options.existing || ""}
        ${options.button === "legacy" ? '<button id="save">暂存离开</button>' : '<xhs-publish-btn save-text="暂存离开"></xhs-publish-btn>'}
        <button id="publish">发布</button>
      ` : "<main>创作中心</main>", { url, runScripts: "outside-only" });
      const window = this.dom.window;
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        const hidden = this.hidden || this.style.display === "none" || this.closest("[hidden]");
        return { width: hidden ? 0 : 100, height: hidden ? 0 : 30, x: 0, y: 0, top: 0, bottom: 30, left: 0, right: 100 };
      };
      window.AbortSignal = AbortSignal;
      window.fetch = async (path, init) => {
        assert.equal(path, "/api/galaxy/user/info");
        assert.equal(init.credentials, "include");
        assert.equal(init.redirect, "error");
        assert.ok(init.signal instanceof AbortSignal);
        this.identityReads += 1;
        options.onIdentity?.(this, this.identityReads);
        const data = options.identity ? options.identity(this.identityReads) : payload;
        return Response.json(data);
      };
      const save = () => {
        this.saveCalls += 1;
        if (options.throwOnSave) throw new Error("private-token server exception");
        if (options.pendingSave) return new Promise(() => {});
        const toast = window.document.createElement("div");
        toast.textContent = "保存成功";
        window.document.body.append(toast);
        if (options.navigateOnSave) window.history.replaceState(null, "", "/new/note-manager?private=token");
      };
      const host = window.document.querySelector("xhs-publish-btn");
      if (host) {
        host._onSave = save;
        host._onSaveDraft = () => assert.fail("A second draft method must never run");
        host._onPublish = () => assert.fail("Publishing is forbidden");
        if (options.disabledSave) host.setAttribute("save-disabled", "true");
        if (options.ambiguousSave) window.document.body.append(host.cloneNode());
      }
      window.document.querySelector("#save")?.addEventListener("click", save);
      window.document.querySelector("#publish")?.addEventListener("click", () => assert.fail("Publishing is forbidden"));
      options.onGoto?.(this, url);
    }
    async bringToFront() { this.focused = true; }
    url() { return this.dom.window.location.href; }
    async evaluate(callback, argument) {
      if (options.initialIdentityNavigation && argument?.path && this.identityReads === 0) {
        this.identityReads += 1;
        setTimeout(() => this.emit("response", { url: () => `${ORIGIN}/api/galaxy/user/info`, ok: () => true, json: async () => payload }), 0);
        throw new Error("Execution context was destroyed by navigation");
      }
      return structuredClone(await this.dom.window.eval(`(${callback.toString()})`)(argument));
    }
    async waitForFunction(callback, argument) {
      if (!await this.evaluate(callback, argument)) throw new Error("Fixture did not reach expected state");
      return { dispose() {} };
    }
    locator(selector, selectedIndex) {
      const element = () => {
        const matches = [...this.dom.window.document.querySelectorAll(selector)];
        if (selectedIndex === undefined) assert.equal(matches.length, 1, `Expected an unambiguous locator: ${selector}`);
        const selected = matches[selectedIndex || 0];
        assert.ok(selected, `Missing locator: ${selector}`);
        return selected;
      };
      return {
        nth: (index) => this.locator(selector, index),
        fill: async (text) => {
          const target = element();
          this.fills.push({ selector, text });
          const actual = options.transformText ? options.transformText(text, target) : text;
          if ("value" in target) target.value = actual;
          else target.textContent = actual;
          options.onFill?.(this, target);
        },
        async blur() { element(); },
        setInputFiles: async (file) => {
          element();
          this.uploads.push({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.buffer) });
          options.onUpload?.(this, file);
          if (options.failUpload === this.uploads.length) throw new Error("private-token upload failed");
          if (options.partialUpload !== this.uploads.length) {
            const preview = this.dom.window.document.createElement("div");
            preview.className = "pr";
            this.dom.window.document.querySelector(".img-preview-area").append(preview);
          }
          if (!this.dom.window.document.querySelector('input[placeholder="填写标题"]')) {
            this.dom.window.document.body.insertAdjacentHTML("beforeend", '<input placeholder="填写标题"><div contenteditable="true" class="editor"></div>');
          }
        },
      };
    }
    async close() { this.closed = true; this.dom.window.close(); }
  }
  const page = new Page();
  const untouchedTab = { url: "https://unrelated.invalid/existing-draft", content: "User content", closed: false };
  const context = {
    newPageCalls: 0,
    async newPage() { this.newPageCalls += 1; return page; },
    pages() { return [untouchedTab, page]; },
  };
  return { page, context, untouchedTab };
}

test("creator login returns only the identity of the creator session", async () => {
  const f = fixture();
  const verified = await loginXiaohongshu({ context: f.context });
  assert.deepEqual(verified, account);
  assert.equal(f.page.focused, true);
  assert.equal(f.page.listenerCount("response"), 0);
  assert.equal(f.page.closed, false);
  assert.ok(!JSON.stringify(verified).includes("private-phone"));
  assert.deepEqual(f.page.visits, [`${ORIGIN}/new/home`]);
});

test("login waits for an observed creator login response, ignoring the www profile", async () => {
  const f = fixture({ identity: () => null, onGoto(page) {
    setTimeout(() => {
      page.emit("response", { url: () => "https://www.xiaohongshu.com/api/galaxy/user/info", ok: () => true, json: async () => ({ data: { userId: "wrong-user", userName: "其他用户" } }) });
      page.emit("response", { url: () => `${ORIGIN}/api/galaxy/user/info`, ok: () => true, json: async () => payload });
    }, 0);
  } });
  assert.deepEqual(await loginXiaohongshu({ context: f.context }), account);
  assert.equal(f.page.listenerCount("response"), 0);
});

test("a login navigation does not discard the authenticated creator response", async () => {
  const f = fixture({ initialIdentityNavigation: true });
  assert.deepEqual(await loginXiaohongshu({ context: f.context }), account);
  assert.equal(f.page.listenerCount("response"), 0);
});

test("local images retain order and content; even a success toast and navigation need confirmation", async () => {
  const f = fixture({ navigateOnSave: true });
  const draft = makeDraft();
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft });
  assert.equal(receipt.status, "needs_confirmation");
  assert.match(receipt.message, /已触发/);
  assert.equal(receipt.draftId, undefined);
  assert.equal(receipt.url, `${ORIGIN}/new/note-manager`);
  assert.equal(f.page.saveCalls, 1);
  assert.deepEqual(f.page.uploads.map((file) => file.name), ["1.png", "2.png"]);
  for (const file of f.page.uploads) { assert.deepEqual(file.buffer, png); assert.equal(file.mimeType, "image/png"); }
  assert.deepEqual(f.page.fills.map(({ text }) => text), [draft.title, draft.body]);
  assert.equal(f.context.newPageCalls, 1);
  assert.equal(f.page.closed, false);
  assert.deepEqual(f.untouchedTab, { url: "https://unrelated.invalid/existing-draft", content: "User content", closed: false });
});

test("missing creator identity, another profile, and expired login cannot upload", async (t) => {
  for (const identity of [
    null, { success: false, data: payload.data }, { code: -1, data: payload.data },
    { data: { name: "显示姓名但没有当前账号 ID" } },
    { data: { userId: "another-account", userName: "另一个账号" } },
  ]) {
    await t.test(JSON.stringify(identity), async () => {
      const f = fixture({ identity: () => identity });
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
      assert.equal(receipt.status, "failed");
      assert.equal(f.page.uploads.length, 0);
      assert.equal(f.page.fills.length, 0);
      assert.equal(f.page.saveCalls, 0);
    });
  }
});

test("existing drafts, restore dialogs, and delayed restored content remain untouched", async (t) => {
  for (const [name, options] of [
    ["title", { existing: '<input placeholder="填写标题" value="已有草稿">' }],
    ["body", { existing: '<div contenteditable="true" class="editor">已有正文</div>' }],
    ["dialog", { existing: '<div role="dialog">继续编辑原有草稿？</div>' }],
    ["draft URL", { onGoto(page, url) { if (url.includes("/publish/")) page.dom.window.history.replaceState(null, "", "?draft_id=existing"); } }],
    ["delayed content", { onIdentity(page, number) { if (number === 2) page.dom.window.document.body.insertAdjacentHTML("beforeend", '<input placeholder="填写标题" value="刚恢复的草稿">'); } }],
  ]) {
    await t.test(name, async () => {
      const f = fixture(options);
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
      assert.equal(receipt.status, "needs_confirmation");
      assert.equal(f.page.uploads.length, 0);
      assert.equal(f.page.fills.length, 0);
      assert.equal(f.page.saveCalls, 0);
      assert.equal(f.page.closed, false);
    });
  }
});

test("account changes before upload, during upload, or before save stop further mutations", async (t) => {
  // Reads: initial identity, image 1, image 2, before fill, before save.
  for (const [changeAt, uploads, fills, status] of [[2, 0, 0, "failed"], [3, 1, 0, "needs_confirmation"], [4, 2, 0, "needs_confirmation"], [5, 2, 2, "needs_confirmation"]]) {
    await t.test(`change at identity read ${changeAt}`, async () => {
      const f = fixture({ identity: (number) => number >= changeAt ? { data: { userId: "switched-user", userName: "新账号" } } : payload });
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
      assert.equal(receipt.status, status);
      assert.equal(f.page.uploads.length, uploads);
      assert.equal(f.page.fills.length, fills);
      assert.equal(f.page.saveCalls, 0);
    });
  }
});

test("partial uploads, upload errors, ambiguous save controls, and disabled controls cannot save", async (t) => {
  for (const [name, options] of [
    ["partial upload", { partialUpload: 2 }], ["upload failure", { failUpload: 1 }],
    ["ambiguous save", { ambiguousSave: true }], ["disabled save", { disabledSave: true }],
  ]) {
    await t.test(name, async () => {
      const f = fixture(options);
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
      assert.equal(receipt.status, "needs_confirmation");
      assert.equal(f.page.saveCalls, 0);
      assert.ok(!JSON.stringify(receipt).includes("private-token"));
    });
  }
});

test("an exception during saving never falls through to another save method or a second attempt", async () => {
  const f = fixture({ throwOnSave: true });
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(f.page.saveCalls, 1);
  assert.ok(!JSON.stringify(receipt).includes("private-token"));
});

test("a platform save promise that never settles cannot keep the local job active", { timeout: 1000 }, async () => {
  const f = fixture({ pendingSave: true });
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(f.page.saveCalls, 1);
});

test("a content change during final account verification stops the save", async () => {
  const f = fixture({ onIdentity(page, number) {
    if (number === 5) page.dom.window.document.querySelector('[contenteditable="true"]').textContent = "用户在此时改动的正文";
  } });
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(f.page.saveCalls, 0);
  assert.match(receipt.message, /暂存前页面内容发生变化/);
});

test("exact legacy save control is supported without ever clicking the publish button", async () => {
  const f = fixture({ button: "legacy" });
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(f.page.saveCalls, 1);
});

test("content truncation and a concurrent edit stop the save", async (t) => {
  for (const [name, options] of [
    ["truncated body", { transformText: (text, element) => element.hasAttribute("contenteditable") ? text.slice(0, -1) : text }],
    ["concurrent body edit", { onFill(page, element) { if (element.tagName === "INPUT") page.dom.window.document.querySelector('[contenteditable="true"]').textContent = "用户刚输入的正文"; } }],
  ]) {
    await t.test(name, async () => {
      const f = fixture(options);
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft: makeDraft() });
      assert.equal(receipt.status, "needs_confirmation");
      assert.equal(f.page.saveCalls, 0);
      if (name === "concurrent body edit") assert.equal(f.page.fills.length, 1);
    });
  }
});

test("CRLF and non-breaking spaces are normalized without collapsing intentional newlines", async () => {
  const f = fixture({ transformText: (text) => text.replace(/\r\n/g, "\n").replace(/ /g, "\u00a0") });
  const draft = { ...makeDraft(), body: "first line\r\n\r\nsecond line" };
  const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft });
  assert.equal(receipt.status, "needs_confirmation");
  assert.equal(f.page.saveCalls, 1);
});

test("invalid images and content fail before opening any tab", async (t) => {
  for (const draft of [
    { ...makeDraft(), title: "字".repeat(21) }, { ...makeDraft(), body: "字".repeat(1001) },
    { ...makeDraft(), images: [] }, { ...makeDraft(), images: Array(19).fill(makeDraft().images[0]) },
    { ...makeDraft(), images: [{ ...makeDraft().images[0], bytes: "https://remote.invalid/image.png" }] },
    { ...makeDraft(), images: [{ ...makeDraft().images[0], mime: "image/svg+xml" }] },
  ]) {
    await t.test(`invalid input ${draft.title.length}/${draft.body.length}/${draft.images.length}`, async () => {
      const f = fixture();
      const receipt = await saveXiaohongshuDraft({ context: f.context, account, draft });
      assert.equal(receipt.status, "failed");
      assert.equal(f.context.newPageCalls, 0);
    });
  }
});

test("the submitted draft remains a snapshot when caller state changes during account verification", async () => {
  const draft = makeDraft();
  const f = fixture({ onIdentity(page, number) {
    if (number === 1) {
      draft.title = "后来改动的标题";
      draft.body = "后来改动的文案";
      draft.images[0].bytes.fill(0);
      draft.images.reverse();
    }
  } });
  await saveXiaohongshuDraft({ context: f.context, account, draft });
  assert.deepEqual(f.page.fills.map(({ text }) => text), ["测试标题", "第一段\n第二段"]);
  assert.deepEqual(f.page.uploads.map(({ name }) => name), ["1.png", "2.png"]);
  assert.deepEqual(f.page.uploads[0].buffer, png);
});
