import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

async function fixture(t, options = {}) {
  const dom = installDom(), oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  t.mock.method(URL, "createObjectURL", () => "blob:fixture"); t.mock.method(URL, "revokeObjectURL", () => {});
  const filename = fileURLToPath(new URL("../app/components/DraftSyncDialog.tsx", import.meta.url)), native = createRequire(filename);
  const React = native("react"), { act } = React, { createRoot } = native("react-dom/client");
  let saved = null, saveOverride, closed = 0;
  const panels = {};
  const saves = [], batches = [], panelRenders = [], bindingReads = [], accountReads = [];
  const binding = { deviceId: "fixture-device", connectionToken: "fixture-private-token" };
  const accounts = [{ id: "a".repeat(20), name: "已保存的公众号", appId: "wx-existing" }];
  const Panel = (platform) => function TestPanel(props) { panels[platform] = props; panelRenders.push(props); return React.createElement("p", { "data-testid": "platform-panel" }, "平台操作测试边界"); };
  const XhsPanel = Panel("xiaohongshu"), WechatPanel = Panel("wechat");
  // eslint-disable-next-line react/prop-types -- Test boundary for the typed connection component.
  function Connection(props) { return React.createElement("section", { "data-testid": "shared-connection" }, props.binding ? "本机连接已保存" : React.createElement("button", { onClick: () => props.onChange(binding, accounts) }, "连接这台电脑")); }
  const require = (specifier) => {
    if (specifier === "./WechatDraftPanel") return { default: WechatPanel, __esModule: true };
    if (specifier === "./XiaohongshuDraftPanel") return { default: XhsPanel, __esModule: true };
    if (specifier === "../hooks/usePlatformImages") return { usePlatformImages: (source, target, note, confirmed) => {
      const images = React.useMemo(() => source ? source.map((image, index) => ({ ...image, height: target === "wechat" ? 1350 : 1440, blob: index === source.length - 1 && note && confirmed ? new Blob([image.blob, note.title + note.text], { type: "image/png" }) : target === "wechat" ? new Blob([image.blob, "wechat adapted"], { type: "image/png" }) : image.blob })) : null, [source, target, note, confirmed]);
      return { images, preparing: false, error: "" };
    } };
    if (specifier === "../../lib/draftSync/adaptImages") return loadDomModule("lib/draftSync/adaptImages.ts");
    if (specifier === "./LocalSyncConnection") return { default: Connection, __esModule: true };
    if (specifier === "../../lib/wechat/deviceVault") return {
      loadBinding: async () => { bindingReads.push(true); if (options.loading) return new Promise(() => {}); return options.unbound ? null : binding; },
      listAccounts: async () => { accountReads.push(true); return options.unbound ? [] : accounts; },
    };
    if (specifier === "../../lib/draftSync/validation") return loadDomModule("lib/draftSync/validation.ts");
    if (specifier === "../../lib/draftSync/localDraftStore") return {
      loadLocalDraft: async () => saved, clearLocalDraft: async () => { saved = null; },
      saveLocalDraft: async (draft) => { saves.push(draft); await saveOverride?.(draft); saved = draft; },
    };
    return native(specifier);
  };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const loaded = { exports: {} }; new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  const container = document.createElement("div"), opener = document.createElement("button"); document.body.append(opener, container);
  const root = createRoot(container);
  const props = {
    open: true, openerRef: { current: opener }, title: "用户完整文章", sourceFormat: "xiaohongshu", canCollect: true,
    collectAssets: async () => { const images = Array.from({ length: 3 }, (_, i) => ({ id: crypto.randomUUID(), name: `第${i + 1}页.png`, width: 1080, height: 1440, blob: new Blob([`full page ${batches.length}:${i}`], { type: "image/png" }) })); if (options.risk) images.at(-1).riskTemplate = { svg: "<svg/>" }; batches.push(images); return images; },
    ...(options.risk ? { riskNote: { enabled: true, title: "提示", text: "投资有风险" } } : {}),
    onClose: () => { closed++; root.render(null); }, onReturnToEditor: () => root.render(null),
  };
  async function click(value) {
    const element = typeof value === "string" ? [...container.querySelectorAll("button")].find((button) => button.textContent === value) : value;
    assert.ok(element, `visible action ${value}`); assert.equal(element.disabled, false);
    await act(async () => element.click());
  }
  async function change(selector, value) {
    const field = container.querySelector(selector); assert.ok(field);
    const prototype = field.tagName === "INPUT" ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  }
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct; });
  await act(async () => root.render(React.createElement(loaded.exports.default, props)));
  return { container, opener, act, click, change, batches, saves, binding, accounts, panelRenders, bindingReads, accountReads, get saved() { return saved; }, panels, get panel() { return panels[container.querySelector(".draft-sync-platforms button[aria-pressed=true]")?.textContent.startsWith("小红书") ? "xiaohongshu" : "wechat"]; }, get closed() { return closed; }, set saveOverride(value) { saveOverride = value; }, reopen: () => act(async () => root.render(React.createElement(loaded.exports.default, props))) };
}
const pending = (platform, id) => ({ platform, accountId: id, jobId: crypto.randomUUID(), status: "needs_confirmation", message: "结果待核对" });

