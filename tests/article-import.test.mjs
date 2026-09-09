import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { extractArticle, extractRichTextFragment } = loadDomModule("lib/richText/importArticle.ts");
const parse = (html) => new DOMParser().parseFromString(html, "text/html");
test.after(() => dom.window.close());

test("a small WeChat article imports even when surrounding website scripts exceed the rich-text limit", () => {
  const source = `<!doctype html><html><head><meta property="og:title" content="  行业观察  "><script>${"x".repeat(1_100_000)}</script></head><body><nav>${"导航".repeat(20_000)}</nav><div id="js_content"><p>这里是需要导入的正文。</p><p>只提取公众号文章内容。</p></div><script>window.websiteOnly = true;</script></body></html>`;
  const result = extractArticle(source, true);
  const article = parse(result.html);
  assert.equal(result.title, "行业观察");
  assert.equal(article.body.textContent, "这里是需要导入的正文。只提取公众号文章内容。");
  assert.equal(article.querySelector("script,nav,meta"), null);
});

test("large scripts inside the selected article are removed before checking body limits", () => {
  const source = `<html><body><div id="js_content"><p>第一段正文。</p><script>${"x".repeat(1_100_000)}</script><style>.website-widget { display: none; }</style><p>第二段正文。</p><noscript>网页降级提示。</noscript></div></body></html>`;
  const result = extractArticle(source, true);
  const article = parse(result.html);
  assert.equal(article.body.textContent, "第一段正文。第二段正文。");
  assert.equal(article.querySelector("script,style,noscript"), null);
});

test("article extraction keeps metadata, colored text and lazy-loaded article images", () => {
  const imageUrl = "https://mmbiz.qpic.cn/mmbiz_png/example/article.png?wx_fmt=png";
  const source = `<html><head><meta property="og:title" content="行业 &amp; 公司"><meta property="og:description" content="  本期  行业观察  "></head><body><h1>网页备用标题</h1><div id="js_content"><h2>一、需求变化</h2><p><span style="color:#cc2244;font-size:16px;line-height:18px">需要保留的强调颜色</span></p><img data-src="${imageUrl}" alt="行业图表"></div></body></html>`;
  const result = extractArticle(source, true);
  const article = parse(result.html);
  assert.equal(result.title, "行业 & 公司");
  assert.equal(result.subtitle, "本期 行业观察");
  assert.equal(article.querySelector("h2")?.textContent, "一、需求变化");
  assert.equal(article.querySelector("span")?.style.color, "rgb(204, 34, 68)");
  assert.equal(article.querySelector("span")?.style.lineHeight, "");
  const image = article.querySelector("img");
  assert.ok(image);
  assert.equal(image.alt, "行业图表");
  assert.equal(image.getAttribute("src"), `/api/image?url=${encodeURIComponent(imageUrl)}`);
  assert.equal(image.hasAttribute("data-src"), false);
});

test("article image paths resolve against the final article URL, including redirects and lazy images", () => {
  const source = '<article><p>文章配图。</p><img src="/images/cover.jpg"><img src="../charts/revenue.png"><img data-src="charts/profit.webp"></article>';
  const result = extractArticle(source, true, "https://news.example.com/reports/2026/market.html");
  const images = [...parse(result.html).querySelectorAll("img")];
  assert.deepEqual(images.map((image) => new URL(image.getAttribute("src"), window.location.href).searchParams.get("url")), [
    "https://news.example.com/images/cover.jpg",
    "https://news.example.com/reports/charts/revenue.png",
    "https://news.example.com/reports/2026/charts/profit.webp",
  ]);
});

test("an article base URL is resolved before unsafe document elements are removed", () => {
  const source = '<html><head><base href="../assets/"></head><body><article><p>图表。</p><img src="chart.png"></article></body></html>';
  const result = extractArticle(source, true, "https://news.example.com/reports/article.html");
  const article = parse(result.html);
  const image = article.querySelector("img");
  assert.equal(new URL(image.getAttribute("src"), window.location.href).searchParams.get("url"), "https://news.example.com/assets/chart.png");
  assert.equal(article.querySelector("base"), null);
});

