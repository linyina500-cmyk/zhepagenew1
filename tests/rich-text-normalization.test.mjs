import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

installDom();
const {
  RICH_LAYOUT_CLASS,
  RICH_TEXT_LIMITS,
  isRichLayoutGroup,
  normalizeRichHtmlDocument,
  richTextHtmlLimitMessage,
  richTextLimitMessage,
  richTextStats,
} = loadDomModule("lib/richText/normalizeRichHtml.ts");
const { beautifyArticle } = loadDomModule("lib/beautify/beautifyArticle.ts");
const { articleBlocks } = loadDomModule("lib/pagination/articleBlocks.ts");
const { assertPaginationSemantics } = loadDomModule("lib/pagination/semanticIntegrity.ts");
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

test("real editor Enter paragraphs and ShiftEnter breaks survive base and automatic presentation", (t) => {
  const require = createRequire(import.meta.url);
  const { Editor } = require("@tiptap/core");
  const { default: StarterKit } = require("@tiptap/starter-kit");
  const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit], content: "<p>前文</p>" });
  t.after(() => editor.destroy());
  editor.commands.setTextSelection(3);
  editor.commands.splitBlock(); editor.commands.splitBlock(); editor.commands.splitBlock();
  editor.commands.insertContent("后文");
  editor.commands.setHardBreak(); editor.commands.setHardBreak(); editor.commands.insertContent("末行");
  const source = editor.getHTML();
  assert.equal(source, "<p>前文</p><p></p><p></p><p>后文<br><br>末行</p>");
  const normalized = normalizeRichHtmlDocument(parse(source)).body.innerHTML;
  const liveNormalized = normalizeRichHtmlDocument(parse(editor.view.dom.innerHTML)).body.innerHTML;
  assert.equal(liveNormalized, normalized, "the editor's caret-only trailingBreak must not add any spacing");
  for (const html of [source, normalized, beautifyArticle(source).html]) {
    const blocks = articleBlocks(html);
    const output = parse(blocks.join(""));
    assert.equal(output.querySelectorAll("p.manual-empty-line").length, 2);
    assert.equal(output.querySelectorAll("br").length, 2);
    assert.equal(output.querySelector(".ProseMirror-trailingBreak"), null);
    assert.equal(output.body.textContent, "前文后文末行");
    assert.doesNotThrow(() => assertPaginationSemantics(html, blocks));
  }
  assert.equal(editor.getHTML(), source, "presentation must not alter the editor document");
});

test("normalization keeps direct line breaks but gives a caret-only blank paragraph one spacer", () => {
  const html = '<section><span>前文</span><br><br><span>后文</span></section><p><br class="ProseMirror-trailingBreak"></p>';
  const normalized = normalizeRichHtmlDocument(parse(html));
  assert.equal(normalized.querySelectorAll(".imported-inline-run br").length, 2);
  assert.equal(normalized.querySelectorAll(".manual-empty-line").length, 1);
  assert.equal(normalized.querySelector(".manual-empty-line").innerHTML, "");
  assert.equal(normalized.querySelector(".ProseMirror-trailingBreak"), null);
});

test("typing into a preserved blank paragraph restores normal paragraph layout", () => {
  const normalized = normalizeRichHtmlDocument(parse('<p class="manual-empty-line source-style">新增正文</p>'));
  assert.equal(normalized.querySelector("p").className, "source-style");
  assert.equal(normalized.body.textContent, "新增正文");
});

test("a painted article wrapper keeps its paragraphs available for automatic typesetting", () => {
  const source = `<section style="background:#fff;padding:24px"><div><p>这是文章的导语，用来介绍接下来需要讨论的问题。</p><p>一、需求变化</p><p>第一，需求变化需要结合实际数据进行观察。</p></div></section>`;
  const parsed = normalizeRichHtmlDocument(parse(source));
  assert.equal(parsed.querySelector(`.${RICH_LAYOUT_CLASS}`), null);
  const result = beautifyArticle(parsed.body.innerHTML);
  const formatted = parse(result.html);
  assert.equal(formatted.querySelector("h3")?.textContent, "一、需求变化");
  assert.equal(formatted.querySelector("p.auto-lead-paragraph")?.textContent, "这是文章的导语，用来介绍接下来需要讨论的问题。");
  assert.ok(formatted.querySelector("p.auto-structured-paragraph"));
});

