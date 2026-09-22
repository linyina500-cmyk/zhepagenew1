import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const { WechatRequestError } = loadDomModule("lib/wechat/client.ts");
const { parseLocalWechatConfig } = loadDomModule("lib/wechat/deviceVault.ts");
const resetText = "重置本机连接";
const confirmText = "确认清除本机公众号绑定";

async function fixture(context, { empty = false } = {}) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/WechatAccountManager.tsx", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const calls = []; let connection = async () => ({ deviceId: "old-device", busy: false }), disconnect = async () => {}, active;
  let currentBinding = { deviceId: "old-device", connectionToken: "old-token" }, currentAccounts = ["a", "b"].map((value) => ({ id: value.repeat(20), appId: `wx-${value}`, name: `公众号${value}` }));
  if (empty) { currentBinding = null; currentAccounts = []; }
  const client = { connectAccount: async (input) => { calls.push("connect-account"); return { id: "c".repeat(20), appId: input.appId, name: input.name }; }, getConnection: async () => { calls.push("connection"); return connection(); }, disconnectAccount: async (id) => { calls.push(`disconnect:${id}`); await disconnect(id); } };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => {
    if (specifier === "../../lib/wechat/client") return { createWechatClient: () => client, WechatRequestError };
    if (specifier === "../../lib/wechat/deviceVault") return {
      clearDeviceVault: async () => { calls.push("clear-vault"); },
      parseLocalWechatConfig,
      saveBinding: async () => { calls.push("save-binding"); },
      listAccounts: async () => currentAccounts,
      saveAccount: async (input) => {
        calls.push("save-account");
        const account = { id: "c".repeat(20), appId: input.appId, name: input.name };
        currentAccounts = [...currentAccounts, account];
        return account;
      },
    };
    return nativeRequire(specifier);
  }, loaded, loaded.exports);
  const Manager = loaded.exports.default, container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Host() {
    const [binding, setBinding] = React.useState(currentBinding), [accounts, setAccounts] = React.useState(currentAccounts), [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
    return React.createElement(React.Fragment, null, React.createElement(Manager, { binding, accounts, busy, onChange(next, items) { currentBinding = next; currentAccounts = items; setBinding(next); setAccounts(items); },
      runOperation: async (_label, operation) => { active = new AbortController(); setBusy(true); setError(""); try { await operation(active.signal); } catch (error) { if (!active.signal.aborted) setError(error.message); } finally { setBusy(false); } },
    }), React.createElement("p", { role: "alert" }, error));
  }
  await act(async () => root.render(React.createElement(Host)));
  async function click(text) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
    assert.ok(button, `visible action: ${text}`); assert.equal(button.disabled, false, `enabled action: ${text}`);
    await act(async () => button.click());
  }
  context.after(async () => { active?.abort(); await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  return { container, calls, click, act, get binding() { return currentBinding; }, get accounts() { return currentAccounts; }, set connection(value) { connection = value; }, set disconnect(value) { disconnect = value; },
    acknowledgeStopped: () => act(async () => { container.querySelector('[aria-label="清除本机公众号绑定"] input[type="checkbox"]').click(); }),
    abort: () => active.abort(),
    importConfig: async (contents) => {
      const input = container.querySelector('input[type="file"]');
      Object.defineProperty(input, "files", { configurable: true, value: [new File([contents], "config.env", { type: "text/plain" })] });
      await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    },
  };
}

test("recovery needs confirmation and disconnects every idle account before clearing only the vault", async (context) => {
  const f = await fixture(context); await f.click(resetText);
  assert.deepEqual(f.calls, []); assert.match(f.container.textContent, /海报、图片和同步记录会保留/);
  await f.click("取消清除"); assert.deepEqual(f.calls, []);
  await f.click(resetText); await f.click(confirmText);
  assert.deepEqual(f.calls, ["connection", `disconnect:${"a".repeat(20)}`, `disconnect:${"b".repeat(20)}`, "clear-vault"]);
  assert.equal(f.binding, null); assert.deepEqual(f.accounts, []);
});

test("an unreachable old connection requires explicit shutdown acknowledgment and a fresh check", async (context) => {
  const f = await fixture(context); f.connection = async () => { throw new WechatRequestError("旧口令失效", 401); };
  await f.click(resetText); await f.click(confirmText);
  assert.deepEqual(f.calls, ["connection"]); assert.match(f.container.textContent, /退出服务时清除/);
  const confirm = [...f.container.querySelectorAll("button")].find((button) => button.textContent === confirmText);
  assert.equal(confirm.disabled, true); assert.equal(f.accounts.length, 2);
  await f.acknowledgeStopped(); await f.click(confirmText);
  assert.deepEqual(f.calls, ["connection", "connection", "clear-vault"]); assert.equal(f.binding, null);
});

test("changed device identity follows the shutdown-confirmed recovery path", async (context) => {
  const f = await fixture(context); f.connection = async () => ({ deviceId: "new-device" });
  await f.click(resetText); await f.click(confirmText);
  assert.equal(f.calls.includes("clear-vault"), false);
  await f.acknowledgeStopped(); await f.click(confirmText);
  assert.equal(f.calls.at(-1), "clear-vault");
  assert.equal(f.calls.some((call) => call.startsWith("disconnect:")), false, "never disconnect an unrelated device");
});

test("known busy tasks block recovery even after the user acknowledged an offline service", async (context) => {
  const f = await fixture(context); f.connection = async () => { throw new Error("offline"); };
  await f.click(resetText); await f.click(confirmText); await f.acknowledgeStopped();
  f.connection = async () => ({ deviceId: "old-device", busy: true });
  await f.click(confirmText);
  assert.equal(f.calls.includes("clear-vault"), false); assert.match(f.container.textContent, /仍在处理任务/); assert.equal(f.accounts.length, 2);
});

test("a task becoming busy during disconnect cannot be treated as an offline bypass", async (context) => {
  const f = await fixture(context); f.disconnect = async () => { throw new WechatRequestError("仍在处理", 409); };
  await f.click(resetText); await f.click(confirmText);
  assert.equal(f.calls.includes("clear-vault"), false); assert.match(f.container.textContent, /仍在处理任务/);
  assert.equal(f.container.querySelector('[aria-label="清除本机公众号绑定"] input[type="checkbox"]'), null);
});

test("aborting a delayed recovery never performs a late local clear", async (context) => {
  const f = await fixture(context); let finish;
  f.connection = () => new Promise((resolve) => { finish = resolve; });
  await f.click(resetText); await f.click(confirmText); f.abort();
  await f.act(async () => finish({ deviceId: "old-device", busy: false }));
  assert.deepEqual(f.calls, ["connection"]); assert.equal(f.accounts.length, 2);
});


test("connection-only config imports without replacing or reconnecting saved accounts", async (context) => {
  const f = await fixture(context), originalAccounts = [...f.accounts];
  await f.importConfig("WECHAT_SYNC_TOKEN=imported-token\nWECHAT_HOST=127.0.0.1\nWECHAT_PORT=8788\nWECHAT_DATA_DIR=./data\n");
  assert.deepEqual(f.calls, ["connection", "save-binding"]);
  assert.deepEqual(f.binding, { deviceId: "old-device", connectionToken: "imported-token" });
  assert.deepEqual(f.accounts, originalAccounts);
  assert.match(f.container.querySelector('[role="status"]').textContent, /已保留此浏览器的 2 个公众号/);
  assert.equal(f.container.querySelector('[role="alert"]').textContent, "");
  assert.match(f.container.textContent, /当前浏览器、当前网址/);
});

test("connection-only config on a new browser connects and explains how to add an account", async (context) => {
  const f = await fixture(context, { empty: true });
  await f.importConfig("WECHAT_SYNC_TOKEN=imported-token\n");
  assert.deepEqual(f.calls, ["connection", "save-binding"]);
  assert.deepEqual(f.accounts, []);
  assert.match(f.container.querySelector('[role="status"]').textContent, /只包含连接信息，请在下方添加公众号/);
  assert.ok(f.container.querySelector("#wechat-account-appid"));
  assert.equal(f.container.querySelector('[role="alert"]').textContent, "");
});

test("a complete config imports its optional account after connecting the device", async (context) => {
  const f = await fixture(context, { empty: true });
  await f.importConfig("WECHAT_SYNC_TOKEN=imported-token\nWECHAT_APP_ID=wx-import-test\nWECHAT_APP_SECRET=imported-secret\nWECHAT_ACCOUNT_NAME='导入测试公众号'\n");
  assert.deepEqual(f.calls, ["connection", "save-binding", "connection", "save-account", "connect-account"]);
  assert.equal(f.accounts.length, 1);
  assert.deepEqual(f.accounts[0], { id: "c".repeat(20), appId: "wx-import-test", name: "导入测试公众号" });
  assert.match(f.container.querySelector('[role="status"]').textContent, /导入测试公众号 已保存在本机，并已连接/);
});

test("a partial account config fails before changing the connection or saved accounts", async (context) => {
  const f = await fixture(context), originalAccounts = [...f.accounts];
  await f.importConfig("WECHAT_SYNC_TOKEN=imported-token\nWECHAT_APP_ID=wx-import-test\n");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.accounts, originalAccounts);
  assert.equal(f.binding.connectionToken, "old-token");
  assert.notEqual(f.container.querySelector('[role="alert"]').textContent, "");
  assert.equal(f.container.querySelector('[role="status"]'), null);
});
