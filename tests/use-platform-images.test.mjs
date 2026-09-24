import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom } from "./helpers/load-dom-module.mjs";

const image = (id) => Object.freeze({ id, name: `${id}.png`, blob: new Blob([id]), width: 1080, height: 1440 });
async function fixture(t) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/hooks/usePlatformImages.ts", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const calls = [], riskCalls = [], renders = [];
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => specifier === "../../lib/draftSync/adaptImages" ? {
    adaptDraftImages: (source, platform, signal) => new Promise((resolve, reject) => { calls.push({ source, platform, signal, resolve, reject }); }),
  } : specifier === "../../lib/draftSync/riskPage" ? {
    renderRiskPage: (note, appearance, platform, signal) => new Promise((resolve, reject) => { riskCalls.push({ note, appearance, platform, signal, resolve, reject }); }),
  } : nativeRequire(specifier), loaded, loaded.exports);
  const { usePlatformImages } = loaded.exports;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let latest, mounted = true;
  // eslint-disable-next-line react/prop-types -- Only this test fixture supplies these controlled hook inputs.
  function Host({ source, platform, visible = "wechat", note, appearance }) {
    const result = usePlatformImages(source, platform, note, appearance);
    latest = result; renders.push({ source, platform, result });
    return React.createElement("output", null, visible);
  }
  async function render(source, platform = "wechat", visible, note, appearance) { await act(async () => root.render(React.createElement(Host, { source, platform, visible, note, appearance }))); }
  async function unmount() { if (mounted) { mounted = false; await act(async () => root.unmount()); } }
  t.after(async () => { await unmount(); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  return { calls, riskCalls, renders, render, unmount, act, get latest() { return latest; } };
}

test("undefined sources stay idle and adapting does not mutate original images", async (t) => {
  const f = await fixture(t); await f.render(undefined);
  assert.deepEqual(f.latest, { images: null, preparing: false, error: "" }); assert.equal(f.calls.length, 0);
  const source = Object.freeze([image("one"), image("two")]), result = [image("adapted-one"), image("adapted-two")];
  await f.render(source);
  assert.deepEqual(f.latest, { images: null, preparing: true, error: "" });
  assert.equal(f.calls[0].source, source); assert.equal(f.calls[0].platform, "wechat");
  await f.act(async () => f.calls[0].resolve(result));
  assert.deepEqual(f.latest, { images: result, preparing: false, error: "" });
  assert.deepEqual(source.map(({ id }) => id), ["one", "two"]);
});

test("a changed source hides an old completed result during its very first render", async (t) => {
  const f = await fixture(t), first = [image("first")], second = [image("second")], output = [image("first-adapted")];
  await f.render(first); await f.act(async () => f.calls[0].resolve(output));
  const start = f.renders.length;
  await f.render(second);
  assert.deepEqual(f.renders[start].result, { images: null, preparing: true, error: "" });
  assert.equal(f.calls[0].signal.aborted, true);
  await f.act(async () => f.calls[1].resolve([image("second-adapted")]));
  assert.equal(f.latest.images[0].id, "second-adapted");
});

test("cancelled work cannot replace newer images even if adaptation ignores abort", async (t) => {
  const f = await fixture(t); await f.render([image("old")]); await f.render([image("new")]);
  await f.act(async () => f.calls[1].resolve([image("new-output")]));
  await f.act(async () => f.calls[0].resolve([image("late-old-output")]));
  assert.equal(f.latest.images[0].id, "new-output"); assert.equal(f.latest.error, "");
});

test("platform changes hide old proportions and cancellation never replaces current errors", async (t) => {
  const f = await fixture(t), source = [image("one")];
  await f.render(source, "wechat"); await f.render(source, "xiaohongshu");
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].platform, "xiaohongshu");
  await f.act(async () => f.calls[1].reject(new Error("第 1 张图片无法读取")));
  assert.deepEqual(f.latest, { images: null, preparing: false, error: "第 1 张图片无法读取" });
  await f.act(async () => f.calls[0].reject(new Error("过期错误")));
  assert.equal(f.latest.error, "第 1 张图片无法读取");
});

test("display changes preserve the completed result without re-adapting", async (t) => {
  const f = await fixture(t), source = [image("one")], output = [image("adapted")];
  await f.render(source, "wechat", "wechat"); await f.act(async () => f.calls[0].resolve(output));
  await f.render(source, "wechat", "xiaohongshu"); await f.render(source, "wechat", "wechat");
  assert.deepEqual(f.latest.images, output); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, false);
});

