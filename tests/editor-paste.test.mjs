import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const require = createRequire(import.meta.url);
const { Editor } = require("@tiptap/core");
const { default: StarterKit } = require("@tiptap/starter-kit");
const { createPasteHandlers, createContentLimitExtension, preparePastedHtml } = loadDomModule("lib/richText/editorPaste.ts");
const { RICH_TEXT_LIMITS } = loadDomModule("lib/richText/normalizeRichHtml.ts");

function setup(t, content = "<p>原有正文</p>") {
  const notices = [];
  const onNotice = (text) => notices.push(text);
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, createContentLimitExtension(onNotice)],
    content,
    editorProps: { ...createPasteHandlers(onNotice), handleScrollToSelection: () => true },
  });
  t.after(() => editor.destroy());
  return { editor, notices };
}

function paste(editor, html, text = "") {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type) => type === "text/html" ? html : text } });
  editor.view.dom.dispatchEvent(event);
  return event;
}

test("oversized HTML is rejected before any DOMParser invocation and preserves the selection", (t) => {
  const { editor, notices } = setup(t);
  editor.commands.selectAll();
  const original = editor.getHTML();
  const RealParser = globalThis.DOMParser;
  let parses = 0;
  globalThis.DOMParser = class extends RealParser {
    parseFromString(...args) { parses += 1; return super.parseFromString(...args); }
  };
  try {
    assert.equal(paste(editor, "x".repeat(RICH_TEXT_LIMITS.htmlLength + 1)).defaultPrevented, true);
    assert.equal(parses, 0);
    assert.equal(editor.getHTML(), original);
    assert.match(notices[0], /100 万字符/);
  } finally { globalThis.DOMParser = RealParser; }
});

test("plain-text paste over the limit leaves existing content unchanged", (t) => {
  const { editor, notices } = setup(t);
  editor.commands.selectAll();
  paste(editor, "", "字".repeat(RICH_TEXT_LIMITS.textLength + 1));
  assert.equal(editor.getText(), "原有正文");
  assert.match(notices[0], /3 万字/);
});

test("deep wrappers are rejected before ProseMirror transforms the clipboard", (t) => {
  const { editor, notices } = setup(t);
  paste(editor, "<section>".repeat(RICH_TEXT_LIMITS.depth + 1) + "正文" + "</section>".repeat(RICH_TEXT_LIMITS.depth + 1));
  assert.equal(editor.getText(), "原有正文");
  assert.match(notices[0], /嵌套/);
});

test("repeated valid pastes cannot exceed the total document limit", async (t) => {
  const { editor, notices } = setup(t, "<p></p>");
  const html = `<p>${"文".repeat(16_000)}</p>`;
  paste(editor, html);
  assert.equal(editor.state.doc.textContent.length, 16_000);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  paste(editor, html);
  await Promise.resolve();
  assert.equal(editor.state.doc.textContent.length, 16_000);
  assert.match(notices.at(-1), /正文总量/);
});

test("replacing selected text uses the resulting total and remains undoable", (t) => {
  const { editor } = setup(t, `<p>${"旧".repeat(20_000)}</p>`);
  editor.commands.selectAll();
  paste(editor, `<p>${"新".repeat(20_000)}</p>`);
  assert.equal(editor.state.doc.textContent, "新".repeat(20_000));
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "旧".repeat(20_000));
});

test("spanning emphasis is counted once across changing inner marks", (t) => {
  const { editor, notices } = setup(t);
  const html = '<p><strong>甲<em>乙</em>丙</strong></p>'.repeat(501);
  preparePastedHtml(html);
  editor.commands.setContent(html);
  assert.equal(editor.state.doc.textContent, "甲乙丙".repeat(501));
  assert.equal(notices.length, 0);
});

test("a restored oversized draft can be reduced gradually but cannot grow", async (t) => {
  const { editor, notices } = setup(t, `<p>${"旧".repeat(31_000)}</p>`);
  editor.commands.deleteRange({ from: 1, to: 2 });
  assert.equal(editor.state.doc.textContent.length, 30_999);
  editor.commands.insertContent("新增");
  await Promise.resolve();
  assert.equal(editor.state.doc.textContent.length, 30_999);
  assert.match(notices.at(-1), /正文总量/);
});

test("validated external content stays synchronized even when schema marks expand it", (t) => {
  const { editor } = setup(t);
  const html = '<p><strong>甲<em>乙</em>丙</strong></p>'.repeat(501);
  const normalized = preparePastedHtml(html);
  editor.chain().setMeta("richTextExternalContent", true).setContent(normalized, { emitUpdate: false }).run();
  assert.equal(editor.state.doc.textContent, "甲乙丙".repeat(501));
});

test("programmatic invalid pasteHTML does not erase selected content", (t) => {
  const { editor, notices } = setup(t);
  editor.commands.selectAll();
  editor.view.pasteHTML(`<p>${"文".repeat(30_001)}</p>`, new dom.window.Event("paste"));
  assert.equal(editor.getText(), "原有正文");
  assert.match(notices[0], /3 万字/);
  paste(editor, "<p>下一次正常粘贴</p>");
  assert.equal(editor.getText(), "下一次正常粘贴");
});

test("clipboard normalization keeps emphasis, tables and backgrounds", () => {
  const html = preparePastedHtml('<section style="background:#fefefe;padding:12px;font-size:16px"><p><strong>重点</strong><span style="color:red;font-size:18px;line-height:2">正文</span></p><table><tr><td>数据</td></tr></table></section>');
  const parsed = new DOMParser().parseFromString(html, "text/html");
  assert.equal(parsed.querySelector("strong").textContent, "重点");
  assert.equal(parsed.querySelector("span").style.color, "red");
  assert.equal(parsed.querySelector("span").style.fontSize, "");
  assert.equal(parsed.querySelector("td p").textContent, "数据");
  assert.ok(parsed.querySelector("section").style.background);
});