test("dialog passes all ordered original posters and independent platform copy to service panels", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始");
  await f.change("#draft-platform-body", "小红书独立配文\n第二行。");
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  await f.change("#draft-platform-body", "公众号专用配文。");
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[0]);
  await f.click(f.container.querySelector('[aria-label="前移第 2 张图片"]'));
  await f.click("确认图片，连接小红书");
  assert.deepEqual(f.panel.draft.images, [f.batches[0][1], f.batches[0][0], f.batches[0][2]]);
  assert.deepEqual(f.panel.draft.content.wechat.body, "公众号专用配文。");
  assert.deepEqual(f.panel.draft.content.xiaohongshu.body, "小红书独立配文\n第二行。");
  assert.equal(f.saved, null); assert.doesNotMatch(f.container.textContent, /插件|扩展|Tampermonkey/);
});

test("stale batch snapshots cannot erase other accounts or platforms with the same account identifier", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  const first = f.panel, snapshot = first.draft;
  const a = pending("wechat", "same-account"), b = pending("xiaohongshu", "same-account"), c = pending("wechat", "second-account");
  await f.act(async () => first.runOperation("批量处理中", async (signal) => {
    await first.persistReceipt(snapshot, a, signal);
    await first.persistReceipt(snapshot, b, signal);
    await first.persistReceipt(snapshot, c, signal);
    await first.persistReceipt(snapshot, { ...a, draftId: "saved-draft", status: "saved" }, signal);
  }));
  assert.equal(f.saved.receipts.length, 3);
  assert.equal(f.saved.receipts.find((r) => r.platform === "wechat" && r.accountId === "same-account").status, "saved");
  assert.equal(f.saved.receipts.find((r) => r.platform === "xiaohongshu").jobId, b.jobId);
  assert.deepEqual(f.saved.images, snapshot.images);
});

test("closing preserves the pending ID, new posters retain it, and late results cannot overwrite the new draft", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  const old = f.panel, receipt = pending("xiaohongshu", "account"), gate = Promise.withResolvers();
  let operation, signal;
  await f.act(async () => { operation = old.runOperation("等待结果", async (currentSignal) => {
    signal = currentSignal; await old.persistReceipt(old.draft, receipt, signal); await gate.promise;
    await old.persistReceipt(old.draft, { ...receipt, status: "saved", draftId: "late" }, signal);
  }); });
  assert.equal(f.saved.receipts[0].jobId, receipt.jobId);
  await f.click(f.container.querySelector('[aria-label="关闭草稿同步"]')); assert.equal(signal.aborted, true);
  assert.equal(document.activeElement, f.opener); assert.equal(document.body.style.overflow, "");
  await f.reopen(); await f.click("用当前海报开始"); await f.change("#draft-platform-body", "下一份内容"); await f.click("存到本机");
  const newId = f.saved.id;
  await f.act(async () => { gate.resolve(); await operation; });
  assert.equal(f.saved.id, newId); assert.equal(f.saved.content.xiaohongshu.body, "下一份内容");
  assert.equal(f.saved.receipts[0].jobId, receipt.jobId); assert.equal(f.saved.receipts[0].status, "needs_confirmation");
});

