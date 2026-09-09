import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installDom } from "./helpers/load-dom-module.mjs";

async function mountWorkspace(context, articleHtml) {
  const dom = installDom();
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: dom.window.Image });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: async () => [], check: () => true, ready: Promise.resolve() },
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  window.localStorage.setItem("zhepage-guide-seen-v1", "1");
  window.localStorage.setItem("zhepage-workspace-v2", JSON.stringify({
    version: 2, articleHtml, showRiskNote: false, firstPageContent: false,
    autoStructure: false, previewPresentation: "base",
  }));

  const pagePath = fileURLToPath(new URL("../app/page.tsx", import.meta.url));
  const nativeRequire = createRequire(pagePath);
  const React = nativeRequire("react");
  const { createRoot } = nativeRequire("react-dom/client");
  const { act } = React;
  const downloads = [];
  const captures = [];
  context.mock.method(URL, "createObjectURL", () => "blob:editor-update-boundary-test");
  context.mock.method(URL, "revokeObjectURL", () => {});
  context.mock.method(dom.window.HTMLAnchorElement.prototype, "click", function () { downloads.push(this.download); });
  const imageModule = {
    getFontEmbedCSS: async () => "",
    toBlob: async (node) => {
      captures.push(node.textContent);
      return new Blob(["image"]);
    },
  };
  class JSZip {
    file() {}
    async generateAsync() { return new Blob(["zip"]); }
  }

  // Keep the actual page, editor, Tiptap transactions and export hook together.
  // Only browser geometry, external resources and unrelated color controls are
  // replaced; calling a stub editor's onChange would miss this timing boundary.
  const modules = new Map();
  function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const loaded = { exports: {} };
    modules.set(filename, loaded);
    const require = (specifier) => {
      if (specifier === "html-to-image") return imageModule;
      if (specifier === "jszip") return { __esModule: true, default: JSZip };
      if (!specifier.startsWith(".")) return nativeRequire(specifier);
      const base = resolve(dirname(filename), specifier);
      if (base === resolve(dirname(pagePath), "components/UnifiedColorPopover")) return { __esModule: true, default: () => null };
      if (base === resolve(dirname(pagePath), "../lib/pagination/paginateArticle")) return {
        paginateArticle: (html) => ({ pages: [html], usage: [0.95] }),
      };
      const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].find((path) => existsSync(path));
      if (!dependency) throw new Error(`Missing test dependency: ${specifier}`);
      return loadModule(dependency);
    };
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: filename,
    });
    new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
    return loaded.exports;
  }

  const Home = loadModule(pagePath).default;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  context.after(async () => {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousImage) Object.defineProperty(globalThis, "Image", previousImage);
    else delete globalThis.Image;
  });
  const bulkExport = () => document.querySelector(".top-actions .primary");
  const singleExport = () => document.querySelector(".content-page .page-export");
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 4_000;
    while (!predicate() && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    assert.ok(predicate(), description);
  };
  const click = async (button) => {
    assert.ok(button, "the expected action must be visible");
    await act(async () => { button.click(); });
  };
  await act(async () => { root.render(React.createElement(Home)); });
  await waitFor(() => document.querySelector(".tiptap-surface")?.editor && !bulkExport().disabled, "the actual editor and initial preview become ready");
  const editor = document.querySelector(".tiptap-surface").editor;
  const insertText = (text) => act(() => { editor.commands.insertContentAt(1, text); });
  return { editor, insertText, click, waitFor, bulkExport, singleExport, downloads, captures, act };
}

function holdPaginationTimers(context, act) {
  const timers = new Map();
  const schedule = window.setTimeout.bind(window);
  const cancel = window.clearTimeout.bind(window);
  context.mock.method(window, "setTimeout", (callback, delay, ...args) => {
    if (delay !== 160 && delay !== 320) return schedule(callback, delay, ...args);
    const timer = schedule(() => {}, 60_000);
    timers.set(timer, () => callback(...args));
    return timer;
  });
  context.mock.method(window, "clearTimeout", (timer) => {
    timers.delete(timer);
    cancel(timer);
  });
  return async () => {
    assert.ok(timers.size, "pagination must remain pending until the test releases it");
    await act(async () => {
      const pending = [...timers];
      timers.clear();
      for (const [timer, callback] of pending) {
        cancel(timer);
        callback();
      }
    });
  };
}

