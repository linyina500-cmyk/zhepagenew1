import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";
const { renderRiskPage, parseRiskTemplate, assertRiskFits } = loadDomModule("lib/draftSync/riskPage.ts");
const note = { enabled: true, title: "风险提示 Risk", text: "第一段，保留标点：risk / reward!?\n\n  空行后的正文。👨‍👩‍👧‍👦" };
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
function template(html = '<aside class="risk-note" style="height:20px;max-height:20px;overflow:hidden;visibility:hidden;display:none"><strong style="color:#abc;font-size:20px;height:10px">原提示</strong><p style="height:10px;overflow:hidden;font-size:19px">原风险</p></aside>') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440"><foreignObject width="100%" height="100%" x="0" y="0"><article xmlns="http://www.w3.org/1999/xhtml" class="poster-page content-page" style="background:linear-gradient(#fff,#eee);width:1080px;height:1440px"><header><b>03</b></header><div class="article-viewport" style="height:1100px;width:888px"><div class="article-flow" style="height:300px"><section style="border:2px solid red;background:gold"><h2>有样式的正文</h2><p>正文不能改<strong>高亮</strong></p><img src="data:image/png;base64,ZmFrZQ==" alt="图片" /></section>${html}</div></div><footer><span>原署名</span><span>3 / 3</span></footer><style>.test::after{content:'装饰'}</style></article></foreignObject></svg>`;
}
const source = (svg = template()) => ({ id: "last-original", name: "末页.png", blob: png(), width: 1080, height: 1440, riskTemplate: { svg } });
function fixture(t, options = {}) {
  const dom = installDom(), frames = [], captures = [], canvases = [];
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  const create = document.createElement.bind(document);
  document.createElement = function (name, ...args) {
    const element = create(name, ...args);
    if (name === "iframe") {
      let content;
      Object.defineProperty(element, "contentDocument", { get: () => content?.window.document });
      Object.defineProperty(element, "srcdoc", { set(value) {
        content = new JSDOM(value, { url: "http://localhost" }); frames.push({ element, content, html: value });
        const doc = content.window.document;
        Object.defineProperty(doc, "fonts", { value: { ready: options.fonts || Promise.resolve() } });
        content.window.HTMLImageElement.prototype.decode = async () => {};
        const height = () => options.overflow ? 2000 : 300;
        content.window.HTMLElement.prototype.getBoundingClientRect = function () {
          const isArea = this.classList.contains("article-viewport"), h = isArea ? 1100 : height();
          return { left: 96, right: 984, top: 166, bottom: 166 + h, width: 888, height: h };
        };
        Object.defineProperty(content.window.HTMLElement.prototype, "scrollHeight", { get: height });
        Object.defineProperty(content.window.HTMLElement.prototype, "scrollWidth", { get: () => 888 });
        if (!options.pendingFrame) queueMicrotask(() => element.onload?.());
      } });
    }
    return element;
  };
  const OriginalImage = globalThis.Image;
  globalThis.Image = class {
    set src(value) { captures.push(decodeURIComponent(value.split(",").slice(1).join(","))); queueMicrotask(() => this.onload?.()); }
    removeAttribute() {} naturalWidth = 1080; naturalHeight = 1440;
  };
  t.mock.method(globalThis, "fetch", () => assert.fail("no external request is allowed"));
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  dom.window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
    canvases.push({ canvas: this, width: this.width, height: this.height, type, finish: callback });
    if (!options.pendingPng) callback(options.badBlob ? null : png());
  };
  t.after(() => { globalThis.Image = OriginalImage; frames.forEach(({ content }) => content.window.close()); dom.window.close(); });
  return { frames, captures, canvases };
}

test("same-page rendering preserves decorated body, image, header, footer, dimensions and identity", async (t) => {
  const f = fixture(t), original = source(), before = original.riskTemplate.svg;
  const result = await renderRiskPage(note, original);
  assert.equal(result.id, original.id); assert.equal(result.name, original.name); assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  assert.equal(original.riskTemplate.svg, before); assert.equal(result.riskTemplate, original.riskTemplate);
  const actual = new DOMParser().parseFromString(f.captures[0], "image/svg+xml");
  assert.equal(actual.querySelector("parsererror")?.textContent, undefined);
  assert.equal(actual.querySelector(".risk-note strong").textContent, note.title);
  assert.equal(actual.querySelector(".risk-note p").textContent, note.text);
  assert.equal(actual.querySelector("section").outerHTML, new DOMParser().parseFromString(before, "image/svg+xml").querySelector("section").outerHTML);
  assert.equal(actual.querySelector("header").textContent, "03"); assert.equal(actual.querySelector("footer").textContent, "原署名3 / 3");
  assert.equal(actual.querySelector(".risk-note").style.display, "block"); assert.equal(actual.querySelector(".risk-note p").style.height, "auto");
  assert.equal(f.canvases[0].width, 1080); assert.equal(f.canvases[0].height, 1440); assert.equal(f.canvases[0].canvas.width, 0);
  assert.match(f.frames[0].html, /default-src 'none'/); assert.equal(f.frames[0].element.getAttribute("sandbox"), "allow-same-origin");
  assert.equal(document.querySelectorAll("iframe").length, 0);
});