test("removing the source and unmounting abort pending work and discard late results", async (t) => {
  const f = await fixture(t); await f.render([image("one")]); await f.render(undefined);
  assert.equal(f.calls[0].signal.aborted, true); assert.deepEqual(f.latest, { images: null, preparing: false, error: "" });
  await f.act(async () => f.calls[0].resolve([image("late")]));
  assert.deepEqual(f.latest, { images: null, preparing: false, error: "" });
  await f.render([image("two")]); await f.unmount();
  const count = f.renders.length;
  assert.equal(f.calls[1].signal.aborted, true);
  await f.act(async () => f.calls[1].resolve([image("late-unmounted")]));
  assert.equal(f.renders.length, count);
});

const note = { enabled: true, title: "风险提示", text: "仅供学习。" };
const appearance = { paperColor: "#fff", textColor: "#111", accentColor: "#333", fontFamily: "sans-serif", footerText: "页脚" };

test("risk images are appended last and display-only changes retain the confirmation array", async (t) => {
  const f = await fixture(t), source = [image("original")], adapted = [image("adapted")], risk = image("risk");
  await f.render(source, "wechat", "wechat", note, appearance);
  await f.act(async () => f.calls[0].resolve(adapted));
  assert.equal(f.latest.images, null); assert.equal(f.latest.preparing, true);
  assert.equal(f.riskCalls[0].note, note); assert.equal(f.riskCalls[0].appearance, appearance); assert.equal(f.riskCalls[0].platform, "wechat");
  await f.act(async () => f.riskCalls[0].resolve(risk));
  assert.deepEqual(f.latest.images, [adapted[0], risk]); assert.equal(adapted.length, 1);
  const confirmed = f.latest.images;
  await f.render(source, "wechat", "xiaohongshu", note, appearance);
  assert.equal(f.latest.images, confirmed); assert.equal(f.calls.length, 1);
});

test("editing platform risk invalidates images immediately and discards late old risk pages", async (t) => {
  const f = await fixture(t), source = [image("original")], updated = { ...note, text: "新版风险提示。" };
  await f.render(source, "wechat", "wechat", note, appearance);
  await f.act(async () => f.calls[0].resolve([image("adapted")]));
  const before = f.renders.length;
  await f.render(source, "wechat", "wechat", updated, appearance);
  assert.deepEqual(f.renders[before].result, { images: null, preparing: true, error: "" });
  assert.equal(f.riskCalls[0].signal.aborted, true);
  assert.equal(f.calls.length, 1, "editing risk reuses already adapted base images");
  await f.act(async () => f.riskCalls[1].resolve(image("new-risk")));
  const latest = f.latest.images;
  await f.act(async () => f.riskCalls[0].resolve(image("old-risk")));
  assert.equal(f.latest.images, latest); assert.equal(latest.at(-1).id, "new-risk");
  await f.render(source, "wechat", "wechat", updated, { ...appearance, textColor: "#000" });
  assert.equal(f.latest.images, null); assert.equal(f.latest.preparing, true);
});

test("risk rendering errors block the complete set and disabled risk does not render an extra page", async (t) => {
  const f = await fixture(t), source = [image("original")];
  await f.render(source, "wechat", "wechat", note, appearance);
  await f.act(async () => f.calls[0].resolve([image("adapted")]));
  await f.act(async () => f.riskCalls[0].reject(new Error("风险提示过长，无法完整显示。")));
  assert.equal(f.latest.images, null); assert.equal(f.latest.preparing, false); assert.match(f.latest.error, /风险提示过长/);
  await f.render(source, "wechat", "wechat", { ...note, enabled: false }, appearance);
  assert.equal(f.latest.images[0].id, "adapted"); assert.equal(f.latest.images.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.riskCalls.length, 1);
});

test("risk edits during base adaptation do not restart encoding and use only the latest note", async (t) => {
  const f = await fixture(t), source = [image("original")], revised = { ...note, text: "最终提示" };
  await f.render(source, "wechat", "wechat", note, appearance);
  await f.render(source, "wechat", "wechat", revised, appearance);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, false);
  await f.act(async () => f.calls[0].resolve([image("adapted")]));
  assert.equal(f.riskCalls.length, 1); assert.equal(f.riskCalls[0].note, revised);
  await f.act(async () => f.riskCalls[0].resolve(image("latest-risk")));
  assert.equal(f.latest.images.at(-1).id, "latest-risk");
});
