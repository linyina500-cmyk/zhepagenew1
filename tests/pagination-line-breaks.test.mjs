import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { paginateArticle } = loadDomModule("lib/pagination/paginateArticle.ts");
const { splitTextPreservingDom } = loadDomModule("lib/pagination/splitText.ts");
test.after(() => dom.window.close());

function body(html) {
  return new DOMParser().parseFromString(html, "text/html").body;
}

function contentSequence(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let result = "";
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) result += node.textContent;
    else if (node.matches("br:not(.ProseMirror-trailingBreak)")) result += "\n";
    node = walker.nextNode();
  }
  return result;
}

function measureContent() {
  const measure = document.createElement("div");
  let probes = 0;
  Object.defineProperty(measure, "scrollHeight", {
    get() {
      assert.ok(++probes < 2_000, "pagination must make progress through consecutive line breaks");
      return measure.textContent.length + measure.querySelectorAll("br").length * 10;
    },
  });
  return measure;
}

test("consecutive ShiftEnter breaks survive pagination at their original position", () => {
  const source = "<p>A<br><br>B</p>";
  const { pages } = paginateArticle(source, measureContent(), 12);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => contentSequence(body(page))), ["A\n", "\nB"]);
  assert.equal(body(pages.join("")).querySelectorAll("br").length, 2);
});

test("line-break fragments retain the full inline emphasis and color ancestors", () => {
  const source = '<p><strong><span style="color:red">AB<br data-break="first"><br data-break="second">CD</span></strong></p>';
  const { pages } = paginateArticle(source, measureContent(), 12);
  assert.ok(pages.length > 1);
  const output = body(pages.join(""));
  assert.equal(contentSequence(output), "AB\n\nCD");
  assert.deepEqual([...output.querySelectorAll("br")].map((element) => element.getAttribute("data-break")), ["first", "second"]);
  for (const paragraph of output.querySelectorAll("p")) {
    const styled = paragraph.querySelector("strong > span");
    assert.equal(styled?.getAttribute("style"), "color:red");
    assert.equal(contentSequence(styled), contentSequence(paragraph));
  }
});

test("leading and trailing authored breaks each remain in exactly one page fragment", () => {
  const source = '<p><br data-break="start"><strong>A</strong><br data-break="middle">B<br data-break="end"></p>';
  const { pages } = paginateArticle(source, measureContent(), 12);
  assert.ok(pages.length > 1);
  const output = body(pages.join(""));
  assert.equal(contentSequence(output), "\nA\nB\n");
  assert.deepEqual([...output.querySelectorAll("br")].map((element) => element.getAttribute("data-break")), ["start", "middle", "end"]);
  assert.equal(output.querySelector("strong")?.textContent, "A");
});

test("ProseMirror cursor placeholders are excluded without removing the authored trailing break", () => {
  for (const source of [
    '<p>A<br data-break="authored"><br class="ProseMirror-trailingBreak"></p>',
    '<p><br data-break="authored"><br class="ProseMirror-trailingBreak"></p>',
    '<p><br class="ProseMirror-trailingBreak"></p>',
  ]) {
    const original = body(source).firstElementChild;
    const pieces = splitTextPreservingDom(original, measureContent(), 5, 5);
    const output = body(pieces.map((piece) => piece.outerHTML).join(""));
    assert.equal(contentSequence(output), contentSequence(original));
    assert.equal(output.querySelectorAll("br.ProseMirror-trailingBreak").length, 0);
    assert.equal(output.querySelectorAll("br[data-break='authored']").length, original.querySelectorAll("br[data-break='authored']").length);
    assert.equal(original.outerHTML, source, "splitting must not mutate the editor source");
  }
});

test("Unicode graphemes stay intact with and without authored line breaks", () => {
  const run = "👩🏽‍💻e\u0301🇨🇳𠮷";
  for (const content of [run.repeat(5), `${run}<br><br>${run}<br>${run}`]) {
    const source = `<p><strong><span style="color:blue">${content}</span></strong></p>`;
    const expected = contentSequence(body(source));
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(expected)].map(({ index }) => index));
    boundaries.add(expected.length);
    const { pages } = paginateArticle(source, measureContent(), 12);
    assert.ok(pages.length > 1);
    assert.equal(contentSequence(body(pages.join(""))), expected);
    let offset = 0;
    for (const paragraph of body(pages.join("")).querySelectorAll("p")) {
      offset += contentSequence(paragraph).length;
      assert.ok(boundaries.has(offset), "each fragment must end at a complete grapheme or authored break");
      assert.equal(contentSequence(paragraph.querySelector("strong > span")), contentSequence(paragraph));
    }
    assert.equal(offset, expected.length);
  }
});
