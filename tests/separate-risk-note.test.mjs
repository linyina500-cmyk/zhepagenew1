import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

const risk = '<aside class="risk-note"><strong>风险提示</strong><p>仅供参考<br>风险自担</p></aside>';

test("risk separation removes only marked risk blocks while preserving mixed body structure and order", (t) => {
  const dom = installDom(); t.after(() => dom.window.close());
  const { separateRiskNote } = loadDomModule("lib/export/separateRiskNote.ts");
  const before = '<section class="layout" style="color:rgb(1, 2, 3)"><h2>标题</h2><p>首行<br>次行 <strong>强调</strong><em>斜体</em></p><img src="/body.png" alt="正文图片"></section>';
  const after = '<table><tbody><tr><td>数据</td><td>20</td></tr></tbody></table><p class="risk-note-reference">这段正文提到风险提示，应保留。</p>';
  const result = separateRiskNote(before + risk + after + risk);
  assert.equal(result.html, before + after); assert.equal(result.riskOnly, false);
  assert.equal(separateRiskNote(before + after).html, before + after);
});

test("a page becomes risk-only only when no authored body content survives", (t) => {
  const dom = installDom(); t.after(() => dom.window.close());
  const { separateRiskNote } = loadDomModule("lib/export/separateRiskNote.ts");
  for (const html of [risk, `<section style="padding-top:20px">${risk}</section>`, ` \n${risk}<!--generated metadata--><div><span></span></div>`]) {
    const result = separateRiskNote(html);
    assert.equal(result.riskOnly, true); assert.doesNotMatch(result.html, /风险提示|仅供参考/);
  }
  assert.equal(separateRiskNote("").riskOnly, false, "empty unrelated pages are not classified as risk pages");
  for (const body of [
    '<p><br></p>', '<p class="manual-empty-line"></p>', '<div class="manual-page-break"></div>',
    '<span data-pagination-fragment="true"> </span>', '<p><img src="/photo.png"></p>',
    '<table><tbody><tr><td></td></tr></tbody></table>', '<hr>', '<p>风险提示 仅供参考</p>',
  ]) {
    const result = separateRiskNote(body + risk);
    assert.equal(result.riskOnly, false, `authored content must survive: ${body}`);
    assert.equal(result.html, body);
  }
});
