import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const require = createRequire(import.meta.url);
const { Editor, Extension } = require("@tiptap/core");
const { Plugin } = require("@tiptap/pm/state");
const { default: StarterKit } = require("@tiptap/starter-kit");
const { default: Image } = require("@tiptap/extension-image");
const { createPasteHandlers, createContentLimitExtension, preparePastedHtml } = loadDomModule("lib/richText/editorPaste.ts");
const { RICH_TEXT_LIMITS, IMAGE_LIMITS } = loadDomModule("lib/richText/normalizeRichHtml.ts");
const { insertImageFiles } = loadDomModule("lib/richText/editorImages.ts");

function setup(t, content = "<p>原有正文</p>", extensions = []) {
  const notices = [];
  const noticeEvents = [];
  const onNotice = (text, tone) => { notices.push(text); noticeEvents.push({ text, tone }); };
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, Image.configure({ allowBase64: true }), createContentLimitExtension(onNotice), ...extensions],
    content,
    editorProps: { ...createPasteHandlers(onNotice), handleScrollToSelection: () => true },
  });
  t.after(() => editor.destroy());
  return { editor, notices, noticeEvents, onNotice };
}

function paste(editor, html, text = "", files = []) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    getData: (type) => type === "text/html" ? html : type === "text/plain" ? text : "",
    files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    types: [...(html ? ["text/html"] : []), ...(text ? ["text/plain"] : []), ...(files.length ? ["Files"] : [])],
  } });
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

