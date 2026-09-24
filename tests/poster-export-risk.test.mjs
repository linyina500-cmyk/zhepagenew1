import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const risk = '<aside class="risk-note"><strong>风险提示</strong><p>风险文字<br>第二行</p></aside>';
const body = '<h2>完整正文</h2><p style="color:rgb(10, 20, 30)">首行<br>次行 <strong>强调</strong><em>斜体</em></p><img src="/body.png" alt="必须保留的配图"><table><tbody><tr><td>完整数据</td></tr></tbody></table><footer><span>正文来源</span><span>不能替换为页码的署名</span></footer>';
async function fixture(t, { contentPages, cover = false, waitForFonts = async () => {} }) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    decode: { configurable: true, value: async function () {} },
    complete: { configurable: true, get() { return true; } },
    naturalWidth: { configurable: true, get() { return 100; } },
    naturalHeight: { configurable: true, get() { return 100; } },
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,ZmFrZQ==";
  const grid = document.createElement("div"); grid.className = "poster-grid"; document.body.append(grid);
  const pages = [...(cover ? ['<div class="cover-bottom"><div class="cover-meta"><span>封面品牌</span><span>05 PAGES</span></div></div>'] : []), ...contentPages.map((html) => `<div class="article-viewport" style="height:1100px"><div class="article-flow">${html}</div></div>`)];
  const pageRefs = { current: pages.map((html, index) => {
    const wrap = document.createElement("div"); wrap.className = "poster-wrap";
    const node = document.createElement("article"); node.className = "poster-page";
    node.dataset.sourceIndex = String(index);
    const number = index + 1 - (cover ? 1 : 0);
    node.innerHTML = cover && index === 0 ? html : `<header><span>页眉品牌</span><b>${String(number).padStart(2, "0")}</b></header>${html}<footer><span>页脚品牌</span><span>${number} / ${contentPages.length}</span></footer>`;
    wrap.append(node); grid.append(wrap); return node;
  }) };
  const originals = pageRefs.current.map((node) => node.outerHTML);
  const captured = [], templates = [], zipFiles = [], downloads = [], notices = [];
  const imageModule = { async getFontEmbedCSS() { return ""; }, async toBlob(node) {
    captured.push(node.cloneNode(true)); return new Blob([node.outerHTML], { type: "image/png" });
  }, async toSvg(node, options) {
    templates.push(node.cloneNode(true));
    const xml = new dom.window.XMLSerializer().serializeToString(node);
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}"><foreignObject width="100%" height="100%" x="0" y="0" externalResourcesRequired="true">${xml}</foreignObject></svg>`);
  } };
  class FakeZip { file(name, blob) { zipFiles.push({ name, blob }); } async generateAsync() { return new Blob(["synthetic zip"]); } }
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const filename = fileURLToPath(new URL("../app/hooks/usePosterExport.ts", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { act } = React, { createRoot } = nativeRequire("react-dom/client");
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((specifier) => {
    if (specifier === "html-to-image") return imageModule;
    if (specifier === "jszip") return FakeZip;
    return specifier.startsWith(".") ? loadDomModule(`${resolve(dirname(filename), specifier)}.ts`) : nativeRequire(specifier);
  }, loaded, loaded.exports);
  const exportVersionRef = { current: { inputKey: "synthetic-pages", paginationVersion: 1 } };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let latest;
  function Host() {
    latest = loaded.exports.usePosterExport({ exportVersionRef, pageRefs, contentPages,
      pageOffset: cover ? 1 : 0, totalPages: pages.length, format: { width: 1080, height: 1440 }, formatKey: "xiaohongshu",
      title: "正文测试", paperColor: "#fff", fontKey: "test", waitForFonts,
      setShowAllPreviewPages() { assert.fail("all synthetic preview pages are mounted"); }, onNotice: (notice) => notices.push(notice),
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Host)));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  const unchanged = () => {
    assert.deepEqual(pageRefs.current.map((node) => node.outerHTML), originals);
    assert.equal(document.querySelectorAll(".poster-grid").length, 1, "snapshot frames must be disposed");
  };
  return { captured, templates, zipFiles, downloads, notices, exportVersionRef, unchanged, act, get latest() { return latest; } };
}

test("editable risk keeps every original page and captures only the existing last-page template", async (t) => {
  const f = await fixture(t, { cover: true, contentPages: [body, `<p>末页正文</p>${risk}`] });
  let images;
  await f.act(async () => { images = await f.latest.collectAssets({ editableRisk: true }); });
  assert.equal(images.length, 3);
  assert.deepEqual(f.captured.map((node) => node.dataset.sourceIndex), ["0", "1", "2"]);
  assert.deepEqual(images.map(({ name }) => name), ["折页-小红书-01.png", "折页-小红书-02.png", "折页-小红书-03.png"]);
  assert.deepEqual(f.captured.map((node) => node.querySelector(":scope > footer > span:last-child")?.textContent ?? null), [null, "1 / 2", "2 / 2"]);
  assert.equal(f.captured[0].querySelector(".cover-meta > span:last-child").textContent, "05 PAGES");
  assert.equal(f.templates.length, 1); assert.equal(f.templates[0].dataset.sourceIndex, "2");
  assert.equal(images[0].riskTemplate, undefined); assert.equal(images[1].riskTemplate, undefined);
  assert.match(images[2].riskTemplate.svg, /末页正文/); assert.match(images[2].riskTemplate.svg, /风险文字/);
  const actualBody = f.captured[1].querySelector(".article-flow"), actual = actualBody.cloneNode(true);
  actual.querySelector("img").setAttribute("src", "/body.png");
  actual.querySelector("img").removeAttribute("loading"); actual.querySelector("img").removeAttribute("decoding");
  assert.equal(actual.innerHTML, body);
  f.unchanged();
});

test("ordinary asset collection and single/ZIP downloads retain risk notes, page count and numbering", async (t) => {
  const f = await fixture(t, { contentPages: [body + risk, risk] });
  let images;
  await f.act(async () => { images = await f.latest.collectAssets(); });
  assert.equal(images.length, 2);
  assert.equal(f.captured.length, 2);
  assert.ok(f.captured.every((node) => node.querySelector(".risk-note")?.textContent === "风险提示风险文字第二行"));
  await f.act(async () => { await f.latest.exportOne(1); });
  assert.equal(f.captured[2].querySelector(".risk-note").outerHTML, risk);
  await f.act(async () => { await f.latest.exportAll(); });
  assert.equal(f.zipFiles.length, 2);
  assert.deepEqual(f.zipFiles.map(({ name }) => name), ["折页-小红书-01.png", "折页-小红书-02.png"]);
  assert.deepEqual(f.downloads, ["折页-小红书-02.png", "正文测试-小红书-全部贴图.zip"]);
  assert.ok(f.captured.slice(3).every((node) => node.querySelector(".risk-note")));
  assert.deepEqual(f.captured.slice(3).map((node) => node.querySelector(":scope > footer > span:last-child").textContent), ["1 / 2", "2 / 2"]);
  assert.deepEqual(f.captured.slice(3).map((node) => node.querySelector(":scope > header > b").textContent), ["01", "02"]);
  f.unchanged();
});

test("an existing risk-only last page remains one page without appending another", async (t) => {
  const only = await fixture(t, { contentPages: [risk] });
  let images;
  await only.act(async () => { images = await only.latest.collectAssets({ editableRisk: true }); });
  assert.equal(images.length, 1); assert.equal(only.captured.length, 1); assert.equal(only.templates.length, 1); assert.match(images[0].riskTemplate.svg, /风险文字/); only.unchanged();
});

test("an export version change still stops editable-risk export before snapshot capture", async (t) => {
  let f;
  f = await fixture(t, { contentPages: [body + risk], waitForFonts: async () => { f.exportVersionRef.current = { inputKey: "changed", paginationVersion: 2 }; } });
  await f.act(async () => { await assert.rejects(f.latest.collectAssets({ editableRisk: true }), /内容或样式已更新/); });
  assert.deepEqual(f.captured, []); assert.equal(f.latest.exporting, false); f.unchanged();
});


test("a missing risk block is added only to the editable template, leaving the original PNG and preview intact", async (t) => {
  const f = await fixture(t, { contentPages: [body] });
  let images;
  await f.act(async () => { images = await f.latest.collectAssets({ editableRisk: true }); });
  assert.equal(images.length, 1); assert.equal(f.captured[0].querySelector(".risk-note"), null);
  assert.equal(f.templates[0].querySelectorAll(".risk-note").length, 1); assert.match(images[0].riskTemplate.svg, /风险提示/);
  f.unchanged();
});

test("an imported link keeps its text and decoration while template navigation attributes are removed", async (t) => {
  const f = await fixture(t, { contentPages: ['<p><a href="https://example.test/article" target="_blank" rel="noopener" style="color:rgb(10, 20, 30);text-decoration:underline">正文链接</a></p>' + risk] });
  await f.act(async () => { await f.latest.collectAssets({ editableRisk: true }); });
  assert.equal(f.captured[0].querySelector("a").getAttribute("href"), "https://example.test/article");
  const link = f.templates[0].querySelector("a");
  assert.equal(link.textContent, "正文链接"); assert.equal(link.style.color, "rgb(10, 20, 30)"); assert.equal(link.style.textDecoration, "underline");
  assert.equal(link.hasAttribute("href"), false); assert.equal(link.hasAttribute("target"), false); assert.equal(link.hasAttribute("rel"), false);
  f.unchanged();
});
