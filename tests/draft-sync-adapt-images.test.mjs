import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { PLATFORM_IMAGE_SIZES, fitImageRect, adaptDraftImages } = loadDomModule("lib/draftSync/adaptImages.ts");
const png = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
const jpeg = () => new Blob([Uint8Array.from([255, 216, 255, 0])], { type: "image/jpeg" });
const source = (id = "first", blob = png()) => ({ id, name: `${id}.png`, blob, width: 1080, height: 1440 });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function fixture(t, options = {}) {
  const images = [], canvases = [], revoked = [], calls = [];
  function install(name, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  class TestImage {
    constructor() {
      const size = options.sizes?.[images.length] || { width: 1600, height: 900 };
      this.naturalWidth = size.width; this.naturalHeight = size.height;
      images.push(this);
      calls.push({ type: "decode", revoked: revoked.length });
    }
    set src(value) {
      this.source = value;
      if (!options.stallDecode) queueMicrotask(() => options.failDecode ? this.onerror?.() : this.onload?.());
    }
    removeAttribute(name) { assert.equal(name, "src"); this.removed = true; }
  }
  install("Image", TestImage);
  install("document", { createElement(name) {
    assert.equal(name, "canvas");
    const context = {
      fillRect(...args) { calls.push({ type: "background", color: this.fillStyle, args }); },
      drawImage(image, ...args) { calls.push({ type: "draw", image, args }); },
    };
    const canvas = {
      width: 0, height: 0,
      getContext(type) { assert.equal(type, "2d"); return options.noContext ? null : context; },
      toBlob(callback, type) {
        assert.equal(type, "image/png"); this.finish = callback;
        if (!options.stallEncode) queueMicrotask(() => callback(options.failEncode ? null : png()));
      },
    };
    canvases.push(canvas); return canvas;
  } });
  t.mock.method(URL, "createObjectURL", () => `blob:local-test-${images.length}`);
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  return { images, canvases, calls, revoked };
}

function cleaned(f) {
  assert.equal(f.revoked.length, f.images.length);
  for (const image of f.images) { assert.equal(image.removed, true); assert.equal(image.onload, null); assert.equal(image.onerror, null); }
  for (const canvas of f.canvases) { assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); }
}

test("platform sizes and contain rectangles preserve the entire aspect ratio without stretching", () => {
  assert.deepEqual(PLATFORM_IMAGE_SIZES, { xiaohongshu: { width: 1080, height: 1440 }, wechat: { width: 1080, height: 1350 } });
  assert.deepEqual(fitImageRect(1600, 900, 1080, 1440), { x: 0, y: 416.25, width: 1080, height: 607.5 });
  assert.deepEqual(fitImageRect(1080, 1440, 1080, 1350), { x: 33.75, y: 0, width: 1012.5, height: 1350 });
  assert.deepEqual(fitImageRect(100, 100, 1080, 1350), { x: 0, y: 135, width: 1080, height: 1080 });
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => fitImageRect(bad, 100, 1080, 1350), /图片尺寸无效/);
});

test("uses decoded dimensions, fills white, keeps IDs/order and original bytes, and releases each image before the next", async (t) => {
  const f = fixture(t, { sizes: [{ width: 1600, height: 900 }, { width: 1080, height: 1440 }] });
  const inputs = [source("海报.JPG", jpeg()), source("second")];
  inputs[0].name = "海报.JPG";
  const originalBytes = await Promise.all(inputs.map((image) => image.blob.arrayBuffer()));
  const result = await adaptDraftImages(inputs, "wechat");
  assert.deepEqual(result.map(({ id, name, width, height, blob }) => ({ id, name, width, height, mime: blob.type })), [
    { id: "海报.JPG", name: "海报.png", width: 1080, height: 1350, mime: "image/png" },
    { id: "second", name: "second.png", width: 1080, height: 1350, mime: "image/png" },
  ]);
  assert.deepEqual(f.calls.filter((call) => call.type === "draw").map((call) => call.args), [[0, 371.25, 1080, 607.5], [33.75, 0, 1012.5, 1350]]);
  assert.deepEqual(f.calls.filter((call) => call.type === "background").map(({ color, args }) => ({ color, args })), Array(2).fill({ color: "#ffffff", args: [0, 0, 1080, 1350] }));
  assert.deepEqual(f.calls.filter((call) => call.type === "decode").map((call) => call.revoked), [0, 1]);
  assert.deepEqual(await Promise.all(inputs.map((image) => image.blob.arrayBuffer())), originalBytes);
  assert.equal(inputs[0].name, "海报.JPG"); assert.equal(inputs[0].height, 1440);
  cleaned(f);
});

