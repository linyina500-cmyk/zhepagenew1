import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { paginateArticle } = loadDomModule("lib/pagination/paginateArticle.ts");
const { assertPaginationSemantics } = loadDomModule("lib/pagination/semanticIntegrity.ts");
const { articleBlocks } = loadDomModule("lib/pagination/articleBlocks.ts");
const { splitOversizedBlock } = loadDomModule("lib/pagination/splitDomBlock.ts");
test.after(() => dom.window.close());

function body(html) {
  return new DOMParser().parseFromString(html, "text/html").body;
}

function measureContent(unit = 1) {
  const measure = document.createElement("div");
  let probes = 0;
  const height = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.length * unit;
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.classList.contains("manual-empty-line")) return 20;
    if (node.tagName === "IMG") return 30;
    return [...node.childNodes].reduce((total, child) => total + height(child), 0);
  };
  Object.defineProperty(measure, "scrollHeight", {
    get() {
      assert.ok(++probes < 5_000, "pagination must make progress for whitespace and Unicode content");
      return height(measure);
    },
  });
  return measure;
}

function paragraphLines(text) {
  return text.split(/\r?\n/).filter((line) => line.length).map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph.outerHTML;
  }).join("");
}

test("the reported seven-section article paginates with its five NBSP-only separators", () => {
  const text = readFileSync(new URL("./fixtures/a-share-pressure-article.txt", import.meta.url), "utf8");
  const lines = text.split(/\r?\n/);
  assert.equal(lines.filter((line) => /^\u00a0+$/.test(line)).length, 5);
  const html = paragraphLines(text);
  const { pages } = paginateArticle(html, measureContent(), 400);
  assert.ok(pages.length > 1);
  // Ignore only standalone blank source lines; spaces inside article sentences
  // remain part of the exact expected text, including English names and arrows.
  assert.equal(body(pages.join("")).textContent, lines.filter((line) => line.trim()).join(""));
  assert.doesNotThrow(() => assertPaginationSemantics(html, pages));
});

test("ordinary blank paragraphs retain their spacing even inside styled wrappers", () => {
  const blanks = [
    "<p></p>", "<p> </p>", "<p>\n\t</p>", "<p>&nbsp;</p>",
    "<p>&nbsp; &nbsp;</p>", "<p><br></p>",
    '<p><strong><span style="color:red">&nbsp;</span></strong></p>',
    '<section style="color:red"><div><p>&nbsp;</p></div></section>',
  ];
  for (const blank of blanks) {
    const source = `<p>前文</p>${blank}<p>后文</p>`;
    assert.throws(() => assertPaginationSemantics(source, ["<p>前文</p><p>后文</p>"]), /空行|换行/, blank);
    const { pages } = paginateArticle(source, measureContent(), 100);
    const output = body(pages.join(""));
    assert.equal(output.textContent, "前文后文", blank);
    assert.equal(output.querySelectorAll(".manual-empty-line,br").length, 1, blank);
  }
});