const PNG_HEADER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tm0AAAAASUVORK5CYII=", "base64");
function pngFile(size = PNG_HEADER.length, name = "screenshot.png") {
  return new dom.window.File([PNG_HEADER, new Uint8Array(Math.max(0, size - PNG_HEADER.length))], name, { type: "image/png" });
}
function imageDataUrl(size) {
  return `data:image/png;base64,${Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, size - PNG_HEADER.length))]).toString("base64")}`;
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function imageNodes(doc) {
  const images = [];
  doc.descendants((node) => { if (node.type.name === "image") images.push(node); });
  return images;
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(predicate(), message);
}
function assertRejectedImage(noticeEvents) {
  assert.ok(noticeEvents.some(({ tone }) => tone === "error"), "an unsuccessful image insertion must explain the failure");
  assert.equal(noticeEvents.some(({ tone }) => tone === "success"), false, "a rejected insertion must never report success");
}

test("an 800 KiB FileReader image can be inserted without consuming the article markup budget", async (t) => {
  const { editor, notices } = setup(t);
  const src = await readImage(pngFile(800 * 1024));
  assert.ok(src.length > RICH_TEXT_LIMITS.htmlLength, "the fixture must reproduce the former million-character rejection");
  editor.commands.setImage({ src, alt: "截图" });
  await Promise.resolve();
  const images = imageNodes(editor.state.doc);
  assert.equal(images.length, 1);
  assert.ok(images[0].attrs.src === src, "the inserted image source must remain complete");
  assert.equal(editor.state.doc.textContent, "原有正文");
  assert.equal(notices.length, 0);
});

test("mixed rich HTML keeps embedded images external images and surrounding text without duplicating clipboard files", (t) => {
  const { editor, noticeEvents } = setup(t);
  editor.commands.selectAll();
  const src = imageDataUrl(800 * 1024);
  const html = `<p>图前<strong>重点</strong></p><img src="${src}" alt="截图">`
    + '<p>两图之间</p><img src="https://example.com/chart.png" alt="外链图"><p>图后正文</p>';
  assert.equal(paste(editor, html, "图前重点两图之间图后正文", [pngFile(800 * 1024)]).defaultPrevented, true);
  const images = imageNodes(editor.state.doc);
  assert.equal(images.length, 2);
  assert.ok(images[0].attrs.src === src, "the base64 image must not be dropped or truncated");
  assert.equal(images[1].attrs.src, "https://example.com/chart.png");
  assert.equal(editor.state.doc.textContent, "图前重点两图之间图后正文");
  assert.ok(editor.view.dom.querySelector("strong"));
  assert.equal(noticeEvents.length, 0);
});

test("lazy data-src images are normalized before the Image extension parses pasted HTML", (t) => {
  const { editor, notices } = setup(t);
  editor.commands.selectAll();
  const src = imageDataUrl(800 * 1024);
  paste(editor, `<p>懒加载图前</p><img data-src="${src}"><p>懒加载图后</p>`);
  const images = imageNodes(editor.state.doc);
  assert.equal(images.length, 1);
  assert.ok(images[0].attrs.src === src, "the lazy source must become a complete src attribute");
  assert.equal(editor.state.doc.textContent, "懒加载图前懒加载图后");
  assert.equal(notices.length, 0);
});

test("image payload exemptions do not weaken text markup or non-image attribute limits", (t) => {
  const { editor, notices } = setup(t);
  const original = editor.state.doc;
  const src = imageDataUrl(800 * 1024);
  editor.commands.selectAll();
  paste(editor, `<img src="${src}"><p>${"字".repeat(RICH_TEXT_LIMITS.textLength + 1)}</p>`);
  assert.equal(editor.state.doc, original);
  assert.match(notices.at(-1), /3 万字/);
  paste(editor, `<img src="${src}" data-note="${"x".repeat(RICH_TEXT_LIMITS.htmlLength)}">`);
  assert.equal(editor.state.doc, original);
  assert.match(notices.at(-1), /100 万字符/);
  paste(editor, `<div data-test="${src}">这不是图片</div>`);
  assert.equal(editor.state.doc, original);
  assert.match(notices.at(-1), /100 万字符/);
  paste(editor, `<p>${src}</p>`);
  assert.equal(editor.state.doc, original);
  assert.match(notices.at(-1), /100 万字符|3 万字/);
});

test("the document transaction guard enforces single-image total-image and image-count limits", async (t) => {
  const tooLarge = setup(t);
  const original = tooLarge.editor.state.doc;
  tooLarge.editor.commands.setImage({ src: imageDataUrl(IMAGE_LIMITS.fileBytes + 1) });
  await Promise.resolve();
  assert.equal(tooLarge.editor.state.doc, original);
  assert.match(tooLarge.notices.at(-1), /单张图片/);

  const total = setup(t);
  const src = imageDataUrl(8 * 1024 * 1024);
  total.editor.commands.setImage({ src });
  total.editor.commands.setTextSelection(total.editor.state.doc.content.size - 1);
  total.editor.commands.setImage({ src });
  assert.equal(imageNodes(total.editor.state.doc).length, 2);
  total.editor.commands.setTextSelection(total.editor.state.doc.content.size - 1);
  const accepted = total.editor.state.doc;
  total.editor.commands.setImage({ src });
  await Promise.resolve();
  assert.equal(total.editor.state.doc, accepted);
  assert.match(total.notices.at(-1), /图片总量/);

  const count = setup(t);
  const before = count.editor.state.doc;
  count.editor.commands.insertContent(Array.from({ length: IMAGE_LIMITS.count + 1 }, () => ({ type: "image", attrs: { src: imageDataUrl(PNG_HEADER.length) } })));
  await Promise.resolve();
  assert.equal(count.editor.state.doc, before);
  assert.match(count.notices.at(-1), /图片超过/);
});

test("a native PNG clipboard file is handled once even when both files and items expose it", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const event = paste(editor, "", "", [pngFile(800 * 1024)]);
  assert.equal(event.defaultPrevented, true);
  await waitFor(() => noticeEvents.length > 0, "binary image paste did not finish");
  assert.equal(imageNodes(editor.state.doc).length, 1);
  assert.equal(editor.state.doc.textContent, "原有正文");
  assert.equal(noticeEvents.filter(({ tone }) => tone === "success").length, 1);
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
});

test("a browser that exposes a screenshot only through clipboard items can paste it", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const file = pngFile();
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    getData: () => "", files: [], types: ["Files"],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  } });
  editor.view.dom.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await waitFor(() => noticeEvents.length > 0, "clipboard item insertion did not finish");
  assert.equal(imageNodes(editor.state.doc).length, 1);
  assert.equal(noticeEvents.filter(({ tone }) => tone === "success").length, 1);
});

