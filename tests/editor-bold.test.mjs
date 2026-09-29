import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

async function mount(t, html) {
  const dom = installDom();
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  // JSDOM has no layout; these tests assert real transactions and markup.
  // Browser tests below separately inspect computed weights and export SVGs.
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const require = createRequire(import.meta.url);
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const Component = loadDomModule("app/components/ZhepageEditor.tsx").default;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container), changes = [];
  await React.act(async () => {
    root.render(React.createElement(Component, { html, revision: 0, accentColor: "#cc2244", highlightColor: "#ffeebb", onChange: (value) => changes.push(value), onNotice() {} }));
  });
  t.after(async () => { await React.act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = previous; });
  const editor = container.querySelector(".tiptap-surface").editor;
  const run = async (action) => React.act(async () => { action(editor); });
  const click = async (tooltip) => React.act(async () => { container.querySelector(`button[data-tooltip^="${tooltip}"]`).click(); });
  const select = async (text) => run((current) => {
    let range;
    current.state.doc.descendants((node, pos) => {
      if (!range && node.isText && node.text.includes(text)) {
        const from = pos + node.text.indexOf(text);
        range = { from, to: from + text.length };
      }
    });
    assert.ok(range, `text selection must exist: ${text}`);
    current.commands.setTextSelection(range);
  });
  return { editor, run, click, select, changes, container };
}

function boldText(editor) {
  let text = "";
  editor.state.doc.descendants((node) => { if (node.isText && node.marks.some((mark) => mark.type.name === "bold")) text += node.text; });
  return text;
}

for (const html of [
  "<p><strong>重点</strong></p>", "<p><b>重点</b></p>",
  '<p><span style="font-weight:600">重点</span></p>',
  '<p><span style="font-weight:700">重点</span></p>',
  '<p><span style="font-weight:bold">重点</span></p>',
  '<p style="font-weight:600">重点</p>',
  '<section style="font-weight:bold"><p>重点</p></section>',
]) {
  test(`imported bold can be toggled off without residual font-weight: ${html}`, async (t) => {
    const f = await mount(t, html);
    await f.select("重点");
    assert.equal(f.editor.isActive("bold"), true);
    await f.click("粗体");
    assert.equal(boldText(f.editor), "");
    assert.doesNotMatch(f.editor.getHTML(), /font-weight|<strong|<b[ >]/);
    assert.equal(f.editor.getText().trim(), "重点");
    await f.click("撤销上一步");
    assert.equal(boldText(f.editor), "重点");
    await f.click("重做");
    assert.equal(boldText(f.editor), "");
  });
}

test("partial removal of inherited block bold preserves both unselected sides and can be undone", async (t) => {
  const f = await mount(t, '<section style="font-weight:700;background-color:gold"><p>前中后</p></section>');
  await f.select("中");
  await f.click("粗体");
  assert.equal(boldText(f.editor), "前后");
  assert.match(f.editor.getHTML(), /background-color: gold/);
  assert.doesNotMatch(f.editor.getHTML(), /font-weight/);
  await f.click("撤销上一步");
  assert.equal(boldText(f.editor), "前中后");
});

test("normal and 400 weights inside bold remain normal, and mixed selection toggles all then clears all", async (t) => {
  const f = await mount(t, '<p><strong>甲<span style="font-weight:normal">乙</span><span style="font-weight:400">丙</span>丁</strong></p>');
  assert.equal(boldText(f.editor), "甲丁");
  await f.run((editor) => editor.commands.selectAll());
  assert.equal(f.editor.isActive("bold"), false);
  await f.click("粗体");
  assert.equal(boldText(f.editor), "甲乙丙丁");
  await f.click("粗体");
  assert.equal(boldText(f.editor), "");
  await f.click("撤销上一步");
  assert.equal(boldText(f.editor), "甲乙丙丁");
  await f.click("撤销上一步");
  assert.equal(boldText(f.editor), "甲丁");
});

for (const tag of ["span", "strong", "b"]) {
  test(`bold changes preserve independent color and background imported on ${tag}`, async (t) => {
    const f = await mount(t, `<p><${tag} style="font-weight:700;color:#cc2244;background-color:#ffeebb">重点</${tag}></p>`);
    // Rich-text import serializes the compact editor and reparses into the
    // main editor. Check that the resulting nested marks retain their color.
    await f.run((editor) => editor.commands.setContent(editor.getHTML()));
    await f.select("重点");
    await f.click("粗体");
    assert.equal(boldText(f.editor), "");
    assert.equal(f.editor.getAttributes("textStyle").color, "rgb(204, 34, 68)");
    assert.match(f.editor.getHTML(), /background-color: rgb\(255, 238, 187\)/);
    await f.run((editor) => editor.commands.setColor("#2457a7"));
    assert.equal(f.editor.getAttributes("textStyle").color, "#2457a7");
    assert.doesNotMatch(f.editor.getHTML(), /204, 34, 68|cc2244/);
  });
}

test("400-weight text can become bold, clear formatting, and undo without losing its characters", async (t) => {
  const f = await mount(t, '<p><span style="font-weight:400;color:red;background-color:gold">普通文字</span></p>');
  await f.select("普通文字");
  await f.click("粗体");
  assert.equal(boldText(f.editor), "普通文字");
  assert.doesNotMatch(f.editor.getHTML(), /font-weight/);
  await f.click("清除选中文字");
  assert.equal(f.editor.getHTML(), "<p>普通文字</p>");
  await f.click("撤销上一步");
  assert.equal(boldText(f.editor), "普通文字");
  assert.match(f.editor.getHTML(), /color: red/);
});

test("explicit normal weight on strong and b does not become bold on import", async (t) => {
  const f = await mount(t, '<p><strong style="font-weight:normal">普通</strong><b style="font-weight:400">正文</b></p>');
  assert.equal(boldText(f.editor), "");
  assert.doesNotMatch(f.editor.getHTML(), /font-weight/);
  await f.run((editor) => editor.commands.selectAll());
  await f.click("粗体");
  assert.equal(boldText(f.editor), "普通正文");
});

test("a styled strong inside a normal colored span retains its own bold and inherited color after import roundtrip", async (t) => {
  const f = await mount(t, '<p><span style="font-weight:400;color:blue"><strong style="background-color:gold">强调</strong></span></p>');
  assert.equal(boldText(f.editor), "强调");
  await f.run((editor) => editor.commands.setContent(editor.getHTML()));
  await f.select("强调");
  assert.equal(boldText(f.editor), "强调");
  assert.equal(f.editor.getAttributes("textStyle").color, "blue");
  await f.click("粗体");
  assert.equal(boldText(f.editor), "");
  assert.equal(f.editor.getAttributes("textStyle").color, "blue");
  assert.match(f.editor.getHTML(), /background-color: gold/);
});