test("pretty-printing whitespace can disappear while real English spaces and emphasis survive pagination", () => {
  const source = '<section style="color:#333">\n  <p><strong>English</strong> <em>words</em> '
    + '<span style="color:red">stay spaced</span>.</p>\n  <p>下一段</p>\n</section>';
  const { pages } = paginateArticle(source, measureContent(4), 60);
  assert.ok(pages.length > 1);
  assert.equal(body(pages.join("")).textContent, "English words stay spaced.下一段");
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("removing actual spaces between words or across emphasis boundaries still fails integrity", () => {
  const examples = [
    ["<p>Hello world</p>", "<p>Helloworld</p>"],
    ["<p>Hello <strong>world</strong></p>", "<p>Hello<strong>world</strong></p>"],
    ["<p><strong>New</strong> <em>York</em></p>", "<p><strong>New</strong><em>York</em></p>"],
    ["<p>New&nbsp;York</p>", "<p>NewYork</p>"],
  ];
  for (const [source, output] of examples) assert.throws(() => assertPaginationSemantics(source, [output]));
});

test("a generated whitespace-only continuation retains the original space between words", () => {
  const source = "<p>Hello <strong>world</strong></p>";
  const pages = [
    '<p data-pagination-fragment="start">Hello</p>',
    '<p data-pagination-fragment="middle"> </p>',
    '<p data-pagination-fragment="end"><strong>world</strong></p>',
  ];
  assert.equal(body(pages.join("")).textContent, "Hello world");
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
  assert.throws(() => assertPaginationSemantics(source, [pages[0], pages[2]]));
});

test("empty styled separators do not hide genuine color or emphasis changes", () => {
  const source = '<p><strong>前文</strong></p><p><strong><span style="color:red">&nbsp;</span></strong></p>'
    + '<p><span style="color:blue">后文</span></p>';
  const valid = '<p><strong>前文</strong></p><p class="manual-empty-line"></p><p><span style="color:blue">后文</span></p>';
  assert.doesNotThrow(() => assertPaginationSemantics(source, [valid]));
  assert.throws(() => assertPaginationSemantics(source, [valid.replace("color:blue", "color:green")]));
  assert.throws(() => assertPaginationSemantics(source, [valid.replace("<strong>前文</strong>", "前文")]));
});

test("a text split cannot put an emoji's surrogate halves on different pages", () => {
  const source = "<p>123456789😀结束</p>";
  const { pieces } = splitOversizedBlock(source, measureContent(10), 100, 100);
  assert.ok(pieces.length > 1);
  assert.equal(body(pieces.join("")).textContent, body(source).textContent);
  for (const piece of pieces) {
    const text = body(piece).textContent;
    assert.ok(Array.from(text).every((character) => character.length > 1 || !/[\ud800-\udfff]/.test(character)), "each page must contain complete Unicode characters");
  }
});

test("combined emoji stay intact when a page boundary falls inside a visible grapheme", () => {
  const text = "12345👩🏽‍💻结束";
  const source = `<p>${text}</p>`;
  const { pieces } = splitOversizedBlock(source, measureContent(10), 100, 100);
  assert.ok(pieces.length > 1);
  assert.equal(body(pieces.join("")).textContent, text);
  const boundaries = new Set([...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text)].map(({ index }) => index));
  boundaries.add(text.length);
  let offset = 0;
  for (const piece of pieces) {
    offset += body(piece).textContent.length;
    assert.ok(boundaries.has(offset), "a page must end at a complete visible character, including skin tones and joined emoji");
  }
});

test("missing duplicated replaced or reordered images fail even when body text is identical", () => {
  const text = "<p>同一段正文</p>";
  const first = '<img src="https://example.com/first.png" alt="第一图">';
  const second = '<img src="https://example.com/second.png" alt="第二图">';
  const source = text + first + second;
  assert.doesNotThrow(() => assertPaginationSemantics(source, [text + first, second]));
  for (const output of [
    text, text + first, text + first + first + second,
    text + first + second.replace("second.png", "different.png"),
    text + second + first,
  ]) assert.throws(() => assertPaginationSemantics(source, [output]), "text equality must not conceal image changes");
});

test("image-only articles receive the same preservation check as articles with text", () => {
  const image = '<img src="https://example.com/only.png" alt="唯一图片">';
  assert.doesNotThrow(() => assertPaginationSemantics(image, [image]));
  assert.throws(() => assertPaginationSemantics(image, []));
  assert.throws(() => assertPaginationSemantics(image, [image.replace("only.png", "other.png")]));
});

test("images between long paragraphs keep their order and source when the wrapper splits", () => {
  const source = `<section style="color:#333"><p>${"甲".repeat(95)}</p>`
    + '<img src="https://example.com/first.png"><p>' + "乙".repeat(95) + "</p>"
    + '<img src="https://example.com/second.png"></section>';
  const { pages } = paginateArticle(source, measureContent(), 100);
  assert.ok(pages.length > 1);
  const output = body(pages.join(""));
  assert.equal(output.textContent, "甲".repeat(95) + "乙".repeat(95));
  assert.deepEqual([...output.querySelectorAll("img")].map((image) => image.getAttribute("src")), [
    "https://example.com/first.png", "https://example.com/second.png",
  ]);
});

test("explicit manual empty lines survive block extraction and pagination", () => {
  for (const content of ["", "&nbsp;", "<br>"]) {
    const blank = `<p class="manual-empty-line">${content}</p>`;
    const source = `<p>前文</p>${blank}<p>后文</p>`;
    assert.equal(articleBlocks(source).length, 3);
    const { pages } = paginateArticle(source, measureContent(), 100);
    const output = body(pages.join(""));
    assert.equal(output.querySelectorAll(".manual-empty-line").length, 1);
    assert.equal(output.querySelector(".manual-empty-line").innerHTML, content);
    const onlyBlank = paginateArticle(blank, measureContent(), 100).pages.join("");
    assert.ok(body(onlyBlank).querySelector(".manual-empty-line"), "an explicitly added blank line is meaningful even without body text");
  }
});
