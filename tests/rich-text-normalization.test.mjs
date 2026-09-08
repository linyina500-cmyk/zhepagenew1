import test from "node:test";
import assert from "node:assert/strict";
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
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

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
