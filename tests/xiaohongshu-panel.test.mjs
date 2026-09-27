import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom } from "./helpers/load-dom-module.mjs";

const account = { id: "0123456789abcdefabcd", name: "测试小红书账号" };
async function fixture(t, { resultStatus = "needs_confirmation", existingReceipt, wrongDevice = false, createError, readStatus, waitResult,
  loginState = { status: "login_required", message: "请在专用窗口扫码，完成后点击“我已登录”。" }, loginError } = {}) {
  const dom = installDom(), previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/XiaohongshuDraftPanel.tsx", import.meta.url)), native = createRequire(filename);
  const React = native("react"), { act } = React, { createRoot } = native("react-dom/client");
  const calls = [], saves = [], operations = [], errors = [], waits = [];
  let jobId = existingReceipt?.jobId, submitted = 0, checks = 0;
  const currentJob = (changes = {}) => ({ id: jobId, accountId: account.id, accountName: account.name, title: "小红书标题", imageCount: 2,
    uploadedCount: 2, status: resultStatus, message: resultStatus === "saved" ? "同一草稿回读通过" : "平台结果仍需核对", acknowledged: false,
    ...(resultStatus === "saved" ? { draftId: "verified-draft" } : {}), ...changes });
  const api = {
    async getAccount() { checks++; return account; },
    async openLogin() { calls.push(["login"]); if (loginError) throw new Error(loginError); return loginState; },
    async createJob(input) { jobId = input.id; calls.push(["create", input]); if (createError) throw new Error(createError); return currentJob(); },
    async waitForJob(value, signal, progress) {
      waits.push(value.status);
      if (waitResult && ["uploading", "creating"].includes(value.status)) {
        progress(value); await waitResult(); signal.throwIfAborted();
        return currentJob();
      }
      return value;
    },
    async getJob() { calls.push(["read"]); return currentJob(readStatus ? { status: readStatus, message: "正在重新打开草稿核对" } : {}); },
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
  return { container, button, click, calls, saves, errors, waits, get draft() { return draft; }, get submitted() { return submitted; }, get checks() { return checks; },
    async replaceDraft(changes = {}) {
      draft = { ...draft, id: "replacement-draft", receipts: [], ...changes }; props.draft = draft;
      jobId = draft.receipts.find((receipt) => receipt.platform === "xiaohongshu")?.jobId;
      await act(async () => root.render(React.createElement(loaded.exports.default, props)));
    },
  };
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
  assert.equal(f.checks, 1, "submission relies on the service's fresh check instead of requesting another homepage read");
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

test("a connected login result enables the bound account directly without an extra account request", async (t) => {
  const pending = { platform: "xiaohongshu", accountId: account.id, jobId: "existing-job", status: "needs_confirmation", message: "已有任务待核对" };
  const f = await fixture(t, { loginState: { status: "connected", account }, existingReceipt: pending });
  await f.click("打开登录窗口");
  assert.match(f.container.textContent, /已连接：测试小红书账号/u);
  assert.equal(f.checks, 0);
  assert.deepEqual(f.calls, [["login"]]);
  assert.match(f.container.textContent, /已有任务待核对/u);
  assert.equal(f.button("同步到小红书草稿箱").disabled, true, "login must not bypass an existing uncertain task");
  assert.equal(f.saves.length, 0);
});

test("login-required and needs-attention messages do not claim a successful connection", async (t) => {
  for (const state of [
    { status: "login_required", message: "请在专用窗口扫码，完成后点击“我已登录”。" },
    { status: "needs_attention", message: "专用窗口未显示登录页，请先检查其中提示。" },
  ]) {
    await t.test(state.status, async (t) => {
      const f = await fixture(t, { loginState: state });
      await f.click("我已登录");
      assert.match(f.container.textContent, /已连接/u);
      await f.click("切换账号");
      assert.equal(f.container.querySelector(".draft-sync-message").textContent, state.message);
      assert.doesNotMatch(f.container.textContent, /已连接：|已打开/u);
      assert.equal(f.button("同步到小红书草稿箱"), undefined);
      assert.deepEqual(f.calls, [["login"]]);
      assert.equal(f.saves.length, 0);
    });
  }
});

test("a failed login clears the prior account and never displays an opened-window success", async (t) => {
  const f = await fixture(t, { loginError: "专用窗口暂时打不开" });
  await f.click("我已登录"); await f.click("切换账号");
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /专用窗口暂时打不开/u);
  assert.doesNotMatch(f.container.textContent, /已连接：|已打开|请在打开的窗口扫码/u);
  assert.equal(f.container.querySelector(".draft-sync-message"), null);
  assert.equal(f.button("同步到小红书草稿箱"), undefined);
  assert.equal(f.saves.length, 0);
});

test("a restored draft keeps the connected XHS account without inheriting an old task acknowledgement or retry permission", async (t) => {
  const f = await fixture(t);
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  await f.click(f.container.querySelector('input[type="checkbox"]')); await f.click("结束本次任务");
  await f.click(f.container.querySelector('input[type="checkbox"]'));
  assert.equal(f.button("同步到小红书草稿箱").disabled, false);
  const checksBeforeRestore = f.checks;
  const restored = { platform: "xiaohongshu", accountId: account.id, jobId: "restored-unconfirmed-job", status: "needs_confirmation", message: "恢复存档的任务待核对" };
  await f.replaceDraft({ receipts: [restored] });
  assert.match(f.container.textContent, /已连接：测试小红书账号/);
  assert.match(f.container.textContent, /恢复存档的任务待核对/);
  assert.doesNotMatch(f.container.textContent, /已结束本次任务|另存一份新草稿|图片 2 \/ 2 张/);
  assert.equal(f.container.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(f.button("结束本次任务").disabled, true);
  assert.equal(f.button("同步到小红书草稿箱").disabled, true);
  assert.equal(f.checks, checksBeforeRestore, "restoring content does not require checking the same account again");
  assert.equal(f.calls.filter(([action]) => action === "create").length, 1);

  await f.replaceDraft({ id: "restored-saved-draft", receipts: [{ ...restored, status: "saved", draftId: "another-saved-draft" }] });
  assert.match(f.container.textContent, /另存一份新草稿/);
  assert.equal(f.container.querySelector('input[type="checkbox"]').checked, false, "old retry permission does not carry into the next draft");
  assert.equal(f.button("同步到小红书草稿箱").disabled, true);
});

test("new XHS content clears stale errors while preserving the already connected account", async (t) => {
  const f = await fixture(t, { createError: "上一份内容响应中断" });
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.match(f.container.querySelector(".draft-sync-message").textContent, /上一份内容响应中断/);
  await f.click(f.container.querySelector('input[type="checkbox"]'));
  await f.replaceDraft();
  assert.match(f.container.textContent, /已连接：测试小红书账号/);
  assert.doesNotMatch(f.container.textContent, /上一份内容响应中断|我已检查草稿/);
  assert.equal(f.container.querySelector(".draft-sync-message"), null);
  assert.equal(f.button("同步到小红书草稿箱").disabled, false);
  assert.equal(f.calls.filter(([action]) => action === "create").length, 1);
});

test("only a verified saved service result is persisted as saved", async (t) => {
  const f = await fixture(t, { resultStatus: "saved" });
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.equal(f.saves[0].status, "needs_confirmation");
  assert.equal(f.draft.receipts[0].status, "saved"); assert.equal(f.draft.receipts[0].draftId, "verified-draft");
});

test("reading an in-progress XHS task waits for its final result without another user action", async (t) => {
  const pending = { platform: "xiaohongshu", accountId: account.id, jobId: "existing-job", status: "needs_confirmation", message: "保留的原任务" };
  const f = await fixture(t, { existingReceipt: pending, readStatus: "creating", resultStatus: "saved", waitResult: async () => {
    assert.equal(f.saves.length, 0, "an in-progress read must not persist an uncertain final result");
  } });
  await f.click("我已登录"); await f.click("读取小红书同步状态");
  assert.deepEqual(f.calls, [["read"]]);
  assert.deepEqual(f.waits, ["creating"]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.saves.length, 1);
  assert.equal(f.draft.receipts[0].status, "saved");
  assert.equal(f.draft.receipts[0].draftId, "verified-draft");
  assert.match(f.container.textContent, /同一草稿回读通过/u);
  assert.equal(f.button("结束本次任务"), undefined);
});

test("an account rejection from submission retains the receipt and cannot become saved or automatically resubmit", async (t) => {
  const f = await fixture(t, { createError: "专用浏览器登录账号与本机绑定不一致，请切回原账号" });
  await f.click("我已登录"); await f.click("同步到小红书草稿箱");
  assert.equal(f.checks, 1);
  const submissions = f.calls.filter(([action]) => action === "create");
  assert.equal(submissions.length, 1); assert.equal(submissions[0][1].accountId, account.id);
  assert.ok(f.saves.length > 0); assert.ok(f.saves.every((receipt) => receipt.status === "needs_confirmation"));
  assert.match(f.container.querySelector(".draft-sync-message").textContent, /绑定不一致/u);
  assert.equal(f.button("同步到小红书草稿箱").disabled, true);
});


test("a changed local device stops login and account checks without sending platform content", async (t) => {
  const f = await fixture(t, { wrongDevice: true });
  await f.click("打开登录窗口"); await f.click("我已登录");
  assert.equal(f.errors.length, 2);
  assert.ok(f.errors.every((error) => /不是原来绑定的电脑/.test(error.message)));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saves, []);
  assert.equal(f.button("同步到小红书草稿箱"), undefined);
});