test("an external PNG file drop inserts at the drop position and internal editor drags remain native", async (t) => {
  const { editor, onNotice, noticeEvents } = setup(t, "<p>第一段</p><p>第二段</p>");
  const firstBlockEnd = editor.state.doc.firstChild.nodeSize;
  const previousPosAtCoords = editor.view.posAtCoords;
  editor.view.posAtCoords = () => ({ pos: firstBlockEnd, inside: -1 });
  t.after(() => { editor.view.posAtCoords = previousPosAtCoords; });
  const file = pngFile();
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: 10 }, clientY: { value: 20 },
    dataTransfer: { value: { files: [file], items: [], types: ["Files"], getData: () => "" } },
  });
  editor.view.dom.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await waitFor(() => noticeEvents.length > 0, "binary image drop did not finish");
  assert.equal(editor.state.doc.child(0).textContent, "第一段");
  assert.equal(editor.state.doc.child(1).type.name, "image");
  assert.equal(editor.state.doc.child(2).textContent, "第二段");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);

  const handlers = createPasteHandlers(onNotice);
  editor.view.dragging = { slice: editor.state.doc.slice(0, firstBlockEnd), move: true };
  try {
    const internal = new dom.window.Event("drop", { cancelable: true });
    assert.equal(handlers.handleDOMEvents.drop(editor.view, internal), false);
    assert.equal(internal.defaultPrevented, false);
  } finally { editor.view.dragging = null; }
});

test("multiple image files form one document transaction and one undo step", async (t) => {
  const { editor, onNotice, noticeEvents } = setup(t);
  const original = editor.getHTML();
  let edits = 0;
  editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) edits += 1; });
  const inserted = await insertImageFiles(editor.view, [pngFile(PNG_HEADER.length, "first.png"), pngFile(PNG_HEADER.length, "second.png")], onNotice);
  assert.equal(inserted, true);
  assert.equal(imageNodes(editor.state.doc).length, 2);
  assert.equal(edits, 1);
  assert.equal(noticeEvents.filter(({ tone }) => tone === "success").length, 1);
  editor.commands.undo();
  assert.equal(editor.getHTML(), original);
});

test("image insertion aborts if the document changes while files are being read", async (t) => {
  const { editor, onNotice, noticeEvents } = setup(t);
  const pending = insertImageFiles(editor.view, [pngFile(800 * 1024)], onNotice);
  editor.commands.insertContent("读取期间新写的文字");
  const edited = editor.state.doc;
  assert.equal(await pending, false);
  assert.equal(editor.state.doc, edited);
  assert.equal(imageNodes(editor.state.doc).length, 0);
  assertRejectedImage(noticeEvents);
});

test("a transaction rejected by another editor rule cannot produce an image success notice", async (t) => {
  const rejectImageChanges = Extension.create({
    name: "rejectImagesForTest",
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction: (transaction, state) => imageNodes(transaction.doc).length <= imageNodes(state.doc).length })];
    },
  });
  const { editor, onNotice, noticeEvents } = setup(t, "<p>原有正文</p>", [rejectImageChanges]);
  const original = editor.state.doc;
  assert.equal(await insertImageFiles(editor.view, [pngFile()], onNotice), false);
  assert.equal(editor.state.doc, original);
  assertRejectedImage(noticeEvents);
});

test("a failed FileReader does not erase the selection or report image insertion success", async (t) => {
  const { editor, onNotice, noticeEvents } = setup(t);
  editor.commands.selectAll();
  const original = editor.state.doc;
  const RealReader = dom.window.FileReader;
  dom.window.FileReader = class extends RealReader {
    readAsDataURL() { queueMicrotask(() => this.dispatchEvent(new dom.window.Event("error"))); }
  };
  try {
    assert.equal(await insertImageFiles(editor.view, [pngFile()], onNotice), false);
    assert.equal(editor.state.doc, original);
    assertRejectedImage(noticeEvents);
  } finally { dom.window.FileReader = RealReader; }
});

test("invalid signatures and oversized file batches leave the selected content unchanged", async (t) => {
  const batches = [
    [new dom.window.File(["not a PNG"], "fake.png", { type: "image/png" })],
    [pngFile(IMAGE_LIMITS.fileBytes + 1)],
    Array.from({ length: 3 }, () => pngFile(7 * 1024 * 1024)),
    Array.from({ length: IMAGE_LIMITS.count + 1 }, () => pngFile()),
  ];
  for (const files of batches) {
    const { editor, onNotice, noticeEvents } = setup(t);
    editor.commands.selectAll();
    const original = editor.state.doc;
    assert.equal(await insertImageFiles(editor.view, files, onNotice), false);
    assert.equal(editor.state.doc, original);
    assertRejectedImage(noticeEvents);
  }
});