async function importRichDraft({ click, waitFor, act }, html) {
  await click(document.querySelector(".import-trigger"));
  await click([...document.querySelectorAll(".import-source-tabs button")].find((button) => button.textContent === "富文本"));
  await waitFor(() => document.querySelector(".import-modal .tiptap-surface")?.editor, "the actual compact editor becomes ready");
  await act(async () => { document.querySelector(".import-modal .tiptap-surface").editor.commands.setContent(html); });
  await click(document.querySelector(".import-modal-actions .primary"));
  assert.equal(document.querySelector(".import-modal"), null);
}

test("real editor changes immediately block old exports and the next export contains the new text", { timeout: 15_000 }, async (context) => {
  const workspace = await mountWorkspace(context, "<p>旧正文。</p>");
  const { editor, insertText, click, waitFor, bulkExport, singleExport, downloads, captures } = workspace;
  insertText("刚输入的新增文字。");
  assert.match(editor.getText(), /刚输入的新增文字/);
  assert.equal(bulkExport().disabled, true, "bulk export must become unavailable in the same edit turn");
  assert.equal(singleExport().disabled, true, "single export must become unavailable in the same edit turn");
  await click(singleExport());
  await click(bulkExport());
  assert.equal(downloads.length, 0, "clicking the retained old preview must not download stale content");
  assert.equal(captures.length, 0);

  await waitFor(() => !bulkExport().disabled, "the changed document finishes paginating");
  await click(singleExport());
  await waitFor(() => downloads.length === 1, "the latest preview can still export a PNG");
  assert.match(downloads[0], /\.png$/);
  assert.match(captures[0], /刚输入的新增文字/);
  await click(bulkExport());
  await waitFor(() => downloads.length === 2, "the latest preview can still export a ZIP");
  assert.match(downloads[1], /\.zip$/);
  assert.ok(captures.slice(1).some((text) => text.includes("刚输入的新增文字")));
});

test("removing lead cards immediately after a real edit preserves the newly entered text", { timeout: 15_000 }, async (context) => {
  const { editor, insertText, click, waitFor, bulkExport } = await mountWorkspace(context,
    '<p>旧正文。</p><div class="lead-card-placeholder"><p>领取卡</p></div>');
  insertText("待保留的新增文字。");
  await click([...document.querySelectorAll("button")].find((button) => button.textContent.startsWith("移除全部（")));
  assert.match(editor.getText(), /待保留的新增文字/);
  assert.doesNotMatch(editor.getHTML(), /lead-card-placeholder/);
  await waitFor(() => !bulkExport().disabled, "removing the card finishes paginating");
  assert.match(document.querySelector(".content-page .article-flow").textContent, /待保留的新增文字/);
  assert.equal(document.querySelector(".content-page .lead-magnet-card"), null);
  assert.match(editor.getText(), /待保留的新增文字/, "the external revision must not restore an older document");
});

test("cancelled URL imports cannot overwrite a reopened rich-text draft or prevent a new import", { timeout: 15_000 }, async (context) => {
  let request;
  // Deliberately ignore AbortSignal so cancellation must also reject a late
  // successful response, as can happen after a response has already arrived.
  context.mock.method(globalThis, "fetch", (_url, options) => new Promise((resolve) => {
    request = { resolve, signal: options.signal };
  }));
  const { editor, click, waitFor, act } = await mountWorkspace(context, "<p>原有已排版正文。</p>");
  const importButton = () => document.querySelector(".import-modal-actions .primary");
  const sourceTab = (label) => [...document.querySelectorAll(".import-source-tabs button")].find((button) => button.textContent === label);
  await click(document.querySelector(".import-trigger"));
  await click(sourceTab("文章链接"));
  await click(importButton());
  assert.ok(request, "the URL request has started");
  assert.equal(importButton().disabled, true);
  assert.ok([...document.querySelectorAll(".import-source-tabs button")].every((button) => button.disabled), "the source must remain fixed while importing");
  assert.equal(document.querySelector("#article-url").disabled, true);
  assert.equal(document.querySelector(".import-style-switch input").disabled, true);

  await click([...document.querySelectorAll(".import-modal-actions button")].find((button) => button.textContent === "取消"));
  assert.equal(document.querySelector(".import-modal"), null);
  assert.equal(request.signal.aborted, true, "cancelling the import also aborts its request");
  await click(document.querySelector(".import-trigger"));
  assert.equal(sourceTab("富文本").disabled, false, "cancellation restores source editing");
  await click(sourceTab("富文本"));
  await waitFor(() => document.querySelector(".import-modal .tiptap-surface")?.editor, "the actual compact editor becomes ready");
  const compactEditor = document.querySelector(".import-modal .tiptap-surface").editor;
  await act(async () => { compactEditor.commands.insertContentAt(1, "取消后创建的新草稿。"); });
  assert.match(compactEditor.getText(), /取消后创建的新草稿/);

  await act(async () => {
    request.resolve({
      ok: true,
      json: async () => ({
        html: '<html><head><meta property="og:title" content="迟到文章"></head><body><div id="js_content"><p>迟到请求的旧文章正文。</p></div></body></html>',
        finalUrl: "https://example.com/article",
      }),
    });
  });
  assert.ok(document.querySelector(".import-modal"), "a cancelled response must not close the reopened dialog");
  assert.match(compactEditor.getText(), /取消后创建的新草稿/);
  assert.doesNotMatch(compactEditor.getText(), /迟到请求/);
  assert.equal(editor.getText(), "原有已排版正文。", "the cancelled response must not replace the article");
  assert.equal(importButton().disabled, false);

  await click(importButton());
  await waitFor(() => !document.querySelector(".import-modal"), "a new rich-text import completes normally");
  assert.match(editor.getText(), /取消后创建的新草稿/);
  assert.doesNotMatch(editor.getText(), /迟到请求/);
});

