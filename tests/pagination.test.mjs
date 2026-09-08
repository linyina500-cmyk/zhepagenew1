import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { paginateArticle } = await loadDomModule("lib/pagination/paginateArticle.ts");
const { articleBlocks } = await loadDomModule("lib/pagination/splitDomBlock.ts");

test.after(() => dom.window.close());

function createMeasure() {
  const measure = document.createElement("div");
  let measurements = 0;
  Object.defineProperty(measure, "scrollHeight", {
    get() {
      // Bound the reproduction so a regression fails instead of freezing the
      // test runner. The fixture heights model blocks that cannot share a page.
      assert.ok(++measurements <= 100, "pagination repeated the same layout without making progress");
      return [...measure.children].reduce((height, element) => (
        height + Number(element.getAttribute("data-height") || element.textContent.length)
      ), 0);
    },
  });
  return measure;
}

test("a heading and an unsplittable card that cannot share a page both finish", () => {
  const heading = '<h2 data-height="30">重点摘要</h2>';
  const card = '<section class="risk-note" data-height="90">需要完整保留的提示卡片</section>';
  const measure = createMeasure();
  const result = paginateArticle(heading + card, measure, 100);
  assert.deepEqual(result.pages, [heading, card]);
  assert.equal(measure.innerHTML, "");
});

test("consecutive headings that cannot share a page do not backtrack forever", () => {
  const first = '<h2 data-height="60">第一节</h2>';
  const second = '<h3 data-height="60">第二节</h3>';
  assert.deepEqual(paginateArticle(first + second, createMeasure(), 100).pages, [first, second]);
});

test("a heading before a tall image preserves both blocks and terminates", () => {
  const heading = '<h2 data-height="30">图表说明</h2>';
  const image = '<img data-height="140" src="https://example.com/chart.png" alt="图表">';
  assert.deepEqual(paginateArticle(heading + image, createMeasure(), 100).pages, [heading, image]);
});

test("a trailing heading still moves with its follower when the old page has text", () => {
  const paragraph = '<p data-height="50">已有正文</p>';
  const heading = '<h2 data-height="30">重点摘要</h2>';
  const card = '<section class="risk-note" data-height="50">完整提示卡片</section>';
  assert.deepEqual(
    paginateArticle(paragraph + heading + card, createMeasure(), 100).pages,
    [paragraph, heading + card],
  );
});

test("splittable rich text keeps all text and inline emphasis across pages", () => {
  const text = "公众号长文排版".repeat(35);
  const source = `<p><strong><span style="color: red">${text}</span></strong></p>`;
  const { pages } = paginateArticle(source, createMeasure(), 100);
  assert.ok(pages.length > 1);
  assert.equal(new DOMParser().parseFromString(pages.join(""), "text/html").body.textContent, text);
  for (const page of pages) {
    const parsed = new DOMParser().parseFromString(page, "text/html");
    assert.equal(parsed.querySelector("strong > span")?.textContent, parsed.body.textContent);
  }
});

test("bare text is escaped when converted into a paragraph for pagination", () => {
  const source = "收益 &lt; 风险 &amp; &lt;strong&gt;只是文字&lt;/strong&gt;";
  const blocks = articleBlocks(source);
  assert.equal(blocks.length, 1);
  const parsed = new DOMParser().parseFromString(blocks[0], "text/html");
  assert.equal(parsed.body.textContent, "收益 < 风险 & <strong>只是文字</strong>");
  assert.equal(parsed.querySelector("strong"), null);
  assert.doesNotThrow(() => paginateArticle(source, createMeasure(), 100));
});