test("a blob HTML image is restored from its PNG clipboard file and survives article import", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const { extractRichTextFragment } = loadDomModule("lib/richText/importArticle.ts");
  const file = pngFile(PNG_HEADER.length, "clipboard.png");
  const expectedSource = await readImage(file);
  editor.commands.selectAll();

  const event = paste(editor, '<img src="blob:https://example.com/temporary-clipboard-image" alt="截图">', "", [file]);
  assert.equal(event.defaultPrevented, true);
  await waitFor(() => noticeEvents.length > 0, "the temporary HTML image did not finish reading its clipboard file");
  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), [expectedSource]);
  assert.equal(editor.state.doc.textContent, "");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);

  const imported = extractRichTextFragment(editor.getHTML(), true, true);
  const parsed = new DOMParser().parseFromString(imported.html, "text/html");
  assert.equal(parsed.querySelectorAll("img").length, 1);
  assert.equal(parsed.querySelector("img").getAttribute("src"), expectedSource);
  assert.equal(parsed.querySelector("img").getAttribute("alt"), "截图");
  assert.doesNotMatch(imported.html, /blob:|file:/);
});

test("a file URI clipboard image preserves surrounding rich text and the entire paste undoes once", async (t) => {
  const { editor, noticeEvents } = setup(t, "<p>将被替换的<strong>原有内容</strong>。</p>");
  const file = pngFile(PNG_HEADER.length, "word-image.png");
  const expectedSource = await readImage(file);
  editor.commands.selectAll();
  const original = editor.getHTML();
  let edits = 0;
  editor.on("transaction", ({ transaction }) => { if (transaction.docChanged) edits += 1; });

  paste(editor, '<p>图前<strong>重点</strong>正文。</p><img src="file:///private/tmp/word/media/image1.png" alt="原图说明"><p>图后正文。</p>', "图前重点正文。图后正文。", [file]);
  await waitFor(() => noticeEvents.length > 0, "the mixed temporary-image paste did not finish");
  assert.equal(editor.state.doc.textContent, "图前重点正文。图后正文。");
  assert.equal(editor.view.dom.querySelector("strong").textContent, "重点");
  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), [expectedSource]);
  assert.equal(editor.view.dom.querySelector("img").alt, "原图说明");
  assert.equal(edits, 1, "HTML text and restored images must enter one document transaction");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
  assert.equal(editor.commands.undo(), true);
  assert.equal(editor.getHTML(), original, "one undo must restore all selected content, not leave pasted text behind");
});

test("temporary file URI images match filenames and preserve HTML order when clipboard files are reversed", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const first = pngFile(PNG_HEADER.length, "first.png");
  const second = pngFile(PNG_HEADER.length + 7, "second.png");
  const expectedSources = await Promise.all([readImage(first), readImage(second)]);
  editor.commands.selectAll();
  paste(editor, '<p>第一张之前</p><img src="file:///tmp/export/first.png" alt="第一张"><p>两张之间</p><img src="file:///C:/Temp/export/second.png" alt="第二张"><p>第二张之后</p>', "", [second, first]);
  await waitFor(() => noticeEvents.length > 0, "filename-matched temporary images did not finish");

  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), expectedSources);
  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.alt), ["第一张", "第二张"]);
  assert.equal(editor.state.doc.textContent, "第一张之前两张之间第二张之后");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
});

test("opaque blob images can match unique alt filenames without relying on clipboard file order", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const first = pngFile(PNG_HEADER.length, "alpha.png");
  const second = pngFile(PNG_HEADER.length + 11, "beta.png");
  const expectedSources = await Promise.all([readImage(first), readImage(second)]);
  editor.commands.selectAll();
  paste(editor, '<img src="blob:https://example.com/opaque-a" alt="alpha.png"><img src="blob:https://example.com/opaque-b" alt="beta.png">', "", [second, first]);
  await waitFor(() => noticeEvents.length > 0, "alt-matched temporary images did not finish");

  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), expectedSources);
  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.alt), ["alpha.png", "beta.png"]);
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
});

test("repeated occurrences of the same temporary image URL reuse its one clipboard file", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const file = pngFile();
  const expectedSource = await readImage(file);
  editor.commands.selectAll();
  paste(editor, '<img src="blob:https://example.com/shared-image" alt="第一次"><p>重复引用之间</p><img src="blob:https://example.com/shared-image" alt="第二次">', "", [file]);
  await waitFor(() => noticeEvents.length > 0, "the repeated temporary image did not finish");

  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), [expectedSource, expectedSource]);
  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.alt), ["第一次", "第二次"]);
  assert.equal(editor.state.doc.textContent, "重复引用之间");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
});

