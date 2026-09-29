import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom } from "./helpers/load-dom-module.mjs";

async function fixture(context, { empty = false, unbound = false, busy = false } = {}) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/WechatAccountManager.tsx", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const calls = []; let connection = async () => ({ deviceId: "local-device", busy: false }), active, addedId;
  const binding = unbound ? null : { deviceId: "local-device", connectionToken: "private-token" };
  let accounts = empty ? [] : ["a", "b"].map((value) => ({ id: value.repeat(20), appId: `wx-${value}`, name: `公众号${value}` }));
  const client = {
    getConnection: async () => { calls.push("connection"); return connection(); },
    connectAccount: async () => { calls.push("connect-account"); },
    disconnectAccount: async (id) => { calls.push(`disconnect:${id}`); },
  };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => {
    if (specifier === "../../lib/wechat/client") return { createWechatClient: () => client };
    if (specifier === "../../lib/wechat/deviceVault") return {
      listAccounts: async () => accounts,
      saveAccount: async (input) => { calls.push("save-account"); const account = { id: "c".repeat(20), appId: input.appId, name: input.name }; accounts = [...accounts, account]; return account; },
      removeAccount: async (id) => { calls.push(`remove:${id}`); accounts = accounts.filter((account) => account.id !== id); },
    };
    return nativeRequire(specifier);
  }, loaded, loaded.exports);
  const Manager = loaded.exports.default, container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Host() {
    const [items, setItems] = React.useState(accounts), [working, setWorking] = React.useState(busy), [error, setError] = React.useState("");
    return React.createElement(React.Fragment, null, React.createElement(Manager, { binding, accounts: items, busy: working, onChange(nextBinding, nextAccounts, nextId) { assert.deepEqual(nextBinding, binding); accounts = nextAccounts; addedId = nextId; setItems(nextAccounts); },
      runOperation: async (_label, operation) => { active = new AbortController(); setWorking(true); setError(""); try { await operation(active.signal); } catch (error) { if (!active.signal.aborted) setError(error.message); } finally { setWorking(false); } },
    }), React.createElement("p", { role: "alert" }, error));
  }
  await act(async () => root.render(React.createElement(Host)));
  const button = (text) => [...container.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === text);
  context.after(async () => { active?.abort(); await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  return { container, calls, button, act, get accounts() { return accounts; }, get addedId() { return addedId; }, set connection(value) { connection = value; },
    click: async (text) => { const node = button(text); assert.ok(node); assert.equal(node.disabled, false); await act(async () => node.click()); },
    fill: async (id, value) => { const input = container.querySelector(`#${id}`); await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); },
    submit: () => act(async () => container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))),
    abort: () => active.abort(),
  };
}

test("account manager only presents account settings and defaults existing accounts to collapsed", async (context) => {
  const f = await fixture(context);
  const details = f.container.querySelector("details");
  assert.equal(details.open, false); assert.equal(details.querySelector("summary").textContent, "管理公众号");
  assert.equal(f.container.querySelector('input[type="file"]'), null);
  assert.equal(f.container.querySelector("#wechat-connection-password"), null);
  assert.doesNotMatch(f.container.textContent, /重置本机连接|选择连接文件|private-token/);
});

test("new account form is open and reports the added id after saving and connecting", async (context) => {
  const f = await fixture(context, { empty: true });
  assert.equal(f.container.querySelector("details").open, true);
  await f.fill("wechat-account-name", "新增测试公众号"); await f.fill("wechat-account-appid", "wx-add-test"); await f.fill("wechat-account-secret", "private-account-secret");
  assert.equal(f.button("保存并连接公众号").disabled, false);
  await f.submit();
  assert.deepEqual(f.calls, ["connection", "save-account", "connect-account"]);
  assert.equal(f.accounts[0].name, "新增测试公众号"); assert.equal(f.addedId, "c".repeat(20));
  assert.equal(f.container.querySelector("#wechat-account-secret").value, "");
});

test("removing an account disconnects the current device before removing browser credentials", async (context) => {
  const f = await fixture(context); await f.click("移除 公众号a");
  assert.deepEqual(f.calls, ["connection", `disconnect:${"a".repeat(20)}`, `remove:${"a".repeat(20)}`]);
  assert.deepEqual(f.accounts.map((account) => account.name), ["公众号b"]);
});

test("changed device identity blocks removal without clearing an account", async (context) => {
  const f = await fixture(context); f.connection = async () => ({ deviceId: "other-device" });
  await f.click("移除 公众号a");
  assert.deepEqual(f.calls, ["connection"]); assert.equal(f.accounts.length, 2); assert.match(f.container.querySelector('[role="alert"]').textContent, /设备已改变/);
});

test("aborted device checks never cause a late removal", async (context) => {
  const f = await fixture(context); let finish;
  f.connection = () => new Promise((resolve) => { finish = resolve; });
  await f.click("移除 公众号a"); f.abort();
  await f.act(async () => finish({ deviceId: "local-device" }));
  assert.deepEqual(f.calls, ["connection"]); assert.equal(f.accounts.length, 2);
});

test("busy account controls are disabled", async (context) => {
  const f = await fixture(context, { busy: true });
  for (const button of f.container.querySelectorAll("button")) assert.equal(button.disabled, true);
});


test("an unbound manager does not offer account actions", async (context) => {
  const f = await fixture(context, { unbound: true });
  assert.equal(f.container.querySelector("details"), null);
  assert.equal(f.container.querySelector("button"), null);
  assert.deepEqual(f.calls, []);
});