test("short direct article paragraphs do not become one composite visual from background and padding", () => {
  const parsed = normalizeRichHtmlDocument(parse(`<section style="background:#eee;padding:20px"><p>文章导语。</p><p>一、需求变化</p><p>这是正文。</p></section>`));
  assert.equal(isRichLayoutGroup(parsed.body.firstElementChild), false);
  assert.equal(parsed.querySelector(`.${RICH_LAYOUT_CLASS}`), null);
  assert.equal(beautifyArticle(parsed.body.innerHTML).promotedHeadings, 1);
});

test("article structure takes precedence over decorative borders and column flex wrappers", () => {
  const paragraph = "这是一段用来验证文章外层包装识别的正文，需要保留自然段边界，才能在自动排版和分页时继续拆分。".repeat(3);
  for (const style of ["border:1px solid #ddd;padding:24px", "display:flex;flex-direction:column;background:#fff;padding:24px"]) {
    const parsed = normalizeRichHtmlDocument(parse(`<section style="${style}"><h2>一、需求变化</h2><p>${paragraph}</p><h2>二、供给变化</h2><p>${paragraph}</p></section>`));
    assert.equal(parsed.querySelector(`.${RICH_LAYOUT_CLASS}`), null);
  }
});

test("designed KPI rows, CTA panels, company cards and table compositions remain intact", () => {
  const examples = [
    `<section style="display:flex;gap:12px"><div><h3>营业收入</h3><p>12.8亿元</p></div><div><h3>同比增长</h3><p>32%</p></div></section>`,
    `<section style="background:#fee;padding:20px"><p>领取本期行业资料</p><p><a>点击查看</a></p></section>`,
    `<section style="border:1px solid #ddd;padding:20px"><h3>示例公司</h3><p>主营业务：高端制造</p><p>营业收入：12.8亿元</p></section>`,
    `<section><h3>经营数据</h3><table><tr><th>收入</th><td>12.8亿元</td></tr></table></section>`,
  ];
  for (const source of examples) {
    const parsed = normalizeRichHtmlDocument(parse(source));
    assert.ok(parsed.body.firstElementChild.classList.contains(RICH_LAYOUT_CLASS), source);
    const formatted = parse(beautifyArticle(parsed.body.innerHTML).html);
    assert.equal(formatted.querySelector(".auto-lead-paragraph,.auto-beautified-heading,.auto-numbered-dotline"), null, source);
    assert.equal(formatted.body.textContent, parsed.body.textContent);
  }
});

test("typesetting rechecks stale wrapper markers and finds the lead outside cards and tables", () => {
  const parsed = parse(beautifyArticle(`<section class="${RICH_LAYOUT_CLASS}" style="background:#fff;padding:24px"><table><tr><td><p>数据单元格</p></td></tr></table><div><p>图：图片说明</p><section><div><p>这里才是文章的导语。</p><p>一、需求变化</p></div></section></div></section>`).html);
  assert.equal(parsed.querySelector("p.auto-lead-paragraph")?.textContent, "这里才是文章的导语。");
  assert.equal(parsed.querySelector("h3")?.textContent, "一、需求变化");
});

test("inline wrapper runs are normalized without losing source text", () => {
  const parsed = normalizeRichHtmlDocument(parse(`<section><span>导语<strong>强调内容</strong></span><section><span>一、需求变化</span></section><section><span>正文。</span></section></section>`));
  assert.equal(parsed.body.textContent, "导语强调内容一、需求变化正文。");
  const result = parse(beautifyArticle(parsed.body.innerHTML).html);
  assert.equal(result.querySelector(".auto-lead-paragraph")?.textContent, "导语强调内容");
  assert.equal(result.querySelector("h3")?.textContent, "一、需求变化");
});