test("reimporting existing image proxies does not add another proxy layer", () => {
  const original = "https://images.example.com/chart.png?width=900&format=png";
  const proxy = `/api/image?url=${encodeURIComponent(original)}`;
  for (const source of [proxy, new URL(proxy, window.location.href).href]) {
    let html = `<p>已有正文。</p><img src="${source}">`;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      html = extractRichTextFragment(html, true, false).html;
      assert.equal(parse(html).querySelector("img").getAttribute("src"), proxy);
    }
  }
});

test("a different website's image endpoint remains an external image source", () => {
  const original = "https://news.example.com/api/image?url=https%3A%2F%2Fcdn.example.com%2Fchart.png";
  const result = extractArticle(`<article><p>外站图片。</p><img src="${original}"></article>`, true, "https://news.example.com/article");
  assert.equal(parse(result.html).querySelector("img").getAttribute("src"), `/api/image?url=${encodeURIComponent(original)}`);
});

test("website payloads above 6 MiB are rejected before DOM parsing, including multibyte text", () => {
  const originalParser = globalThis.DOMParser;
  let parseAttempts = 0;
  globalThis.DOMParser = class {
    constructor() {
      parseAttempts += 1;
      throw new Error("DOM parsing must not run for an oversized website");
    }
  };
  try {
    for (const source of ["x".repeat(6 * 1024 * 1024 + 1), "文".repeat(2 * 1024 * 1024 + 1)]) {
      assert.throws(() => extractArticle(source, true), /过大|超过/);
    }
    assert.equal(parseAttempts, 0);
  } finally {
    globalThis.DOMParser = originalParser;
  }
});

test("selecting the article does not relax the actual body HTML, text, node or nesting limits", () => {
  const bodies = [
    [`<p title="${"x".repeat(1_000_001)}">正文。</p>`, /HTML 源码/],
    [`<p>${"文".repeat(30_001)}</p>`, /正文超过/],
    ["<span>文</span>".repeat(2_501), /节点超过/],
    ["<section>".repeat(65) + "正文。" + "</section>".repeat(65), /嵌套超过/],
  ];
  for (const [body, message] of bodies) {
    assert.throws(() => extractArticle(`<html><body><div id="js_content">${body}</div></body></html>`, true), message);
  }
});

test("rich-text fragments retain their stricter pre-parse source-size protection", () => {
  const source = `<p>正文。</p><script>${"x".repeat(1_000_001)}</script>`;
  const originalParser = globalThis.DOMParser;
  let parseAttempts = 0;
  globalThis.DOMParser = class {
    constructor() {
      parseAttempts += 1;
      throw new Error("DOM parsing must not run for an oversized fragment");
    }
  };
  try {
    assert.throws(() => extractRichTextFragment(source, true, false), /HTML 源码/);
    assert.equal(parseAttempts, 0);
  } finally {
    globalThis.DOMParser = originalParser;
  }
});

test("fragment imports still reject excessive body text and preserve normal title inference", () => {
  assert.throws(() => extractRichTextFragment(`<p>${"文".repeat(30_001)}</p>`, true, true), /正文超过/);
  const result = extractRichTextFragment("<h1>行业观察</h1><p><span style=\"color:#cc2244\">正常正文。</span></p>", true, true);
  assert.equal(result.title, "行业观察");
  assert.equal(result.inferredTitle, true);
  const article = parse(result.html);
  assert.equal(article.body.textContent, "正常正文。");
  assert.equal(article.querySelector("h1"), null);
  assert.equal(article.querySelector("span")?.style.color, "rgb(204, 34, 68)");
});

test("the rich-text import dialog accepts an embedded image over the old HTML limit without losing surrounding content", () => {
  const imageSource = `data:image/png;base64,${Buffer.alloc(800 * 1024).toString("base64")}`;
  const source = `<h1>带图片的文章</h1><p><strong>图片前的正文。</strong></p><img src="${imageSource}" alt="插入的配图"><p>图片后的正文。</p>`;
  assert.ok(source.length > 1_000_000);
  const result = extractRichTextFragment(source, true, true);
  const article = parse(result.html);
  assert.equal(result.title, "带图片的文章");
  assert.equal(article.querySelectorAll("img").length, 1);
  assert.ok(article.querySelector("img").getAttribute("src") === imageSource);
  assert.equal(article.querySelector("img").alt, "插入的配图");
  assert.equal(article.querySelector("strong").textContent, "图片前的正文。");
  assert.equal(article.body.textContent, "图片前的正文。图片后的正文。");
});
