import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const dom = installDom();
const { paginateArticle, assertPaginationSemantics } = await loadDomModule("lib/pagination/paginateArticle.ts");
const { articleBlocks, TABLE_REPEAT_ATTRIBUTE, TABLE_SOURCE_ATTRIBUTE } = await loadDomModule("lib/pagination/splitDomBlock.ts");

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

function createBoxMeasure() {
  const measure = document.createElement("div");
  let measurements = 0;
  const heightOf = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.length;
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.hasAttribute("data-height")) return Number(node.getAttribute("data-height"));
    return [...node.childNodes].reduce((height, child) => height + heightOf(child), 0)
      + (Number.parseFloat(node.style.paddingTop) || 0)
      + (Number.parseFloat(node.style.paddingBottom) || 0);
  };
  Object.defineProperty(measure, "scrollHeight", {
    get() {
      assert.ok(++measurements <= 500, "nested pagination must make bounded progress");
      return [...measure.childNodes].reduce((height, node) => height + heightOf(node), 0);
    },
  });
  return measure;
}

function pageBody(html) {
  return new DOMParser().parseFromString(html, "text/html").body;
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

test("paragraphs exposed from a painted wrapper keep filling the current page", () => {
  const prefix = '<p data-height="20">已有正文</p>';
  const paragraphs = ["甲", "乙", "丙", "丁", "戊"].map((text) => `<p data-height="20">${text}</p>`).join("");
  const { pages, usage } = paginateArticle(
    `${prefix}<section style="background:#fff">${paragraphs}</section>`,
    createBoxMeasure(),
    100,
  );
  assert.deepEqual(usage, [1, 0.2]);
  assert.deepEqual(pages.map((page) => pageBody(page).textContent), ["已有正文甲乙丙丁", "戊"]);
});

test("splitting a wrapper does not isolate its first heading before its paragraphs", () => {
  const prefix = '<p data-height="20">已有正文</p>';
  const heading = '<h3 data-height="20">第二节</h3>';
  const paragraphs = ["甲", "乙", "丙", "丁"].map((text) => `<p data-height="20">${text}</p>`).join("");
  const { pages, usage } = paginateArticle(
    `${prefix}<section style="background:#fff">${heading}${paragraphs}</section>`,
    createBoxMeasure(),
    100,
  );
  assert.deepEqual(usage, [1, 0.2]);
  assert.equal(pageBody(pages[0]).textContent, "已有正文第二节甲乙丙");
  assert.ok(pageBody(pages[0]).querySelector("h3"));
});

test("text inside nested padded wrappers is measured with its full ancestor shells", () => {
  const text = "文".repeat(160);
  const source = '<p data-height="20">已有正文</p>'
    + `<section style="background:#fff;padding:10px"><div style="padding:10px"><p><strong>${text}</strong></p></div></section>`;
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  // Text plus the wrapper edges fits in three pages. Measuring the bare inner
  // paragraph first used to duplicate padded fragments and need seven pages.
  assert.equal(pages.length, 3);
  assert.ok(usage.slice(0, -1).every((value) => value >= 0.9));
  assert.ok(usage.every((value) => value <= 1.02));
  assert.equal(pageBody(pages.join("")).textContent, `已有正文${text}`);
  assert.equal(pages.map((page) => pageBody(page).querySelector("strong")?.textContent || "").join(""), text);
  for (const page of pages) assert.equal(pageBody(page).querySelectorAll("section").length, 1);
});

test("sentence-boundary preference cannot leave most of the remaining page empty", () => {
  const prefix = '<p data-height="20">已有正文</p>';
  const text = `${"甲".repeat(14)}。${"乙".repeat(160)}`;
  const { pages, usage } = paginateArticle(`${prefix}<p><strong>${text}</strong></p>`, createBoxMeasure(), 100);
  assert.equal(pages.length, 2);
  assert.ok(usage[0] >= 0.9);
  assert.equal(pageBody(pages.join("")).textContent, `已有正文${text}`);

  const nearbyBoundary = `${"甲".repeat(74)}。${"乙".repeat(100)}`;
  const nearby = paginateArticle(`${prefix}<p>${nearbyBoundary}</p>`, createBoxMeasure(), 100);
  assert.equal(pageBody(nearby.pages[0]).querySelector("p:last-child").textContent, `${"甲".repeat(74)}。`);
  assert.ok(nearby.usage[0] >= 0.9);
});

function tableRows(labels, height = 20) {
  return labels.map((label) => `<tr data-height="${height}"><td>${label}</td></tr>`).join("");
}

test("a table uses the current page's remaining space and repeats its verified header", () => {
  const source = '<p data-height="20">已有正文</p><table><thead><tr data-height="10"><th>列名</th></tr></thead>'
    + `<tbody>${tableRows(["甲", "乙", "丙", "丁"])}</tbody></table>`;
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  assert.deepEqual(usage, [0.9, 0.3]);
  assert.deepEqual(pages.map((page) => [...pageBody(page).querySelectorAll("tbody td")].map((cell) => cell.textContent)), [
    ["甲", "乙", "丙"], ["丁"],
  ]);
  assert.ok(pages.every((page) => pageBody(page).querySelector("thead").textContent === "列名"));
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("table rows are measured with the first and last padding of ancestor wrappers", () => {
  const source = `<section style="padding:30px"><table><tbody>${tableRows(["甲", "乙", "丙", "丁", "戊", "己"], 30)}</tbody></table></section>`;
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  assert.deepEqual(usage, [0.9, 0.9, 0.6]);
  assert.equal(pageBody(pages.join("")).textContent, "甲乙丙丁戊己");
  const wrappers = pages.map((page) => pageBody(page).querySelector("section"));
  assert.equal(wrappers[0].style.paddingTop, "30px");
  assert.equal(wrappers[0].style.paddingBottom, "0px");
  assert.equal(wrappers[1].style.paddingTop, "0px");
  assert.equal(wrappers[1].style.paddingBottom, "0px");
  assert.equal(wrappers[2].style.paddingTop, "0px");
  assert.equal(wrappers[2].style.paddingBottom, "30px");
});

test("long tables retain captions, column widths, styled headers and a single final footer", () => {
  const source = `<table>
    <caption data-height="5"><strong>统计标题</strong></caption>
    <colgroup><col style="width:100%"></colgroup>
    <thead><tr data-height="10"><th><span style="color:red">项目</span></th></tr></thead>
    <tbody>${tableRows(["甲", "乙", "丙", "丁", "戊"])}</tbody>
    <tfoot><tr data-height="15"><td><em>合计</em></td></tr></tfoot>
  </table>`;
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  assert.deepEqual(usage, [0.95, 0.5]);
  const bodies = pages.map(pageBody);
  assert.ok(bodies.every((body) => body.querySelector("caption strong")?.textContent === "统计标题"));
  assert.ok(bodies.every((body) => body.querySelector("thead span")?.getAttribute("style") === "color:red"));
  assert.ok(bodies.every((body) => body.querySelector("col")?.style.width === "100%"));
  assert.equal(bodies[0].querySelector("tfoot"), null);
  assert.equal(bodies[1].querySelector("tfoot em")?.textContent, "合计");
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("an inferred all-TH first row can repeat without reporting duplicated body text", () => {
  const source = '<table><tbody><tr data-height="10"><th><strong>项目</strong></th></tr>'
    + tableRows(["甲", "乙", "丙", "丁", "戊"]) + "</tbody></table>";
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  assert.deepEqual(usage, [0.9, 0.3]);
  assert.ok(pages.every((page) => pageBody(page).querySelector("thead strong")?.textContent === "项目"));
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("a footer can continue after the last body row instead of overflowing with it", () => {
  const source = '<table><thead><tr data-height="10"><th>项目</th></tr></thead><tbody>'
    + tableRows(["甲"], 60) + tableRows(["乙"], 30)
    + '</tbody><tfoot><tr data-height="70"><td>统计说明</td></tr></tfoot></table>';
  const { pages, usage } = paginateArticle(source, createBoxMeasure(), 100);
  assert.deepEqual(usage, [1, 0.8]);
  assert.equal(pageBody(pages[0]).querySelector("tfoot"), null);
  assert.equal(pageBody(pages[0]).querySelector("tbody").textContent, "甲乙");
  assert.equal(pageBody(pages[1]).querySelector("tfoot").textContent, "统计说明");
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));

  const singleRow = '<table><thead><tr data-height="10"><th>项目</th></tr></thead><tbody>'
    + tableRows(["甲"], 70) + '</tbody><tfoot><tr data-height="30"><td>统计说明</td></tr></tfoot></table>';
  assert.deepEqual(paginateArticle(singleRow, createBoxMeasure(), 100).usage, [0.8, 0.4]);
});

test("repeat markers cannot hide changed body content or another table's header", () => {
  const source = '<table><thead><tr data-height="10"><th>表一标题</th></tr></thead>'
    + `<tbody>${tableRows(["甲", "乙", "丙", "丁", "戊"])}</tbody></table>`
    + '<table><thead><tr data-height="10"><th>表二标题</th></tr></thead>'
    + `<tbody>${tableRows(["己"])}</tbody></table>`;
  const { pages } = paginateArticle(source, createBoxMeasure(), 100);
  const changed = pages.map(pageBody);
  const continuation = changed.flatMap((body) => [...body.querySelectorAll(`table[${TABLE_SOURCE_ATTRIBUTE}="0"] thead[${TABLE_REPEAT_ATTRIBUTE}]`)])[0];
  assert.ok(continuation);
  continuation.querySelector("th").textContent = "表二标题";
  assert.throws(() => assertPaginationSemantics(source, changed.map((body) => body.innerHTML)), /续表表头或标题与原表不一致/);

  const hiddenBody = pages.map(pageBody);
  hiddenBody[0].querySelector("tbody tr").setAttribute(TABLE_REPEAT_ATTRIBUTE, "true");
  assert.throws(() => assertPaginationSemantics(source, hiddenBody.map((body) => body.innerHTML)), /续表表头或标题与原表不一致/);
  const missingBody = pages.map(pageBody);
  missingBody[0].querySelector("tbody tr").remove();
  assert.throws(() => assertPaginationSemantics(source, missingBody.map((body) => body.innerHTML)), /正文/);
});


test("nested identical color spans remain equivalent when a page splits the inner span", () => {
  const first = "甲".repeat(100);
  const middle = "乙".repeat(100);
  const last = "丙".repeat(100);
  const source = `<p><span style="color:red">${first}<span style="color:red">${middle}</span>${last}</span></p>`;
  const { pages } = paginateArticle(source, createMeasure(), 198);
  assert.equal(pages.length, 2);
  assert.equal(pageBody(pages.join("")).textContent, first + middle + last);
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("nested emphasis is compared by the text it covers across continuation fragments", () => {
  const source = "<p><strong>甲<strong>乙丙</strong>丁</strong></p>";
  const pages = ["<p><strong>甲<strong>乙</strong></strong></p>", "<p><strong><strong>丙</strong>丁</strong></p>"];
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
});

test("discarding empty inline spans does not report lost text color", () => {
  const source = '<p><span style="color:red"></span><span style="color:blue">完整正文</span></p>';
  assert.doesNotThrow(() => assertPaginationSemantics(source, ['<p><span style="color:blue">完整正文</span></p>']));
});

test("color and emphasis loss on visible text still fail the integrity check", () => {
  const source = '<p><span style="color:red">甲<span style="color:blue">乙丙</span>丁</span><strong>重要内容</strong></p>';
  assert.throws(() => assertPaginationSemantics(source, [source.replace('color:blue', 'color:green')]), /span\[style\]/);
  assert.throws(() => assertPaginationSemantics(source, [source.replace('<span style="color:blue">乙丙</span>', '乙丙')]), /span\[style\]/);
  assert.throws(() => assertPaginationSemantics(source, [source.replace('<strong>重要内容</strong>', '重要内容')]), /strong/);
  assert.throws(() => assertPaginationSemantics(source, [source.replace('乙丙', '乙')]), /正文/);
});


test("stacked style effects cannot lose an ancestor while keeping the same visible text", () => {
  const source = '<p><span style="opacity:0.5">甲<span style="opacity:0.5">乙丙</span>丁</span></p>';
  const pages = ['<p><span style="opacity:0.5">甲<span style="opacity:0.5">乙</span></span></p>', '<p><span style="opacity:0.5"><span style="opacity:0.5">丙</span>丁</span></p>'];
  assert.doesNotThrow(() => assertPaginationSemantics(source, pages));
  assert.throws(() => assertPaginationSemantics(source, ['<p><span style="opacity:0.5">甲乙丙丁</span></p>']), /span\[style\]/);
});