test("restoring a temporary image preserves adjacent data and HTTPS images without adding file duplicates", async (t) => {
  const { editor, noticeEvents } = setup(t);
  const embeddedSource = imageDataUrl(PNG_HEADER.length + 5);
  const file = pngFile(PNG_HEADER.length + 13, "restored.png");
  const restoredSource = await readImage(file);
  const remoteSource = "https://example.com/existing-chart.png";
  editor.commands.selectAll();
  paste(editor, `<p>保留<strong>重点</strong></p><img src="${embeddedSource}" alt="已嵌入"><img src="blob:https://example.com/needs-bytes" alt="需恢复"><img src="${remoteSource}" alt="外链"><p>末尾正文</p>`, "", [file]);
  await waitFor(() => noticeEvents.length > 0, "the mixed image-source paste did not finish");

  assert.deepEqual(imageNodes(editor.state.doc).map((image) => image.attrs.src), [embeddedSource, restoredSource, remoteSource]);
  assert.equal(editor.view.dom.querySelector("strong").textContent, "重点");
  assert.equal(editor.state.doc.textContent, "保留重点末尾正文");
  assert.equal(noticeEvents.some(({ tone }) => tone === "error"), false);
});

test("unresolved temporary HTML image mappings reject the whole paste and preserve the selected document", async (t) => {
  const cases = [
    { name: "blob image without a clipboard file", html: '<img src="blob:https://example.com/missing">', files: [] },
    { name: "file URI image without a clipboard file", html: '<img src="file:///tmp/missing.png">', files: [] },
    { name: "two distinct temporary URLs with only one file", html: '<img src="blob:https://example.com/a"><img src="blob:https://example.com/b">', files: [pngFile()] },
    { name: "one anonymous temporary URL with two possible files", html: '<img src="blob:https://example.com/a">', files: [pngFile(PNG_HEADER.length, "first.png"), pngFile(PNG_HEADER.length + 1, "second.png")] },
    { name: "two opaque images without a filename mapping", html: '<img src="blob:https://example.com/a"><img src="blob:https://example.com/b">', files: [pngFile(PNG_HEADER.length, "first.png"), pngFile(PNG_HEADER.length + 1, "second.png")] },
    { name: "duplicate clipboard filenames make a match ambiguous", html: '<img src="file:///tmp/duplicate.png">', files: [pngFile(PNG_HEADER.length, "duplicate.png"), pngFile(PNG_HEADER.length + 1, "duplicate.png")] },
    { name: "one unmatched filename must not leave a partial paste", html: '<img src="file:///tmp/first.png"><img src="file:///tmp/missing.png">', files: [pngFile(PNG_HEADER.length, "first.png"), pngFile(PNG_HEADER.length + 1, "second.png")] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (context) => {
      const { editor, noticeEvents } = setup(context, "<p>选中但必须保留的<strong>正文</strong>。</p>");
      editor.commands.selectAll();
      const original = editor.state.doc;
      const selection = editor.state.selection;
      const event = paste(editor, `<p>不得部分插入</p>${scenario.html}<p>也不得留下结尾</p>`, "", scenario.files);
      assert.equal(event.defaultPrevented, true);
      await waitFor(() => noticeEvents.length > 0, `${scenario.name} did not report an error`);
      assert.equal(editor.state.doc, original, "an unresolved image must not erase or partially replace the selected document");
      assert.ok(editor.state.selection.eq(selection), "the original selection must remain available for retry");
      assertRejectedImage(noticeEvents);
      assert.match(noticeEvents.find(({ tone }) => tone === "error").text, /图片|文件|匹配|对应|来源|临时|读取/);
    });
  }
});

test("temporary HTML image restoration aborts without partial text insertion when the document changes during reading", async (t) => {
  const { editor, noticeEvents } = setup(t, "<p>保留原有正文。</p>");
  editor.commands.selectAll();
  paste(editor, '<p>不能插入的旧剪贴板正文</p><img src="blob:https://example.com/pending">', "", [pngFile(800 * 1024)]);
  editor.commands.insertContentAt(1, "读取期间新写的文字。");
  const edited = editor.state.doc;
  await waitFor(() => noticeEvents.length > 0, "the stale temporary-image paste did not settle");

  assert.equal(editor.state.doc, edited);
  assert.equal(imageNodes(editor.state.doc).length, 0);
  assert.match(editor.state.doc.textContent, /读取期间新写的文字/);
  assert.doesNotMatch(editor.state.doc.textContent, /旧剪贴板正文/);
  assertRejectedImage(noticeEvents);
});
