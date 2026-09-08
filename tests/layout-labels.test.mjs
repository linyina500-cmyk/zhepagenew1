import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import postcss from "postcss";

// jsdom does not lay out generated pseudo-elements. Represent ::before with a
// child tag of equal selector specificity, then test the actual stylesheet's
// cascade and normal-flow contract. These checks do not measure geometry and
// do not replace browser visual QA. Keep the complete stylesheet, including
// later layout overrides; fonts and external imports are irrelevant here.
const stylesheet = postcss.parse(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));
stylesheet.walkAtRules(/^(import|font-face)$/, (rule) => rule.remove());
stylesheet.walkRules((rule) => {
  rule.selector = rule.selector.replaceAll("::before", " > zhepage-before");
});
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
const { document, getComputedStyle } = dom.window;
const style = document.createElement("style");
style.textContent = stylesheet.toString();
document.head.append(style);
test.after(() => dom.window.close());

const surfaces = [
  ...["xiaohongshu", "financeDeepRead", "dataIndex", "cleanNews", "keyCards"].map((layout) => ({
    name: layout,
    className: `article-flow layout-${layout} preserve`,
  })),
  { name: "editor", className: "layout-editor" },
];
const zeroPadding = ["padding:0", "padding:0!important"];
const fragments = [null, "start", "middle", "end"];
const dataText = "<strong>营收增长12.8%，净利润增长21.6%。</strong>两项数据需要结合报告中的统计口径理解。";

function mount(surface, html) {
  const root = document.createElement("div");
  root.className = surface.className;
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

function dataParagraph(padding, fragment = null, joined = "") {
  return `<p class="auto-data-callout ${joined}" data-auto-label="关键数据" style="${padding}"${fragment ? ` data-pagination-fragment="${fragment}"` : ""}>`
    + `<zhepage-before></zhepage-before>${dataText}</p>`;
}

function assertZeroPadding(element, context) {
  const computed = getComputedStyle(element);
  for (const side of ["Top", "Right", "Bottom", "Left"]) {
    assert.equal(computed[`padding${side}`], "0px", `${context}: imported padding-${side.toLowerCase()} remains zero`);
  }
}

function assertLabelFlow(label, context, { block = false } = {}) {
  const computed = getComputedStyle(label);
  assert.equal(computed.position, "static", `${context}: label must participate in normal flow`);
  const allowedDisplays = block ? ["block", "table"] : ["block", "table", "inline-block", "inline-grid", "inline-flex"];
  assert.ok(allowedDisplays.includes(computed.display), `${context}: unexpected label display ${computed.display}`);
  assert.ok(!computed.cssFloat || computed.cssFloat === "none", `${context}: label must not float over text`);
  if (block) assert.ok(Number.parseFloat(computed.marginBottom) > 0, `${context}: label needs space before following text`);
  return computed;
}

for (const surface of surfaces) {
  test(`${surface.name}: data badges stay above zero-padding text on intact and split paragraphs`, () => {
    for (const padding of zeroPadding) {
      for (const fragment of fragments) {
        const context = `${surface.name}, ${padding}, ${fragment || "intact"}`;
        const root = mount(surface, dataParagraph(padding, fragment));
        const paragraph = root.querySelector("p");
        const label = paragraph.firstElementChild;
        assertZeroPadding(paragraph, context);
        const computed = assertLabelFlow(label, context, { block: true });
        if (surface.name !== "editor" && ["middle", "end"].includes(fragment)) {
          assert.match(computed.content, /关键数据.*续/, `${context}: continued page identifies the repeated label`);
        } else {
          assert.equal(computed.content, "attr(data-auto-label)", `${context}: first label uses its data attribute`);
        }
        assert.equal(label.nextElementSibling.tagName, "STRONG", `${context}: body follows the generated label`);
      }
    }
  });

  test(`${surface.name}: joined data paragraphs hide repeated labels and a new group shows its own label`, () => {
    for (const padding of zeroPadding) {
      const root = mount(surface,
        dataParagraph(padding, "start", "auto-callout-joined-after")
        + dataParagraph(padding, "middle", "auto-callout-joined-before auto-callout-joined-after")
        + dataParagraph(padding, "end", "auto-callout-joined-before")
        + "<p>普通正文隔开下一组数据。</p>"
        + dataParagraph(padding));
      const labels = [...root.querySelectorAll("zhepage-before")];
      assertLabelFlow(labels[0], `${surface.name}: first group label`, { block: true });
      assert.equal(getComputedStyle(labels[1]).display, "none", `${surface.name}: middle joined label is hidden`);
      assert.equal(getComputedStyle(labels[2]).display, "none", `${surface.name}: final joined label is hidden`);
      assertLabelFlow(labels[3], `${surface.name}: independent group label`, { block: true });
    }
  });

  test(`${surface.name}: numbered heading labels remain in flow with zero inline padding`, () => {
    for (const padding of zeroPadding) {
      for (const tag of ["h2", "h3"]) {
        const context = `${surface.name}, ${tag}, ${padding}`;
        const root = mount(surface, `<${tag} class="auto-inferred-heading auto-numbered-dotline" data-auto-index="02" style="${padding}">`
          + "<zhepage-before></zhepage-before>第二，观察经营数据与盈利变化"
          + `</${tag}>`);
        const heading = root.firstElementChild;
        assertZeroPadding(heading, context);
        const label = heading.firstElementChild;
        if (surface.name === "cleanNews") {
          assert.equal(getComputedStyle(label).display, "none", `${context}: clean-news headings intentionally omit badges`);
        } else {
          const computed = assertLabelFlow(label, context, { block: surface.name === "keyCards" });
          if (surface.name === "dataIndex") {
            assert.equal(computed.display, "inline-block", `${context}: data index occupies space beside its heading`);
            assert.ok(Number.parseFloat(computed.width) > 0 && Number.parseFloat(computed.marginRight) > 0,
              `${context}: data index reserves its own width and text spacing`);
          }
        }
      }
    }
  });

  test(`${surface.name}: ordinary h3 decoration cannot overlap zero-padding heading text`, () => {
    for (const padding of zeroPadding) {
      const context = `${surface.name}, ordinary h3, ${padding}`;
      const root = mount(surface, `<h3 style="${padding}"><zhepage-before></zhepage-before>经营表现与变化</h3>`);
      const heading = root.firstElementChild;
      assertZeroPadding(heading, context);
      assertLabelFlow(heading.firstElementChild, context);
    }
  });
}

test("data-index and key-card native h2 labels occupy space without reserved paragraph padding", () => {
  for (const surface of surfaces.filter(({ name }) => ["dataIndex", "keyCards"].includes(name))) {
    for (const padding of zeroPadding) {
      const context = `${surface.name}, native h2, ${padding}`;
      const root = mount(surface, `<h2 data-auto-index="03" style="${padding}"><zhepage-before></zhepage-before>市场变化与核心观点</h2>`);
      const heading = root.firstElementChild;
      assertZeroPadding(heading, context);
      assertLabelFlow(heading.firstElementChild, context, { block: surface.name === "keyCards" });
    }
  }
});