test("failed durable save stops a platform operation before upload", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  f.saveOverride = async () => { throw new Error("本机空间不足"); };
  let uploaded = false;
  await f.act(async () => f.panel.runOperation("准备同步", async (signal) => {
    await f.panel.persistReceipt(f.panel.draft, pending("wechat", "account"), signal); uploaded = true;
  }));
  assert.equal(uploaded, false); assert.equal(f.saved, null); assert.match(f.container.textContent, /本机空间不足/);
});


test("an unbound browser gets one shared connection step before either platform can act", async (t) => {
  const f = await fixture(t, { unbound: true });
  await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  assert.equal(f.container.querySelectorAll('[data-testid="shared-connection"]').length, 1);
  assert.equal(f.container.querySelectorAll('[data-testid="platform-panel"]').length, 0);
  assert.equal(f.panelRenders.length, 0);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  assert.equal(f.container.querySelectorAll('[data-testid="platform-panel"]').length, 0);
  await f.click("连接这台电脑");
  assert.equal(f.panel.binding, f.binding);
  assert.deepEqual(f.panel.accounts, f.accounts);
  assert.equal(f.container.querySelectorAll('[data-testid="shared-connection"]').length, 1);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[0]);
  assert.equal(f.panel.binding, f.binding);
  assert.equal(f.container.querySelectorAll('[data-testid="platform-panel"]').length, 2);
  assert.equal(f.bindingReads.length, 1, "switching platforms must reuse the existing device binding");
  await f.click("存到本机");
  assert.equal(JSON.stringify(f.saved).includes("fixture-private-token"), false);
  assert.equal(JSON.stringify(f.saved).includes("wx-existing"), false);
});

test("platform panels remain unavailable until the saved local connection has been read", async (t) => {
  const f = await fixture(t, { loading: true });
  await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  assert.equal(f.panelRenders.length, 0);
  assert.equal(f.container.querySelectorAll('[data-testid="platform-panel"]').length, 0);
});

test("each platform keeps its own step and failure while the other remains usable", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  const xhs = f.panel, gate = Promise.withResolvers();
  let operation;
  await f.act(async () => { operation = xhs.runOperation("正在连接小红书", async () => { await gate.promise; throw new Error("小红书窗口未打开"); }); });
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  assert.match(f.container.querySelector('[aria-current="step"]').textContent, /确认内容/);
  assert.doesNotMatch(f.container.querySelector('.draft-sync-footer').textContent, /正在连接小红书/);
  await f.click("确认图片，选择公众号");
  assert.equal(f.panel.busy, false);
  await f.act(async () => { gate.resolve(); await operation; });
  assert.doesNotMatch(f.container.querySelector('.draft-sync-footer').textContent, /小红书窗口未打开/);
  await f.act(async () => f.panel.runOperation("测试公众号", async () => { throw new Error("公众号接口连接失败"); }));
  assert.match(f.container.querySelector('.draft-sync-footer').textContent, /公众号接口连接失败/);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[0]);
  assert.match(f.container.querySelector('[aria-current="step"]').textContent, /连接小红书/);
  assert.match(f.container.querySelector('.draft-sync-footer').textContent, /小红书窗口未打开/);
  assert.doesNotMatch(f.container.querySelector('.draft-sync-footer').textContent, /公众号接口连接失败/);
});

