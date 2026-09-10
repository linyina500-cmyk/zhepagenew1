import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

async function fixture(context) {
  const dom = installDom();
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  context.mock.method(URL, "createObjectURL", () => "blob:draft-sync-test");
  context.mock.method(URL, "revokeObjectURL", () => {});
  const filename = fileURLToPath(new URL("../app/components/DraftSyncDialog.tsx", import.meta.url));
  const nativeRequire = createRequire(filename);
  const React = nativeRequire("react"), { createRoot } = nativeRequire("react-dom/client"), { act } = React;
  const clientModule = loadDomModule("lib/browserSync/client.ts");
  const preparations = [], saves = [], jobs = new Map();
  let saved = null, closed = 0, disposed = 0, batch = 0, prepareOverride, saveOverride;
  const generatedBatches = [];
  const bridge = {
    ping: async () => ({ version: clientModule.BROWSER_SYNC_VERSION }),
    getStatus: async (platform) => jobs.get(platform) ?? null,
    async prepare(input, signal) {
      assert.equal(saved.receipts.find((receipt) => receipt.platform === input.platform).draftId, input.id, "the durable recovery record must exist before transfer");
      preparations.push(input);
      if (prepareOverride) return prepareOverride(input, signal);
      const job = { id: input.id, title: input.content.title, imageCount: input.images.length, status: "ready", message: "全部图片已存入浏览器，请在平台导入" };
      jobs.set(input.platform, job); return job;
    },
    dispose() { disposed++; },
  };
  const require = (specifier) => {
    if (specifier === "../../lib/browserSync/client") return { ...clientModule, createBrowserSyncClient: () => bridge };
    if (specifier === "../../lib/draftSync/localDraftStore") return {
      loadLocalDraft: async () => saved,
      saveLocalDraft: async (draft) => { saves.push(draft); await saveOverride?.(draft); saved = draft; },
      clearLocalDraft: async () => { saved = null; },
    };
    if (specifier === "../../lib/draftSync/validation") return loadDomModule("lib/draftSync/validation.ts");
    return nativeRequire(specifier);
  };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  });
  const loaded = { exports: {} }; new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  const container = document.createElement("div"), opener = document.createElement("button");
  document.body.append(opener, container); const root = createRoot(container);
  const props = {
    open: true, openerRef: { current: opener }, title: "用户的真实文章", sourceFormat: "xiaohongshu", canCollect: true,
    collectAssets: async () => {
      batch++;
      const images = Array.from({ length: batch === 1 ? 5 : 3 }, (_, index) => ({
        id: `batch-${batch}-page-${index + 1}`, name: `完整文章${batch}-第${index + 1}页.png`, width: 1080, height: 1440,
        blob: new Blob([`real rendered article ${batch}, page ${index + 1}`], { type: "image/png" }),
      }));
      generatedBatches.push(images); return images;
    },
    onClose: () => { closed++; root.render(null); }, onReturnToEditor: () => { closed++; root.render(null); },
  };
  const click = async (button) => {
    const element = typeof button === "string" ? [...container.querySelectorAll("button")].find((node) => node.textContent === button) : button;
    assert.ok(element, `visible action: ${button}`); assert.equal(element.disabled, false, `enabled action: ${element.textContent}`);
    await act(async () => { element.click(); });
  };
  const change = async (selector, value) => {
    const field = container.querySelector(selector); assert.ok(field);
    const prototype = field.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  };
  context.after(async () => { await act(async () => { root.unmount(); }); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });
  await act(async () => { root.render(React.createElement(loaded.exports.default, props)); });
  return {
    container, opener, preparations, saves, jobs, generatedBatches, click, change, act, clientModule,
    get saved() { return saved; }, get closed() { return closed; }, get disposed() { return disposed; },
    set prepareOverride(callback) { prepareOverride = callback; },
    set saveOverride(callback) { saveOverride = callback; },
  };
}

