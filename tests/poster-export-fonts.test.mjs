import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const { usedFontFamilies } = loadDomModule("lib/export/usedFontFamilies.ts");

test("font discovery includes computed and inline families, deduplicated independently of traversal order", (t) => {
  const dom = installDom();
  t.after(() => dom.window.close());
  document.body.innerHTML = `<style>.computed { font-family: "Zhepage Source Han Sans", sans-serif; }</style>
    <article class="computed"><p style="font-family:'Zhepage Source Han Serif',serif">刊物标题</p><p class="computed">正文</p></article>`;
  const node = document.querySelector("article");
  assert.deepEqual(usedFontFamilies(node), ["Zhepage Source Han Sans", "Zhepage Source Han Serif", "sans-serif", "serif"]);
  node.prepend(node.lastElementChild);
  assert.deepEqual(usedFontFamilies(node), ["Zhepage Source Han Sans", "Zhepage Source Han Serif", "sans-serif", "serif"]);
  node.querySelector('[style]').style.fontFamily = '"New Font", serif';
  assert.deepEqual(usedFontFamilies(node), ["New Font", "Zhepage Source Han Sans", "sans-serif", "serif"]);
});

test("a sans-only export cannot supply cached font CSS to a later page that also uses serif", async (t) => {
  const dom = installDom();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const sans = '"Zhepage Source Han Sans"';
  const serif = '"Zhepage Source Han Serif"';
  const contentPages = [
    `<p style='font-family:${sans}'>纯黑体正文</p>`,
    `<h2 style='font-family:${serif}'>刊物标题</h2><p style='font-family:${sans}'>刊物说明</p>`,
    `<p style='font-family:${sans}'>另一页说明</p><h2 style='font-family:${serif}'>另一页标题</h2>`,
  ];
  const grid = document.createElement("div");
  grid.className = "poster-grid";
  document.body.append(grid);
  const pageRefs = { current: contentPages.map((html) => {
    const node = document.createElement("article");
    node.className = "poster-page";
    node.style.fontFamily = sans;
    node.innerHTML = `<div class="article-flow" style='font-family:${sans}'>${html}</div>`;
    grid.append(node);
    return node;
  }) };
  const embeddedFor = [], captured = [];
  const imageModule = {
    async getFontEmbedCSS(node) {
      embeddedFor.push(node);
      return node.querySelector("h2") ? "embedded-sans-and-serif" : "embedded-sans";
    },
    async toBlob(node, options) {
      captured.push({ text: node.textContent, css: options.fontEmbedCSS });
      return new Blob(["image"], { type: "image/png" });
    },
  };
  const filename = fileURLToPath(new URL("../app/hooks/usePosterExport.ts", import.meta.url));
  const nativeRequire = createRequire(filename);
  const React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => {
    if (specifier === "html-to-image") return imageModule;
    return specifier.startsWith(".") ? loadDomModule(`${resolve(dirname(filename), specifier)}.ts`) : nativeRequire(specifier);
  }, loaded, loaded.exports);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const exportVersionRef = { current: { inputKey: "font-regression", paginationVersion: 1 } };
  let latest;
  function Host() {
    latest = loaded.exports.usePosterExport({
      exportVersionRef, pageRefs, contentPages, pageOffset: 0, totalPages: contentPages.length,
      format: { width: 1080, height: 1440 }, formatKey: "xiaohongshu", title: "字体验证", paperColor: "#fff",
      fontKey: "sans:sans", waitForFonts: async () => {},
      setShowAllPreviewPages() { assert.fail("The fixture mounts all pages"); }, onNotice() {},
    });
    return null;
  }
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });
  await act(async () => root.render(React.createElement(Host)));
  await act(async () => { await latest.collectAssets(); });
  assert.deepEqual(captured.map(({ css }) => css), ["embedded-sans", "embedded-sans-and-serif", "embedded-sans-and-serif"]);
  assert.deepEqual(embeddedFor, pageRefs.current.slice(0, 2), "Pages with the same font set should reuse their embedded CSS");
});