test("adapted image confirmation is platform-specific and never replaces archived source pixels", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  assert.equal(f.panel.contentReady, true);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  assert.equal(f.panel.contentReady, false);
  await f.click("确认图片，选择公众号");
  const panel = f.panel;
  assert.equal(panel.contentReady, true);
  assert.equal(panel.draft.images[0].height, 1350);
  await f.act(async () => panel.runOperation("存草稿", async (signal) => {
    const next = await panel.persistReceipt(panel.draft, pending("wechat", "account"), signal);
    assert.equal(next.images[0].blob, panel.draft.images[0].blob);
    assert.equal(next.images[0].height, 1350);
  }));
  assert.equal(f.saved.images[0].height, 1440);
  assert.equal(f.saved.images[0].blob, f.batches[0][0].blob);
});

test("oversize title is explained beside its input without silent truncation", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始");
  const title = "长".repeat(23);
  await f.change("#draft-platform-title", title);
  const input = f.container.querySelector("#draft-platform-title");
  assert.equal(input.value, title); assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.match(f.container.querySelector("#draft-title-help").textContent, /超出 3 字/);
  assert.equal([...f.container.querySelectorAll("button")].find((button) => button.textContent === "确认图片，连接小红书").disabled, true);
  await f.change("#draft-platform-title", "短标题");
  assert.equal(input.getAttribute("aria-invalid"), "false");
});

test("risk copy and confirmation are separate per platform and edits regenerate only that final page", async (t) => {
  const f = await fixture(t, { risk: true }); await f.click("用当前海报开始");
  const confirm = () => f.container.querySelector('.draft-sync-risk-confirm input');
  assert.equal(f.panels.xiaohongshu.draft.images.at(-1).id, f.batches[0].at(-1).id);
  assert.equal(f.panels.xiaohongshu.draft.images.length, 3);
  await f.change("#draft-risk-text", "小红书独立风险\n保留第二行");
  await f.click(confirm()); await f.click("确认图片，连接小红书");
  const xhsRisk = f.panels.xiaohongshu.draft.images.at(-1);
  await f.click(f.container.querySelectorAll(".draft-sync-platforms button")[1]);
  assert.equal(confirm().checked, false);
  assert.equal(f.container.querySelector('#draft-risk-text').value, "投资有风险");
  await f.change("#draft-risk-text", "公众号独立风险");
  await f.click(confirm()); await f.click("确认图片，选择公众号");
  const wechatRisk = f.panels.wechat.draft.images.at(-1);
  assert.notEqual(await wechatRisk.blob.text(), await xhsRisk.blob.text());
  await f.click("上一步"); await f.change("#draft-risk-text", "公众号修改后的风险");
  assert.equal(confirm().checked, false); assert.equal(f.panels.wechat.contentReady, false);
  assert.equal(f.panels.xiaohongshu.draft.images.at(-1).blob, xhsRisk.blob);
  await f.click("存到本机");
  assert.equal(f.saved.images.length, 3, "archive contains base originals, never an old baked risk page");
  assert.equal(f.saved.risk.notes.wechat.text, "公众号修改后的风险");
  assert.equal(f.saved.risk.notes.xiaohongshu.text, "小红书独立风险\n保留第二行");
});

test("concurrent platform receipts stay durable without one replacing the other", async (t) => {
  const f = await fixture(t); await f.click("用当前海报开始"); await f.click("确认图片，连接小红书");
  const xhs = f.panels.xiaohongshu, wechat = f.panels.wechat, gate = Promise.withResolvers();
  let first = true, a, b;
  f.saveOverride = async () => { if (first) { first = false; await gate.promise; } };
  await f.act(async () => {
    a = xhs.runOperation("小红书保存", (signal) => xhs.persistReceipt(xhs.draft, pending("xiaohongshu", "account"), signal));
    b = wechat.runOperation("公众号保存", (signal) => wechat.persistReceipt(wechat.draft, pending("wechat", "account"), signal));
  });
  await f.act(async () => { gate.resolve(); await Promise.all([a, b]); });
  assert.deepEqual(f.saved.receipts.map((receipt) => receipt.platform).sort(), ["wechat", "xiaohongshu"]);
  assert.equal(f.panels.xiaohongshu.draft.receipts.length, 2);
  assert.equal(f.saved.images[0].blob, f.batches[0][0].blob);
});