test("disabling risk removes only that block and returns the same existing page", async (t) => {
  const f = fixture(t), original = source();
  const result = await renderRiskPage({ ...note, enabled: false, text: "待修改的内容".repeat(1500) }, original);
  const actual = new DOMParser().parseFromString(f.captures[0], "image/svg+xml");
  assert.equal(actual.querySelector(".risk-note"), null); assert.match(actual.querySelector("section").textContent, /正文不能改/);
  assert.equal(actual.querySelector(".article-flow").style.height, "auto", "removing a placeholder must release its captured height before measuring");
  assert.equal(result.id, original.id); assert.equal(f.canvases.length, 1);
});

test("literal HTML-looking risk text remains text, including blank lines and punctuation", async (t) => {
  const f = fixture(t), text = '<img src="https://evil.test/track" onerror="alert(1)">\n\n  & 保留';
  await renderRiskPage({ ...note, text }, source());
  const actual = new DOMParser().parseFromString(f.captures[0], "image/svg+xml");
  assert.equal(actual.querySelector(".risk-note p").textContent, text); assert.equal(actual.querySelectorAll("img").length, 1);
});

test("oversized risk is rejected before image decoding or PNG output without clipping or adding a page", async (t) => {
  const f = fixture(t, { overflow: true });
  await assert.rejects(renderRiskPage(note, source()), /超出当前末页空间/);
  assert.deepEqual(f.captures, []); assert.deepEqual(f.canvases, []); assert.equal(document.querySelectorAll("iframe").length, 0);
  await assert.rejects(renderRiskPage({ ...note, text: " " }, source()), /请填写/);
  await assert.rejects(renderRiskPage({ ...note, text: "字".repeat(6001) }, source()), /最多 6000/);
});

test("unsafe templates are rejected while detached before any frame or image is created", async (t) => {
  const f = fixture(t);
  for (const svg of [
    template().replace("<header>", '<script>alert(1)</script><header>'),
    template().replace('alt="图片"', 'alt="图片" onload="alert(1)"'),
    template().replace("data:image/png;base64,ZmFrZQ==", "https://evil.test/image"),
    template().replace("data:image/png;base64,ZmFrZQ==", "data:image/svg+xml;base64,PHN2Zy8+"),
    template().replace("background:gold", "background:url(https://evil.test/image)"),
    template().replace("background:gold", "background:u\\72l(https://evil.test/image)"),
    template().replace("background:gold", "background:image-set(&quot;https://evil.test/image&quot; 1x)"),
    template().replace(".test::after", '@import "https://evil.test/style";.test::after'),
    template().replace("<header>", '<iframe src="https://evil.test"/><header>'),
    template().replace('viewBox="0 0 1080 1440"', 'viewBox="0 0 100 100"'),
    template().replace("<svg ", '<svg onload="alert(1)" '),
    template().replace('xmlns="http://www.w3.org/1999/xhtml"', 'xmlns="http://www.w3.org/2000/svg"'),
  ]) await assert.rejects(renderRiskPage(note, source(svg)), /模板不完整|外部资源/);
  assert.deepEqual(f.frames, []); assert.deepEqual(f.captures, []);
});

test("embedded raster and font resources with decoration CSS are accepted", (t) => {
  fixture(t);
  const svg = template().replace(".test::after", '@font-face{font-family:embedded;src:url("data:application/font-woff;base64,ZmFrZQ==")} .test::after');
  assert.equal(parseRiskTemplate(svg, 1080, 1440).poster.localName, "article");
});

test("cancellation during font preparation or PNG encoding cleans up staged DOM and canvas", async (t) => {
  for (const stage of ["fonts", "png"]) await t.test(stage, async (t) => {
    const f = fixture(t, stage === "fonts" ? { fonts: new Promise(() => {}) } : { pendingPng: true }), controller = new AbortController();
    const result = renderRiskPage(note, source(), controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("已取消")); await assert.rejects(result, /已取消/);
    assert.equal(document.querySelectorAll("iframe").length, 0);
    if (stage === "png") { assert.equal(f.canvases[0].canvas.width, 0); f.canvases[0].finish(png()); }
  });
});

test("measurement without layout and failed PNG encoding cannot become a successful image", async (t) => {
  const f = fixture(t, { badBlob: true });
  const node = document.createElement("article"); node.innerHTML = '<div class="article-viewport"><div class="article-flow"></div></div>';
  assert.throws(() => assertRiskFits(node), /排版尚未准备好/);
  await assert.rejects(renderRiskPage(note, source()), /末页图片生成失败/);
  assert.equal(f.canvases[0].canvas.width, 0);
});

test("PNG encoding timeout rejects and disposes the frame and canvas", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { pendingPng: true });
  const result = renderRiskPage(note, source()), rejected = assert.rejects(result, /末页图片生成超时/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.canvases.length, 1);
  t.mock.timers.tick(20_001); await rejected;
  assert.equal(document.querySelectorAll("iframe").length, 0); assert.equal(f.canvases[0].canvas.width, 0);
});
