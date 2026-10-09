import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { createLeadCardHtml, DEFAULT_PUBLICATION_NAME, DEFAULT_LEAD_GUIDE, DEFAULT_PUBLICATION_COPY } = loadDomModule("lib/publication/leadCard.ts");
const copySelectors = {
  intro: ".lead-card-intro",
  summary: ".lead-card-summary",
  offer: ".lead-card-offer",
  fileLabel: ".lead-card-file-label",
  coverSubtitle: ".lead-card-cover-subtitle",
  editionLabel: ".lead-card-edition",
};

function render(name = DEFAULT_PUBLICATION_NAME, guide = DEFAULT_LEAD_GUIDE, qr = "", details = DEFAULT_PUBLICATION_COPY) {
  return JSDOM.fragment(createLeadCardHtml(name, guide, qr, details));
}

function textAt(card, selector) {
  const element = card.querySelector(selector);
  assert.ok(element, `Missing ${selector}`);
  return element.textContent;
}

function fontSizeAt(card, selector) {
  const style = card.querySelector(selector)?.getAttribute("style") ?? "";
  const match = /font-size:\s*([\d.]+)cqw/.exec(style);
  assert.ok(match, `Missing card-relative font size for ${selector}`);
  const size = Number(match[1]);
  assert.ok(Number.isFinite(size) && size > 0, `Invalid font size for ${selector}`);
  return size;
}

test("publication card includes complete default copy and an upload placeholder", () => {
  const card = render();
  assert.equal(textAt(card, ".lead-card-title"), `《${DEFAULT_PUBLICATION_NAME}》`);
  assert.equal(textAt(card, ".lead-card-guide"), DEFAULT_LEAD_GUIDE);
  for (const [key, selector] of Object.entries(copySelectors)) {
    assert.equal(textAt(card, selector), DEFAULT_PUBLICATION_COPY[key]);
  }
  assert.equal(card.querySelectorAll(".lead-magnet-card").length, 1);
  assert.equal(card.querySelectorAll(".lead-card-qr").length, 0);
  assert.match(textAt(card, ".lead-card-qr-placeholder"), /上传你的二维码/);
});

test("publication name updates heading, filename, and cover together", () => {
  for (const name of ["人工智能新应用", "机器人产业观察🤖", "第一行\n第二行"]) {
    const card = render(`  《${name}》  `);
    assert.equal(textAt(card, ".lead-card-title"), `《${name}》`);
    assert.equal(textAt(card, ".lead-card-file-name"), `${name.replace(/\n/g, " ")}.pdf`);
    const coverText = textAt(card, ".lead-card-cover-title");
    assert.equal(name.includes("\n") ? coverText : coverText.replace(/\n/g, ""), name);
    assert.ok(!card.textContent.includes(DEFAULT_PUBLICATION_NAME));
  }
  const empty = render("  《》  ");
  for (const selector of [".lead-card-title", ".lead-card-file-name", ".lead-card-cover-title"]) {
    assert.equal(textAt(empty, selector), "");
  }
});

test("editable copy remains literal text instead of creating HTML elements or attributes", () => {
  const payload = '<img src="x" onerror="alert(1)"><script>alert(2)</script>&\'"';
  const guide = `${payload}\n即可领取！`;
  const details = Object.fromEntries(Object.keys(copySelectors).map((key) => [key, `${key}: ${payload}`]));
  const card = render(payload, guide, "", details);
  assert.equal(textAt(card, ".lead-card-title"), `《${payload}》`);
  assert.equal(textAt(card, ".lead-card-file-name"), `${payload}.pdf`);
  assert.equal(textAt(card, ".lead-card-cover-title").replace(/\n/g, ""), payload);
  assert.equal(textAt(card, ".lead-card-guide"), guide);
  for (const [key, selector] of Object.entries(copySelectors)) {
    assert.equal(textAt(card, selector), details[key]);
  }
  assert.equal(card.querySelectorAll("script, iframe, [onerror], [onload]").length, 0);
  assert.equal(card.querySelectorAll("img").length, 2, "Only the built-in icon and cover image should exist");
  assert.ok(card.querySelector("img.lead-card-cover-image"));
});

test("long and multiline copy stays complete while its font size decreases", () => {
  const name = "新能源产业长期观察🔋".repeat(12);
  const longCopy = "完整保留这段文字 ABC & <内容> 😀".repeat(20);
  const guide = `${longCopy}\n第二行\n第三行`;
  const details = Object.fromEntries(Object.keys(copySelectors).map((key) => [key, `${longCopy}\n${key}`]));
  const card = render(name, guide, "", details);
  const normal = render();
  assert.equal(textAt(card, ".lead-card-title"), `《${name}》`);
  assert.equal(textAt(card, ".lead-card-file-name"), `${name}.pdf`);
  assert.equal(textAt(card, ".lead-card-cover-title").replace(/\n/g, ""), name);
  assert.equal(textAt(card, ".lead-card-guide"), guide);
  for (const [key, selector] of Object.entries(copySelectors)) {
    assert.equal(textAt(card, selector), details[key]);
  }
  for (const selector of [".lead-card-title", ".lead-card-file-name", ".lead-card-cover-title", ".lead-card-guide", ...Object.values(copySelectors)]) {
    assert.ok(fontSizeAt(card, selector) < fontSizeAt(normal, selector), `${selector} should shrink to fit longer copy`);
  }
});

test("QR images accept PNG, JPEG, and WebP data URLs", async (t) => {
  for (const mime of ["png", "jpeg", "webp"]) {
    await t.test(mime, () => {
      const qr = `data:image/${mime};base64,aGVsbG8=`;
      const card = render(undefined, undefined, qr);
      assert.equal(card.querySelectorAll(".lead-card-qr").length, 1);
      assert.equal(card.querySelector(".lead-card-qr").getAttribute("src"), qr);
      assert.equal(card.querySelectorAll(".lead-card-qr-placeholder").length, 0);
    });
  }
});

test("unsupported QR formats and unsafe sources fall back to the upload placeholder", async (t) => {
  const cases = {
    gif: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
    svg: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    remote: "https://example.com/qr.png",
    script: "javascript:alert(1)",
    markup: '<svg onload="alert(1)"></svg>',
    attribute: 'data:image/png;base64,AA==" onerror="alert(1)',
    invalidBase64Characters: "data:image/png;base64,<>!",
    emptyPayload: "data:image/png;base64,",
  };
  for (const [label, qr] of Object.entries(cases)) {
    await t.test(label, () => {
      const card = render(undefined, undefined, qr);
      assert.equal(card.querySelectorAll(".lead-card-qr").length, 0);
      assert.equal(card.querySelectorAll(".lead-card-qr-placeholder").length, 1);
      assert.equal(card.querySelectorAll("[onerror], [onload]").length, 0);
    });
  }
});