test("valid exact-size PNG and JPEG reuse the original Blob after decoding and correct saved metadata", async (t) => {
  const f = fixture(t, { sizes: [{ width: 1080, height: 1440 }, { width: 1080, height: 1440 }] });
  const inputs = [source("png"), { ...source("jpeg", jpeg()), name: "photo.jpeg", width: 1, height: 1 }];
  const result = await adaptDraftImages(inputs, "xiaohongshu");
  assert.equal(result[0].blob, inputs[0].blob); assert.equal(result[1].blob, inputs[1].blob);
  assert.equal(result[1].name, "photo.jpeg"); assert.equal(result[1].width, 1080); assert.equal(result[1].height, 1440);
  assert.equal(f.canvases.length, 0); cleaned(f);
});

test("rejects empty, non-raster or mislabeled input before a decoder can fetch any content", async (t) => {
  const f = fixture(t);
  for (const blob of [new Blob([], { type: "image/png" }), new Blob(["<svg/>"], { type: "image/svg+xml" }), new Blob(["<svg/>"], { type: "image/png" }), new Blob([await png().arrayBuffer()], { type: "image/jpeg" })]) {
    await assert.rejects(adaptDraftImages([source("bad", blob)], "wechat"), /PNG|JPEG|格式与内容不一致/);
  }
  assert.equal(f.images.length, 0); assert.equal(f.canvases.length, 0);
});

test("decoder failure rejects the whole batch without changing inputs or processing later images", async (t) => {
  const f = fixture(t, { failDecode: true });
  const inputs = [source(), source("second")];
  await assert.rejects(adaptDraftImages(inputs, "wechat"), /无法打开图片/);
  assert.equal(f.images.length, 1); assert.equal(inputs.length, 2); cleaned(f);
});

test("cancellation before starting does not allocate resources", async (t) => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(adaptDraftImages([source()], "wechat", controller.signal), { name: "AbortError" });
  assert.equal(f.images.length, 0); assert.equal(f.canvases.length, 0);
});

test("cancellation during decoding releases the URL and does not start later images", async (t) => {
  const f = fixture(t, { stallDecode: true }), controller = new AbortController();
  const pending = adaptDraftImages([source(), source("later")], "wechat", controller.signal);
  const checked = assert.rejects(pending, { name: "AbortError" });
  await flush(); assert.equal(f.images.length, 1); controller.abort(); await checked;
  assert.equal(f.images.length, 1); cleaned(f);
});

test("decoder timeout is bounded and cleans up a stalled image", async (t) => {
  const f = fixture(t, { stallDecode: true }); t.mock.timers.enable({ apis: ["setTimeout"] });
  const checked = assert.rejects(adaptDraftImages([source()], "wechat"), /图片读取超时/);
  await flush(); t.mock.timers.tick(15_001); await checked; cleaned(f);
});

test("encoder timeout releases the canvas and ignores its late result", async (t) => {
  const f = fixture(t, { stallEncode: true }); t.mock.timers.enable({ apis: ["setTimeout"] });
  const checked = assert.rejects(adaptDraftImages([source()], "wechat"), /图片生成超时/);
  await flush(); assert.equal(f.canvases.length, 1); t.mock.timers.tick(15_001); await checked; cleaned(f);
  f.canvases[0].finish(png()); await flush(); cleaned(f);
});

test("cancellation during encoding returns no partial result and frees temporary resources", async (t) => {
  const f = fixture(t, { stallEncode: true }), controller = new AbortController();
  const checked = assert.rejects(adaptDraftImages([source(), source("later")], "wechat", controller.signal), { name: "AbortError" });
  await flush(); assert.equal(f.canvases.length, 1); controller.abort(); await checked;
  assert.equal(f.images.length, 1); cleaned(f);
  f.canvases[0].finish(png()); await flush(); cleaned(f);
});

test("a failed encoder reports a useful error and releases resources", async (t) => {
  const f = fixture(t, { failEncode: true });
  await assert.rejects(adaptDraftImages([source()], "wechat"), /图片生成失败/); cleaned(f);
});

test("missing canvas support is reported in Chinese and still releases the image", async (t) => {
  const f = fixture(t, { noContext: true });
  await assert.rejects(adaptDraftImages([source()], "wechat"), /当前浏览器无法处理图片/); cleaned(f);
});