test("main draft dialog transfers the user's complete ordered article and independent caption, then allows a second round", async (context) => {
  const f = await fixture(context);
  await f.click("用当前海报开始");
  assert.equal(f.container.querySelectorAll(".draft-sync-image-card").length, 5);
  assert.equal(f.container.querySelector("#draft-platform-title").value, "用户的真实文章");
  const caption = "文".repeat(980) + "\n完整保留文案结尾。";
  await f.change("#draft-platform-title", "小红书专用标题");
  await f.change("#draft-platform-body", caption);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  assert.equal(f.container.querySelector("#draft-platform-body").value, "");
  await f.change("#draft-platform-title", "公众号独立标题");
  await f.change("#draft-platform-body", "仅用于公众号的独立正文。");
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[0]);
  assert.equal(f.container.querySelector("#draft-platform-body").value, caption);
  await f.click(f.container.querySelector('[aria-label="前移第 2 张图片"]'));
  const original = f.generatedBatches[0], ordered = [original[1], original[0], ...original.slice(2)];
  await f.click("下一步：交给浏览器");
  assert.equal(f.container.querySelector(".draft-sync-summary-body").textContent, caption);
  await f.click("存入浏览器扩展");
  assert.equal(f.preparations.length, 1);
  assert.deepEqual(f.preparations[0].content, { title: "小红书专用标题", body: caption });
  assert.deepEqual(f.preparations[0].images.map((image) => image.name), ordered.map((image) => image.name));
  for (let index = 0; index < ordered.length; index++) assert.equal(f.preparations[0].images[index].blob, ordered[index].blob, "the exact generated Blob reaches the client");
  assert.deepEqual(f.saved.content.wechat, { title: "公众号独立标题", body: "仅用于公众号的独立正文。" });
  assert.equal(f.saved.receipts[0].status, "needs_confirmation");
  assert.equal(f.container.textContent.includes("用户确认已保存"), false);
  await f.click("已在草稿箱核对，确认已保存");
  assert.equal(f.saved.receipts[0].status, "confirmed_by_user");
  await f.click("读取传图状态");
  assert.equal(f.saved.receipts[0].status, "confirmed_by_user", "reading an extension job must retain the separate human confirmation");

  await f.click("返回确认内容");
  await f.click("用当前图片新建");
  await f.change("#draft-platform-body", "第二篇文章的完整文案。");
  await f.click("下一步：交给浏览器");
  await f.click("存入浏览器扩展");
  assert.equal(f.preparations.length, 1, "an existing platform job cannot be silently replaced");
  assert.match(f.container.textContent, /仍有上一组内容/);
  f.jobs.clear(); // The user explicitly ends the previous group in the platform panel.
  await f.click("返回确认内容");
  await f.click("下一步：交给浏览器");
  await f.click("存入浏览器扩展");
  assert.equal(f.preparations.length, 2, "the same open dialog must allow a fresh group after platform completion");
  assert.notEqual(f.preparations[1].id, f.preparations[0].id);
  assert.equal(f.preparations[1].images.length, 3);
  assert.equal(f.preparations[1].content.body, "第二篇文章的完整文案。");
  assert.deepEqual(f.preparations[1].images, f.generatedBatches[1]);
  assert.deepEqual(f.saved.selectedAccountIds, []);
  assert.equal(f.saved.receipts[0].status, "needs_confirmation");
  assert.equal(f.container.querySelectorAll('input[type="password"]').length, 0);
});