test("late import pagination preserves a newer rejected-paste notice and the next valid paste still replaces the selection", { timeout: 15_000 }, async (context) => {
  const workspace = await mountWorkspace(context, "<p>原有正文。</p>");
  const { editor, act, bulkExport } = workspace;
  const finishPagination = holdPaginationTimers(context, act);
  await importRichDraft(workspace, "<h1>导入标题</h1><p>导入正文开头。</p><p>导入正文结尾。</p>");
  assert.equal(bulkExport().disabled, true);
  assert.match(document.querySelector(".status-pill").textContent, /正在计算完整分页/);
  const importedText = editor.state.doc.textContent;
  const paste = (html, text) => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      getData: (type) => type === "text/html" ? html : type === "text/plain" ? text : "",
      files: [], items: [], types: html ? ["text/html", "text/plain"] : ["text/plain"],
    } });
    editor.view.dom.dispatchEvent(event);
  };
  await act(async () => { editor.commands.selectAll(); });
  const selectedArticle = editor.state.selection;
  await act(async () => { paste("", "文".repeat(30_001)); });
  assert.match(document.querySelector(".status-pill.error").textContent, /3 万字/);
  assert.equal(editor.state.doc.textContent, importedText);
  assert.ok(editor.state.selection.eq(selectedArticle));

  await finishPagination();
  assert.equal(bulkExport().disabled, false, "the imported article must still finish paginating");
  assert.equal(document.querySelector(".poster-grid").getAttribute("aria-busy"), "false");
  assert.match(document.querySelector(".status-pill").textContent, /3 万字/, "an older import completion must not replace the newer rejection notice");
  assert.ok(document.querySelector(".status-pill.error"));
  assert.equal(editor.state.doc.textContent, importedText);
  assert.ok(editor.state.selection.eq(selectedArticle), "finishing pagination must preserve the rejected paste's selection");

  await act(async () => {
    // JSDOM has no selection geometry; the actual paste transaction and parent
    // updates remain active while its scroll-to-selection step is skipped.
    editor.view.setProps({ handleScrollToSelection: () => true });
    paste("<p>恢复后正文完整。</p>", "恢复后正文完整。");
  });
  assert.equal(editor.state.doc.textContent, "恢复后正文完整。");
  assert.equal(bulkExport().disabled, true);
  await finishPagination();
  assert.equal(bulkExport().disabled, false);
  assert.match(document.querySelector(".content-page .article-flow").textContent, /恢复后正文完整/);
});

test("an uninterrupted rich-text import still reports successful pagination", { timeout: 15_000 }, async (context) => {
  const workspace = await mountWorkspace(context, "<p>原有正文。</p>");
  const finishPagination = holdPaginationTimers(context, workspace.act);
  await importRichDraft(workspace, "<h1>正常导入标题</h1><p>正常导入正文。</p>");
  assert.equal(workspace.bulkExport().disabled, true);
  await finishPagination();
  assert.equal(workspace.bulkExport().disabled, false);
  assert.match(document.querySelector(".status-pill.success").textContent, /导入完成，正文已自动排成/);
  assert.equal(workspace.editor.state.doc.textContent, "正常导入正文。");
});
