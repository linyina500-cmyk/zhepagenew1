import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom } from "./helpers/load-dom-module.mjs";

const account = { id: "0123456789abcdefabcd", name: "测试小红书账号" };
async function fixture(t, { resultStatus = "needs_confirmation", existingReceipt, switchedAccount = false, wrongDevice = false } = {}) {
  const dom = installDom(), previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/XiaohongshuDraftPanel.tsx", import.meta.url)), native = createRequire(filename);
  const React = native("react"), { act } = React, { createRoot } = native("react-dom/client");
  const calls = [], saves = [], operations = [], errors = [];
  let jobId = existingReceipt?.jobId, submitted = 0, checks = 0;
  const currentJob = (changes = {}) => ({ id: jobId, accountId: account.id, accountName: account.name, title: "小红书标题", imageCount: 2,
    uploadedCount: 2, status: resultStatus, message: resultStatus === "saved" ? "同一草稿回读通过" : "平台结果仍需核对", acknowledged: false,
    ...(resultStatus === "saved" ? { draftId: "verified-draft" } : {}), ...changes });
  const api = {
    async getAccount() { checks++; return switchedAccount && checks > 1 ? { ...account, id: "abcdef0123456789abcd" } : account; },
    async openLogin() { calls.push(["login"]); },
    async createJob(input) { jobId = input.id; calls.push(["create", input]); return currentJob(); },
    async waitForJob(value) { return value; },
    async getJob() { calls.push(["read"]); return currentJob(); },
    async verifyJob() { calls.push(["verify"]); return currentJob(); },
    async acknowledgeJob() { calls.push(["acknowledge"]); return currentJob({ status: "needs_confirmation", acknowledged: true }); },
  };
  const require = (specifier) => {
    if (specifier === "../../lib/xiaohongshu/client") return { createXhsClient: () => api };
    if (specifier === "../../lib/wechat/client") return { createWechatClient: () => ({ getConnection: async () => ({ deviceId: wrongDevice ? "different-device" : "fixture-device" }) }) };
    return native(specifier);
  };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const loaded = { exports: {} }; new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let draft = { id: "local-fixture", content: { xiaohongshu: { title: "小红书标题", body: "小红书正文" }, wechat: { title: "独立公众号标题", body: "独立公众号正文" } },
    images: [1, 2].map((index) => ({ id: `image-${index}`, name: `${index}.png`, blob: new Blob([`original-${index}`], { type: "image/png" }), width: 1080, height: 1440 })),
    receipts: existingReceipt ? [existingReceipt] : [] };
  const props = {
    draft, binding: { deviceId: "fixture-device", connectionToken: "fixture-secret" }, contentReady: true, contentChanged: false, busy: false,
    runOperation(_label, operation) {
      const pending = operation(new AbortController().signal).catch((error) => errors.push(error));
      operations.push(pending); return pending;
    },
    async persistReceipt(snapshot, receipt, signal) {
      signal.throwIfAborted(); saves.push(receipt);
      draft = { ...snapshot, receipts: [...snapshot.receipts.filter((value) => !(value.platform === receipt.platform && value.accountId === receipt.accountId)), receipt] };
      props.draft = draft; root.render(React.createElement(loaded.exports.default, props)); return draft;
    },
    onSubmitted() { submitted++; },
  };
  await act(async () => root.render(React.createElement(loaded.exports.default, props)));
  const button = (text) => [...container.querySelectorAll("button")].find((element) => element.textContent === text);
  async function click(value) {
    const element = typeof value === "string" ? button(value) : value;
    assert.ok(element); assert.equal(element.disabled, false);
    await act(async () => { element.click(); await Promise.all(operations); });
  }
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct; });
  return { container, button, click, calls, saves, errors, get draft() { return draft; }, get submitted() { return submitted; } };
}

test("XHS panel has local-service actions and preserves complete independent poster inputs", async (t) => {
  const f = await fixture(t);
  assert.doesNotMatch(f.container.textContent, /插件|扩展|Tampermonkey|安装脚本|连接口令/);
  assert.equal(f.container.querySelectorAll('input[type="password"], input[type="file"]').length, 0);
  await f.click("打开登录窗口");
  assert.deepEqual(f.calls, [["login"]]);
  assert.equal([...f.container.querySelectorAll("button")].some((button) => /发布|定时/.test(button.textContent)), false);
  assert.equal(f.button("同步到小红书草稿箱"), undefined);
  await f.click("我已登录");
  assert.match(f.container.textContent, /测试小红书账号/);
  await f.click("同步到小红书草稿箱");
  const input = f.calls.find(([action]) => action === "create")[1];
  assert.deepEqual(input.content, { title: "小红书标题", body: "小红书正文" });
  assert.deepEqual(await Promise.all(input.images.map((image) => image.blob.text())), ["original-1", "original-2"]);
  assert.equal(input.accountId, account.id); assert.equal(f.submitted, 1);
  assert.ok(f.saves.every((receipt) => receipt.status === "needs_confirmation"));
  assert.equal(f.button("同步到小红书草稿箱").disabled, true);
});

test("XHS human acknowledgement requires the checkbox and never becomes saved", async (t) => {
  const f = await fixture(t);
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.equal(f.button("结束本次任务").disabled, true);
  await f.click(f.container.querySelector('input[type="checkbox"]'));
  await f.click("结束本次任务");
  assert.equal(f.calls.filter(([action]) => action === "acknowledge").length, 1);
  assert.equal(f.draft.receipts[0].status, "needs_confirmation");
  assert.ok(f.saves.every((receipt) => receipt.status !== "saved"));
  assert.match(f.container.textContent, /保存结果以小红书草稿箱为准/);
  assert.equal(f.button("同步到小红书草稿箱").disabled, true, "a separate new-draft confirmation remains necessary");
});

test("only a verified saved service result is persisted as saved", async (t) => {
  const f = await fixture(t, { resultStatus: "saved" });
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.equal(f.saves[0].status, "needs_confirmation");
  assert.equal(f.draft.receipts[0].status, "saved"); assert.equal(f.draft.receipts[0].draftId, "verified-draft");
});

test("a switched account aborts XHS submission before reserving or sending content", async (t) => {
  const f = await fixture(t, { switchedAccount: true });
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.equal(f.calls.filter(([action]) => action === "create").length, 0); assert.equal(f.saves.length, 0);
  assert.match(f.errors[0].message, /账号已变化/);
});


test("a changed local device stops login and account checks without sending platform content", async (t) => {
  const f = await fixture(t, { wrongDevice: true });
  await f.click("打开登录窗口"); await f.click("我已登录");
  assert.equal(f.errors.length, 2);
  assert.ok(f.errors.every((error) => /不是原来绑定的电脑/.test(error.message)));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saves, []);
  assert.equal(f.button("同步到小红书草稿箱"), undefined);
});
