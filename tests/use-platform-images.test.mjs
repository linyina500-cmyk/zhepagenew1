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
    renderRiskPage: (note, source, signal) => new Promise((resolve, reject) => { riskCalls.push({ note, source, signal, resolve, reject }); }),
  } : nativeRequire(specifier), loaded, loaded.exports);
  const { usePlatformImages } = loaded.exports;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let latest, mounted = true;
  // eslint-disable-next-line react/prop-types -- Only this test fixture supplies these controlled hook inputs.
  function Host({ source, platform, visible = "wechat", note, confirmed }) {
    const result = usePlatformImages(source, platform, note, confirmed);
    latest = result; renders.push({ source, platform, result });
    return React.createElement("output", null, visible);
  }
  async function render(source, platform = "wechat", visible, note, confirmed) { await act(async () => root.render(React.createElement(Host, { source, platform, visible, note, confirmed }))); }
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
const withTemplate = (id) => ({ ...image(id), riskTemplate: { svg: "<svg/>" } });

test("risk waits for confirmation and replaces only the existing last page", async (t) => {
  const f = await fixture(t), source = [image("body"), withTemplate("last")], adapted = [image("body-adapted"), image("last-adapted")];
  await f.render(source, "wechat", "wechat", note, false);
  await f.act(async () => f.calls[0].resolve(adapted));
  assert.equal(f.riskCalls.length, 0); assert.equal(f.latest.images, adapted);
  await f.render(source, "wechat", "wechat", note, true);
  assert.equal(f.latest.preparing, true); assert.equal(f.riskCalls[0].source, source[1]);
  const rendered = withTemplate("last");
  await f.act(async () => f.riskCalls[0].resolve(rendered));
  assert.deepEqual(f.calls[1].source, [rendered]);
  await f.act(async () => f.calls[1].resolve([image("last-final")]));
  assert.deepEqual(f.latest.images.map(x => x.id), ["body-adapted", "last-final"]);
  assert.equal(f.latest.images[0], adapted[0]); assert.equal(f.latest.images.length, source.length);
  const confirmed = f.latest.images;
  await f.render(source, "wechat", "xiaohongshu", note, true);
  assert.equal(f.latest.images, confirmed);
});

test("editing risk cancels rendering and waits for a fresh confirmation", async (t) => {
  const f = await fixture(t), source = [withTemplate("last")], adapted = [image("base")], revised = { ...note, text: "新版" };
  await f.render(source, "wechat", "wechat", note, true);
  await f.act(async () => f.calls[0].resolve(adapted));
  await f.render(source, "wechat", "wechat", revised, false);
  assert.equal(f.riskCalls[0].signal.aborted, true); assert.equal(f.latest.images, adapted);
  await f.act(async () => f.riskCalls[0].resolve(withTemplate("stale")));
  assert.equal(f.calls.length, 1); assert.equal(f.riskCalls.length, 1);
  await f.render(source, "wechat", "wechat", revised, true);
  assert.equal(f.riskCalls[1].note, revised);
  await f.act(async () => f.riskCalls[1].resolve(withTemplate("fresh")));
  await f.act(async () => f.calls[1].resolve([image("fresh-final")]));
  assert.equal(f.latest.images.at(-1).id, "fresh-final");
});

test("overflow blocks upload, and disabling risk redraws the same last page", async (t) => {
  const f = await fixture(t), source = [withTemplate("last")];
  await f.render(source, "wechat", "wechat", note, true);
  await f.act(async () => f.calls[0].resolve([image("base")]));
  await f.act(async () => f.riskCalls[0].reject(new Error("风险提示超出末页")));
  assert.equal(f.latest.images, null); assert.match(f.latest.error, /超出末页/);
  const disabled = { ...note, enabled: false };
  await f.render(source, "wechat", "wechat", disabled, false);
  assert.equal(f.riskCalls.length, 1);
  await f.render(source, "wechat", "wechat", disabled, true);
  assert.equal(f.riskCalls[1].note.enabled, false);
  await f.act(async () => f.riskCalls[1].resolve(withTemplate("without-risk")));
  await f.act(async () => f.calls[1].resolve([image("last-no-risk")]));
  assert.equal(f.latest.images.length, 1);
});

test("missing editable source fails clearly without adding a synthetic risk page", async (t) => {
  const f = await fixture(t);
  await f.render([image("raster")], "wechat", "wechat", note, true);
  await f.act(async () => f.calls[0].resolve([image("base")]));
  assert.match(f.latest.error, /没有可编辑的末页/); assert.equal(f.latest.images, null);
  assert.equal(f.riskCalls.length, 0);
});