test("closing during an active transfer stops waiting and preserves the complete draft with an unconfirmed receipt", async (context) => {
  const f = await fixture(context);
  let signal;
  f.prepareOverride = (_input, requestSignal) => {
    signal = requestSignal;
    return new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(new f.clientModule.BrowserSyncUnconfirmedError("用户停止等待，已传入的内容需要核对")), { once: true }));
  };
  await f.click("用当前海报开始");
  await f.change("#draft-platform-body", "关闭后仍需保留的真实配文。");
  await f.click("下一步：交给浏览器");
  await f.click("存入浏览器扩展");
  assert.ok(signal); assert.equal(signal.aborted, false);
  assert.equal(f.saved.images.length, 5);
  assert.equal(f.saved.receipts[0].status, "needs_confirmation");
  const id = f.saved.receipts[0].draftId;
  await f.click(f.container.querySelector('[aria-label="关闭草稿同步"]'));
  assert.equal(f.closed, 1); assert.equal(signal.aborted, true); assert.ok(f.disposed >= 1);
  assert.equal(f.container.querySelector("dialog"), null);
  assert.equal(document.activeElement, f.opener);
  assert.equal(document.body.style.overflow, "");
  assert.equal(f.saved.receipts[0].draftId, id);
  assert.equal(f.saved.receipts[0].status, "needs_confirmation");
  assert.match(f.saved.receipts[0].message, /用户停止等待/);
  assert.equal(f.saved.content.xiaohongshu.body, "关闭后仍需保留的真实配文。");
  assert.deepEqual(f.saved.images, f.generatedBatches[0]);
  assert.equal(f.preparations.length, 1);
});

test("an older autosave cannot queue behind the pending transfer record while its local write is delayed", async (context) => {
  const f = await fixture(context), callbacks = [];
  const originalSetTimeout = window.setTimeout.bind(window);
  context.mock.method(window, "setTimeout", (callback, delay, ...args) => {
    if (delay === 600) callbacks.push(callback);
    return originalSetTimeout(callback, delay, ...args);
  });
  await f.click("用当前海报开始");
  await f.change("#draft-platform-body", "等待存档完成后传入的完整配文。");
  await f.click(f.container.querySelector('.draft-sync-footer-status input[type="checkbox"]'));
  await f.click("下一步：交给浏览器");
  assert.ok(callbacks.length);
  const oldAutosave = callbacks.at(-1);
  let finishSave;
  f.saveOverride = () => new Promise((resolve) => { finishSave = resolve; });
  await f.click("存入浏览器扩展");
  assert.ok(finishSave); assert.equal(f.preparations.length, 0);
  const pendingId = f.saves[0].receipts[0].draftId;
  // Even if a timer callback was already queued when the operation began,
  // it cannot append an old draft behind the durable pending receipt.
  await f.act(async () => { oldAutosave(); });
  f.saveOverride = undefined;
  await f.act(async () => { finishSave(); });
  assert.equal(f.preparations.length, 1);
  assert.equal(f.saved.receipts[0].draftId, pendingId);
  assert.ok(f.saves.every((draft) => draft.receipts[0]?.draftId === pendingId));
  assert.equal(f.saved.content.xiaohongshu.body, "等待存档完成后传入的完整配文。");
});

test("transferring WeChat copy retains the warning for newer unsent Xiaohongshu edits", async (context) => {
  const f = await fixture(context);
  await f.click("用当前海报开始");
  await f.change("#draft-platform-body", "小红书已传入的文案 A。");
  await f.click("下一步：交给浏览器");
  await f.click("存入浏览器扩展");
  await f.click("返回确认内容");
  await f.change("#draft-platform-body", "小红书尚未传入的文案 B。");
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  await f.change("#draft-platform-body", "公众号本次传入的独立文案。");
  await f.click(f.container.querySelector('.draft-sync-validation input[type="checkbox"]'));
  await f.click("下一步：交给浏览器");
  await f.click("存入浏览器扩展");
  assert.equal(f.preparations.length, 2);
  assert.equal(f.preparations[0].content.body, "小红书已传入的文案 A。");
  assert.equal(f.preparations[1].platform, "wechat");
  assert.equal(f.container.querySelector(".draft-sync-results h3").textContent, "传图与草稿状态");
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[0]);
  assert.equal(f.saved.content.xiaohongshu.body, "小红书尚未传入的文案 B。");
  assert.equal(f.container.querySelector(".draft-sync-results h3").textContent, "上次传图结果（当前编辑尚未传入）");
});
