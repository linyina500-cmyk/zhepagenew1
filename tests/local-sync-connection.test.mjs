import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const { WechatRequestError } = loadDomModule("lib/wechat/client.ts");
const resetText = "重置本机连接";
const confirmText = "确认清除本机连接";

async function fixture(context, { empty = false } = {}) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/LocalSyncConnection.tsx", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const calls = [], events = []; let pairing = async () => ({ deviceId: "old-device", connectionToken: "paired-token" }), connection = async () => ({ deviceId: "old-device", busy: false }), disconnect = async () => {}, active;
  let currentBinding = { deviceId: "old-device", connectionToken: "old-token" }, currentAccounts = ["a", "b"].map((value) => ({ id: value.repeat(20), appId: `wx-${value}`, name: `公众号${value}` }));
  if (empty) { currentBinding = null; currentAccounts = []; }
  const client = { connectAccount: async (input) => { calls.push("connect-account"); return { id: "c".repeat(20), appId: input.appId, name: input.name }; }, getConnection: async () => { calls.push("connection"); return connection(); }, disconnectAccount: async (id) => { calls.push(`disconnect:${id}`); await disconnect(id); } };
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => {
    if (specifier === "../../lib/wechat/client") return { createWechatClient: () => client, WechatRequestError };
    if (specifier === "../../lib/wechat/deviceVault") return {
      clearDeviceVault: async () => { calls.push("clear-vault"); },
      saveBinding: async () => { calls.push("save-binding"); },
      listAccounts: async () => currentAccounts,

    };
    if (specifier === "../../lib/localSync/connection") return {
      beginLocalSyncConnection: () => {
        events.push("begin");
        calls.push("begin-connection");
        return { connect: async (signal) => { calls.push("connect-local"); return pairing(signal); }, close: () => { calls.push("close-popup"); } };
      },
    };
    return nativeRequire(specifier);
  }, loaded, loaded.exports);
  const Manager = loaded.exports.default, container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Host() {
    const [binding, setBinding] = React.useState(currentBinding), [accounts, setAccounts] = React.useState(currentAccounts), [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
    return React.createElement(React.Fragment, null, React.createElement(Manager, { binding, accounts, busy, onChange(next, items) { currentBinding = next; currentAccounts = items; setBinding(next); setAccounts(items); },
      runOperation: async (_label, operation) => { events.push("run"); active = new AbortController(); setBusy(true); setError(""); try { await operation(active.signal); } catch (error) { if (!active.signal.aborted) setError(error.message); } finally { setBusy(false); } },
    }), React.createElement("p", { role: "alert" }, error));
  }
  await act(async () => root.render(React.createElement(Host)));
  async function click(text) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
    assert.ok(button, `visible action: ${text}`); assert.equal(button.disabled, false, `enabled action: ${text}`);
    await act(async () => button.click());
  }
  context.after(async () => { active?.abort(); await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  return { container, calls, events, click, act, set pairing(value) { pairing = value; }, get binding() { return currentBinding; }, get accounts() { return currentAccounts; }, set connection(value) { connection = value; }, set disconnect(value) { disconnect = value; },
    acknowledgeStopped: () => act(async () => { container.querySelector('[aria-label="清除本机连接"] input[type="checkbox"]').click(); }),
    abort: () => active.abort(),

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
  assert.equal(f.container.querySelector('[aria-label="清除本机连接"] input[type="checkbox"]'), null);
});

test("aborting a delayed recovery never performs a late local clear", async (context) => {
  const f = await fixture(context); let finish;
  f.connection = () => new Promise((resolve) => { finish = resolve; });
  await f.click(resetText); await f.click(confirmText); f.abort();
  await f.act(async () => finish({ deviceId: "old-device", busy: false }));
  assert.deepEqual(f.calls, ["connection"]); assert.equal(f.accounts.length, 2);
});


test("one-click connection opens the popup synchronously and preserves saved accounts", async (context) => {
  const f = await fixture(context), originalAccounts = [...f.accounts];
  await f.click("连接这台电脑");
  assert.deepEqual(f.events.slice(0, 2), ["begin", "run"]);
  assert.deepEqual(f.calls, ["begin-connection", "connect-local", "save-binding", "close-popup"]);
  assert.deepEqual(f.binding, { deviceId: "old-device", connectionToken: "paired-token" });
  assert.deepEqual(f.accounts, originalAccounts);
  assert.match(f.container.querySelector('[role="status"]').textContent, /连接/);
  assert.equal(f.container.querySelector('[role="alert"]').textContent, "");
});

test("the first connection has no credential or file fields", async (context) => {
  const f = await fixture(context, { empty: true });
  const button = [...f.container.querySelectorAll("button")].find((node) => node.textContent === "连接这台电脑");
  assert.ok(button.classList.contains("primary"));
  assert.equal(f.container.querySelector("input"), null);
  assert.match(f.container.textContent, /共用此连接/);
  assert.doesNotMatch(f.container.textContent, /config\.env|WECHAT_SYNC_TOKEN|连接口令/);
  assert.equal(f.container.querySelector(".draft-sync-connection-help").open, false);
  assert.deepEqual(f.calls, []);
});

test("saved connection is compact and its settings stay collapsed", async (context) => {
  const f = await fixture(context);
  assert.equal(f.container.querySelector(".draft-sync-connection-saved strong").textContent, "本机连接已保存");
  const settings = f.container.querySelector(".draft-sync-connection-saved details");
  assert.equal(settings.querySelector("summary").textContent, "连接设置");
  assert.equal(settings.open, false);
  assert.equal(f.container.querySelector("input"), null);
  assert.equal(f.container.textContent.includes("old-token"), false);
});

test("cancelled pairing closes its window without changing browser credentials", async (context) => {
  const f = await fixture(context); let finish;
  f.pairing = () => new Promise((resolve) => { finish = resolve; });
  await f.click("连接这台电脑"); f.abort();
  await f.act(async () => finish({ deviceId: "old-device", connectionToken: "late-token" }));
  assert.equal(f.calls.includes("save-binding"), false);
  assert.equal(f.calls.at(-1), "close-popup");
  assert.equal(f.binding.connectionToken, "old-token");
});

test("pairing failures close the popup and surface a useful error without saving", async (context) => {
  const f = await fixture(context);
  f.pairing = async () => { throw new Error("请先打开本机同步工具，再试一次。"); };
  await f.click("连接这台电脑");
  assert.equal(f.calls.includes("save-binding"), false);
  assert.equal(f.calls.at(-1), "close-popup");
  assert.match(f.container.querySelector('[role="alert"]').textContent, /打开本机同步工具/);
});

test("pairing errors appear inside the connection region and the button permits a retry", async (context) => {
  const f = await fixture(context, { empty: true });
  f.pairing = async () => { throw new Error("请允许弹出连接窗口，然后再试一次。"); };
  await f.click("连接这台电脑");
  assert.match(f.container.querySelector('.draft-sync-connection [role="alert"]').textContent, /允许弹出连接窗口/);
  assert.equal(f.calls.includes("save-binding"), false);
  f.pairing = async () => ({ deviceId: "old-device", connectionToken: "paired-token" });
  await f.click("连接这台电脑");
  assert.equal(f.container.querySelector('.draft-sync-connection [role="alert"]'), null);
  assert.equal(f.binding.connectionToken, "paired-token");
  assert.equal(f.calls.filter((call) => call === "close-popup").length, 2);
});
