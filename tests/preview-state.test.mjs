import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

test("failed pagination clears stale previews, recovers, and prevents downloads after edits", { timeout: 20_000 }, async (context) => {
  const dom = installDom();
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pagePath = fileURLToPath(new URL("../app/page.tsx", import.meta.url));
  const nativeRequire = createRequire(pagePath);
  const React = nativeRequire("react");
  const { createRoot } = nativeRequire("react-dom/client");
  const { act } = React;

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: async () => [], check: () => true, ready: Promise.resolve() },
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  window.localStorage.setItem("zhepage-guide-seen-v1", "1");
  let failPagination = false;
  let editorProps;
  let holdImage = false;
  let resolveImage;
  let holdZip = false;
  let resolveZip;
  let downloads = 0;
  context.mock.method(URL, "createObjectURL", () => "blob:preview-state-test");
  context.mock.method(URL, "revokeObjectURL", () => {});
  context.mock.method(dom.window.HTMLAnchorElement.prototype, "click", () => { downloads += 1; });

  // Keep the real page component and React state/effects. Control pagination
  // failures and export completion without depending on browser geometry,
  // external fonts, network requests, or actual image/ZIP generation.
  function Editor(props) {
    editorProps = props;
    // eslint-disable-next-line react/prop-types -- The stub receives the real editor's typed props.
    return React.createElement("div", { "data-test-editor": true }, props.html);
  }
  const imageModule = {
    getFontEmbedCSS: async () => "",
    toBlob: () => holdImage
      ? new Promise((resolve) => { resolveImage = resolve; })
      : Promise.resolve(new Blob(["image"])),
  };
  class JSZip {
    file() {}
    generateAsync() {
      return holdZip
        ? new Promise((resolve) => { resolveZip = resolve; })
        : Promise.resolve(new Blob(["zip"]));
    }
  }
  const require = (specifier) => {
    if (specifier === "./components/UnifiedColorPopover") return { __esModule: true, default: () => null };
    if (specifier === "./components/PosterCover") return loadDomModule("app/components/PosterCover.tsx");
    if (specifier === "./components/ZhepageEditor") return { __esModule: true, default: Editor };
    if (specifier === "../lib/pagination/paginateArticle") return {
      paginateArticle: (html) => {
        if (failPagination) throw new Error("分页保真检查失败：span[style] 的颜色或强调样式未完整继承");
        const text = new DOMParser().parseFromString(html, "text/html").body.textContent;
        const pages = Array.from({ length: 7 }, (_, index) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = `${index + 1}:${text}`;
          return paragraph.outerHTML;
        });
        return { pages, usage: Array(7).fill(0.95) };
      },
    };
    if (specifier === "html-to-image") return imageModule;
    if (specifier === "jszip") return { __esModule: true, default: JSZip };
    if (specifier.startsWith("../lib/")) return loadDomModule(`${resolve(dirname(pagePath), specifier)}.ts`);
    return nativeRequire(specifier);
  };
  const { outputText } = ts.transpileModule(readFileSync(pagePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: pagePath,
  });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)(require, loaded, loaded.exports);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const bulkExport = () => document.querySelector(".top-actions .primary");
  const click = async (button) => {
    assert.ok(button, "the expected action must be visible");
    await act(async () => { button.click(); });
  };
  const changeArticle = async (html) => act(async () => { editorProps.onChange(html); });
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 4_000;
    while (!predicate() && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    assert.ok(predicate(), description);
  };

  try {
    await act(async () => { root.render(React.createElement(loaded.exports.default)); });
    await waitFor(() => editorProps && !bulkExport().disabled, "initial pagination and the editor become ready");
    assert.match(bulkExport().textContent, /批量导出 7 张/);
    assert.equal(document.querySelectorAll(".content-page").length, 4);

    failPagination = true;
    await changeArticle("<p>最新编辑正文。</p>");
    assert.equal(bulkExport().disabled, true);
    assert.match(bulkExport().textContent, /正在排版/);
    assert.equal(document.querySelectorAll(".content-page").length, 0);
    await waitFor(() => document.querySelector(".preview-workspace").textContent.includes("当前内容排版失败"), "the pagination failure is shown");
    assert.equal(document.querySelectorAll(".content-page").length, 0);
    assert.match(document.querySelector("[data-test-editor]").textContent, /最新编辑正文/);
    assert.equal(bulkExport().disabled, true);

    failPagination = false;
    await click([...document.querySelectorAll("button")].find((button) => button.textContent === "重新排版"));
    await waitFor(() => !bulkExport().disabled, "retry restores the preview and export");
    assert.match(document.querySelector(".content-page").textContent, /最新编辑正文/);
    assert.match(document.querySelector(".status-pill").textContent, /排版已恢复/);

    holdImage = true;
    await click(document.querySelector(".content-page .page-export"));
    await waitFor(() => resolveImage, "single-page conversion starts");
    await changeArticle("<p>导出过程中又修改正文。</p>");
    await act(async () => { resolveImage(new Blob(["image"])); });
    assert.equal(downloads, 0, "an outdated PNG must not download");
    assert.match(document.querySelector(".status-pill").textContent, /已停止本次导出/);

    holdImage = false;
    await waitFor(() => !bulkExport().disabled, "the edited content finishes paginating");
    holdZip = true;
    await click(bulkExport());
    await waitFor(() => resolveZip, "all pages render and batch compression starts");
    await changeArticle("<p>压缩过程中再次修改正文。</p>");
    await act(async () => { resolveZip(new Blob(["zip"])); });
    assert.equal(downloads, 0, "an outdated ZIP must not download");
    assert.match(document.querySelector(".status-pill").textContent, /已停止本次导出/);

    holdZip = false;
    await waitFor(() => !bulkExport().disabled, "the latest content is ready to export");
    await click(document.querySelector(".content-page .page-export"));
    await waitFor(() => downloads > 0, "a stable completed preview can still download");
    assert.equal(downloads, 1);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
