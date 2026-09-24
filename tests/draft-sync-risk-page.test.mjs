import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";
const { renderRiskPage } = loadDomModule("lib/draftSync/riskPage.ts");
const note = { enabled: true, title: "风险提示 Risk", text: "第一段，保留中英标点：risk / reward!?\n\n  空行后的正文（含空格）。👨‍👩‍👧‍👦" };
const appearance = { paperColor: "#faf9f7", textColor: "#20232b", accentColor: "#618173", fontFamily: '"已加载字体", sans-serif', footerText: "请独立判断。" };
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
function fixture(t, options = {}) {
  const dom = installDom(), canvases = [], texts = [], fills = [];
  t.after(() => dom.window.close());
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: options.fonts || Promise.resolve(), load: () => assert.fail("must not fetch fonts") } });
  t.mock.method(globalThis, "fetch", () => assert.fail("risk page must not access the network"));
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    if (options.noContext) return null;
    return { font: "", textAlign: "", textBaseline: "", fillStyle: "", measureText(text) { return { width: [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(text)].length * Number(this.font.match(/(\d+)px/)?.[1] || 20) * 0.75 }; },
      fillText(text, x, y, ...rest) { texts.push({ text, x, y, font: this.font, color: this.fillStyle, rest }); },
      fillRect(x, y, width, height) { fills.push({ x, y, width, height, color: this.fillStyle }); },
    };
  };
  dom.window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
    canvases.push({ canvas: this, width: this.width, height: this.height, type, finish: callback });
    if (!options.pending) callback(options.badBlob ? null : png());
  };
  return { texts, fills, canvases };
}
const textWithoutNewlines = (text) => text.replace(/\r\n|\r|\n/g, "");

test("disabled risk creates no canvas, fonts request, or image", async (t) => {
  const f = fixture(t, { fonts: new Promise(() => {}) });
  assert.equal(await renderRiskPage({ ...note, enabled: false }, appearance, "wechat"), null);
  assert.deepEqual(f.canvases, []); assert.deepEqual(f.texts, []);
});

test("each platform gets its exact size while preserving all text, blank lines and appearance", async (t) => {
  for (const [platform, height] of [["wechat", 1350], ["xiaohongshu", 1440]]) {
    await t.test(platform, async (t) => {
      const f = fixture(t), frozenNote = Object.freeze({ ...note }), frozenAppearance = Object.freeze({ ...appearance });
      const result = await renderRiskPage(frozenNote, frozenAppearance, platform);
      assert.equal(result.width, 1080); assert.equal(result.height, height); assert.equal(result.blob.type, "image/png");
      assert.match(result.name, /风险提示\.png$/); assert.equal(result.id, `risk-${platform}`);
      assert.deepEqual(f.fills[0], { x: 0, y: 0, width: 1080, height, color: appearance.paperColor });
      assert.equal(f.fills[1].color, appearance.accentColor);
      assert.equal(f.texts.map(({ text }) => text).join(""), textWithoutNewlines(note.title + note.text + appearance.footerText));
      assert.ok(f.texts.some(({ text }) => text === ""), "explicit blank lines remain in the layout");
      assert.ok(f.texts.some(({ text }) => text.startsWith("  ")), "leading whitespace is not trimmed");
      assert.ok(f.texts.some(({ text }) => text.includes("👨‍👩‍👧‍👦")), "graphemes are never split by wrapping");
      for (const text of f.texts) { assert.equal(text.color, appearance.textColor); assert.deepEqual(text.rest, []); assert.ok(text.y + Number(text.font.match(/(\d+)px/)[1]) < height); }
      assert.equal(f.canvases[0].type, "image/png"); assert.equal(f.canvases[0].canvas.width, 0); assert.equal(f.canvases[0].canvas.height, 0);
    });
  }
});

test("wrapping and font fitting preserve long mixed text without squeezing or truncating", async (t) => {
  const f = fixture(t), text = "风险需独立判断ABC!? ".repeat(45);
  await renderRiskPage({ ...note, text }, appearance, "wechat");
  const body = f.texts.filter(({ font }) => font.startsWith("400 ") && !font.includes("22px"));
  assert.equal(body.map(({ text }) => text).join(""), text);
  const size = Number(body[0].font.match(/(\d+)px/)[1]); assert.ok(size >= 24 && size < 36, "long content scales only within legible bounds");
  for (const line of body) assert.equal(line.rest.length, 0, "canvas maxWidth must not compress or clip content");
});

test("empty or overflowing text gives a clear error without emitting a partial page", async (t) => {
  const f = fixture(t);
  await assert.rejects(renderRiskPage({ ...note, text: " \n " }, appearance, "wechat"), /请填写/);
  await assert.rejects(renderRiskPage({ ...note, text: "字".repeat(6001) }, appearance, "wechat"), /最多 6000/);
  await assert.rejects(renderRiskPage({ ...note, text: "保留\n".repeat(100) }, appearance, "wechat"), /不会截断文字/);
  assert.equal(f.canvases.length, 0); assert.equal(f.texts.length, 0);
});

test("plain text resembling HTML is drawn literally and never inserted into the DOM", async (t) => {
  const f = fixture(t), text = '<img src="https://example.com/tracker" onerror="alert(1)"> & 原文';
  await renderRiskPage({ enabled: true, title: "", text }, { ...appearance, footerText: "" }, "wechat");
  assert.equal(f.texts.map(({ text }) => text).join(""), text);
  assert.equal(document.body.innerHTML, "");
});

test("cancelling font preparation or PNG encoding rejects promptly and frees canvas memory", async (t) => {
  await t.test("fonts", async (t) => {
    const f = fixture(t, { fonts: new Promise(() => {}) }), controller = new AbortController();
    const result = renderRiskPage(note, appearance, "wechat", controller.signal);
    controller.abort(new Error("已取消")); await assert.rejects(result, /已取消/); assert.equal(f.canvases.length, 0);
  });
  await t.test("encoding", async (t) => {
    const f = fixture(t, { pending: true }), controller = new AbortController();
    const result = renderRiskPage(note, appearance, "wechat", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("已取消")); await assert.rejects(result, /已取消/);
    assert.equal(f.canvases[0].canvas.width, 0); assert.equal(f.canvases[0].canvas.height, 0);
    f.canvases[0].finish(png());
  });
});

test("PNG timeout and encoder failures remain errors instead of successful blank images", async (t) => {
  await t.test("timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, { pending: true });
    const result = renderRiskPage(note, appearance, "wechat"), rejected = assert.rejects(result, /图片生成超时/);
    await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(15_001); await rejected;
    assert.equal(f.canvases[0].canvas.width, 0);
  });
  await t.test("encoding error", async (t) => {
    const f = fixture(t, { badBlob: true }); await assert.rejects(renderRiskPage(note, appearance, "wechat"), /图片生成失败/);
    assert.equal(f.canvases[0].canvas.width, 0);
  });
});