test("edited callouts are reclassified without retaining old labels or changing source styling", () => {
  const source = `<p>文章导语。</p><p id="target" class="source-paragraph" style="color:orange"><strong>今年收入增长20%，利润增长30%，这些数据仍需结合行业环境与公司的实际经营情况进一步分析。</strong></p>`;
  let formatted = parse(beautifyArticle(source).html);
  assert.ok(formatted.querySelector("#target.auto-data-callout"));
  formatted.querySelector("#target").textContent = "核心是：先判断业务的实际变化，再考虑市场价格的短期波动。";
  formatted = parse(beautifyArticle(formatted.body.innerHTML).html);
  assert.ok(formatted.querySelector("#target.auto-key-point"));
  assert.equal(formatted.querySelector("#target.auto-data-callout,[data-auto-label]"), null);
  formatted.querySelector("#target").textContent = "这一段现在是普通正文，用来继续介绍事件的背景与具体经过。";
  const result = beautifyArticle(formatted.body.innerHTML);
  formatted = parse(result.html);
  assert.equal(formatted.querySelector("#target").className, "source-paragraph");
  assert.equal(formatted.querySelector("#target").style.color, "orange");
  assert.equal(beautifyArticle(result.html).changes, 0);
});

test("promoting a former callout to a heading clears paragraph decoration", () => {
  const result = parse(beautifyArticle(`<p>文章导语。</p><p class="source-heading auto-key-point auto-data-callout auto-closing-lead" data-auto-label="关键数据" style="color:orange">写在最后</p><p>这是结尾正文。</p>`).html);
  const heading = result.querySelector("h2");
  assert.ok(heading.classList.contains("source-heading"));
  assert.ok(heading.classList.contains("auto-conclusion-heading"));
  assert.equal(heading.matches(".auto-key-point,.auto-data-callout,.auto-closing-lead,[data-auto-label]"), false);
  assert.equal(heading.style.color, "orange");
  assert.ok(result.querySelector("h2 + p.auto-closing-lead"));
});

test("moving the lead and conclusion paragraph removes their previous decoration", () => {
  let result = parse(beautifyArticle(`<p id="old-lead">原来的导语。</p><h2>写在最后</h2><p id="old-closing">原来的结语正文。</p>`).html);
  result.body.insertAdjacentHTML("afterbegin", "<p id='new-lead'>新增的导语。</p>");
  result.querySelector("h2").insertAdjacentHTML("afterend", "<p id='new-closing'>新的结语正文。</p>");
  result = parse(beautifyArticle(result.body.innerHTML).html);
  assert.equal(result.querySelector(".auto-lead-paragraph").id, "new-lead");
  assert.equal(result.querySelectorAll(".auto-lead-paragraph").length, 1);
  assert.equal(result.querySelector(".auto-closing-lead").id, "new-closing");
  assert.equal(result.querySelectorAll(".auto-closing-lead").length, 1);
});

test("nested bold and highlight count each emphasized character once", () => {
  const result = parse(beautifyArticle(`<p>导语。</p><p><strong><mark>重点只有这几个字</mark></strong>，其余部分仍是普通正文，并不应该将整段变成强调卡片。</p>`).html);
  assert.equal(result.querySelector(".auto-key-point,.auto-data-callout"), null);
  assert.equal(result.querySelector("strong mark").textContent, "重点只有这几个字");
});

test("HTML length is rejected before DOM statistics are accessed", () => {
  assert.equal(richTextHtmlLimitMessage("x".repeat(RICH_TEXT_LIMITS.htmlLength)), "");
  const html = "x".repeat(RICH_TEXT_LIMITS.htmlLength + 1);
  assert.match(richTextHtmlLimitMessage(html), /HTML 源码/);
  const unparsedRoot = { get children() { throw new Error("DOM inspection must not run"); } };
  assert.match(richTextLimitMessage(html, unparsedRoot), /HTML 源码/);
});

test("nested rich text is bounded even when its length and node count are small", () => {
  const createNested = (depth) => `<section>`.repeat(depth) + "正文😀" + `</section>`.repeat(depth);
  const allowedHtml = createNested(RICH_TEXT_LIMITS.depth);
  const allowed = parse(allowedHtml);
  assert.deepEqual(richTextStats(allowed.body), { textLength: 3, elementCount: RICH_TEXT_LIMITS.depth, depth: RICH_TEXT_LIMITS.depth });
  assert.equal(richTextLimitMessage(allowedHtml, allowed.body), "");
  const deepHtml = createNested(RICH_TEXT_LIMITS.depth + 1);
  assert.match(richTextLimitMessage(deepHtml, parse(deepHtml).body), /嵌套超过 64 层/);
});
