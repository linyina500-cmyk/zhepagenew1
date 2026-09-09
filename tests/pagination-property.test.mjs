import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { paginateArticle } = loadDomModule("lib/pagination/paginateArticle.ts");
const { assertPaginationSemantics } = loadDomModule("lib/pagination/semanticIntegrity.ts");
test.after(() => dom.window.close());

const words = fc.array(fc.constantFrom("正文", "English words", "New\u00a0York", "😀", "👩🏽‍💻", "e\u0301", "A&B", "<提示>", "4.8%"), { minLength: 1, maxLength: 10 });
const paragraph = fc.record({
  kind: fc.constant("paragraph"),
  words,
  separator: fc.constantFrom("", " ", "\u00a0"),
  depth: fc.integer({ min: 0, max: 3 }),
  color: fc.constantFrom("red", "blue", "#123456"),
  wrappers: fc.integer({ min: 0, max: 3 }),
  padding: fc.integer({ min: 0, max: 5 }),
});
const item = fc.oneof(paragraph, fc.constant({ kind: "blank" }), fc.constant({ kind: "image" }), fc.constant({ kind: "manual-space" }));

function escape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function fixture(items) {
  let expected = "";
  const html = items.map((entry, index) => {
    if (entry.kind === "blank") return '<section><p><strong>&nbsp;</strong></p></section>';
    if (entry.kind === "image") {
      const src = `https://example.com/fixture-${index}.png`;
      expected += `[image:${src}]`;
      return `<img src="${src}" alt="插图${index}">`;
    }
    if (entry.kind === "manual-space") {
      expected += "[manual-space]";
      return '<p class="manual-empty-line"></p>';
    }
    const text = entry.words.join(entry.separator);
    expected += text;
    let content = escape(text);
    for (let level = 0; level < entry.depth; level += 1) content = `<strong><span style="color:${entry.color}">${content}</span></strong>`;
    content = `<p>${content}</p>`;
    for (let level = 0; level < entry.wrappers; level += 1) content = `<section style="color:#333;padding:${entry.padding}px">${content}</section>`;
    return content;
  }).join("");
  return { html, expected };
}

function contentSequence(html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let output = "";
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) output += node.textContent;
    else if (node.tagName === "IMG") output += `[image:${node.getAttribute("src")}]`;
    else if (node.classList.contains("manual-empty-line")) output += "[manual-space]";
  }
  return output;
}

function measureContent(unit) {
  const measure = document.createElement("div");
  let probes = 0;
  const height = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.length * unit;
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.tagName === "IMG" || node.classList.contains("manual-empty-line")) return 24;
    return [...node.childNodes].reduce((sum, child) => sum + height(child), 0)
      + (Number.parseFloat(node.style.paddingTop) || 0) + (Number.parseFloat(node.style.paddingBottom) || 0);
  };
  Object.defineProperty(measure, "scrollHeight", {
    get() {
      assert.ok(++probes <= 8_000, "generated input must finish in a bounded number of measurements");
      return height(measure);
    },
  });
  return measure;
}

test("generated nested articles preserve text, image positions and explicit spacing", () => {
  fc.assert(fc.property(
    paragraph,
    fc.array(item, { minLength: 0, maxLength: 9 }),
    fc.integer({ min: 60, max: 180 }),
    fc.integer({ min: 1, max: 3 }),
    (first, rest, pageHeight, unit) => {
      // Expected content comes from the input records, not the production
      // integrity checker or a copy of its DOM normalization rules.
      const { html, expected } = fixture([first, ...rest]);
      const measure = measureContent(unit);
      const { pages } = paginateArticle(html, measure, pageHeight);
      assert.equal(contentSequence(pages.join("")), expected);
      assert.equal(measure.innerHTML, "");
    },
  ), { seed: 20260909, numRuns: 120 });
});

test("generated styled Unicode text only breaks at complete visible characters", () => {
  fc.assert(fc.property(words, fc.integer({ min: 30, max: 100 }), (tokens, pageHeight) => {
    const text = tokens.join(" ");
    const html = `<p><strong><span style="color:red">${escape(text)}</span></strong></p>`;
    const { pages } = paginateArticle(html, measureContent(3), pageHeight);
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ index }) => index));
    boundaries.add(text.length);
    let offset = 0;
    for (const page of pages) {
      const body = new DOMParser().parseFromString(page, "text/html").body;
      offset += body.textContent.length;
      assert.ok(boundaries.has(offset), "page boundary must preserve the full grapheme");
      assert.equal([...body.querySelectorAll("strong > span")].map((span) => span.textContent).join(""), body.textContent);
    }
    assert.equal(contentSequence(pages.join("")), text);
  }), { seed: 20260910, numRuns: 100 });
});

test("the integrity contract detects a real edit amid removable blank formatting", () => {
  fc.assert(fc.property(words, (tokens) => {
    const text = tokens.join(" ");
    const source = `<p>${escape(text)}</p><p><span style="color:red">&nbsp;</span></p><p>结尾</p>`;
    assert.doesNotThrow(() => assertPaginationSemantics(source, [`<p>${escape(text)}</p><p>结尾</p>`]));
    assert.throws(() => assertPaginationSemantics(source, [`<p>${escape(text)}</p><p>结</p>`]), /正文/);
    const image = '<img src="https://example.com/image.png">';
    assert.throws(() => assertPaginationSemantics(`<p>${escape(text)}</p>${image}<p>结尾</p>`, [`<p>${escape(text)}结尾</p>${image}`]), /图片/);
  }), { seed: 20260911, numRuns: 80 });
});
