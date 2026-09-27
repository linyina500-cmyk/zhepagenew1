import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readImageFingerprints } from "../server/xiaohongshu/image-evidence.mjs";

const card = (id, source = `blob:https://creator.xiaohongshu.com/${id}`) => `<div class="pr"><img id="${id}" src="${source}"></div>`;
function fixture(t, html, imageData = {}, { tainted = [], noContext = false, onDigest } = {}) {
  const dom = new JSDOM(`<div class="img-preview-area">${html}</div>`, { url: "https://creator.xiaohongshu.com", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom, calls = [], canvases = [];
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.dataset.zero === "true" ? 0 : 20, height: 20 }; };
  for (const image of window.document.querySelectorAll("img")) {
    const data = imageData[image.id] ?? {};
    for (const [name, value] of Object.entries({ complete: data.complete ?? true, naturalWidth: data.width ?? 1, naturalHeight: data.height ?? 1 })) {
      Object.defineProperty(image, name, { configurable: true, value });
    }
  }
  Object.defineProperty(window.crypto, "subtle", { value: { async digest(algorithm, bytes) {
    calls.push(["digest", algorithm]);
    await onDigest?.(window);
    return webcrypto.subtle.digest(algorithm, bytes);
  } } });
  window.HTMLCanvasElement.prototype.getContext = function (_type, options) {
    canvases.push(this); calls.push(["context", this.width, this.height, options]);
    if (noContext) return null;
    let image;
    return {
      drawImage(value, ...dimensions) { image = value; calls.push(["draw", image.id, ...dimensions]); },
      getImageData(...dimensions) {
        calls.push(["read", image.id, ...dimensions]);
        if (tainted.includes(image.id)) throw new window.DOMException("Sensitive source must not be exposed", "SecurityError");
        return { data: new window.Uint8ClampedArray(imageData[image.id]?.pixels ?? [12, 34, 56, 255]) };
      },
    };
  };
  const read = async () => {
    const result = await window.eval(`(${readImageFingerprints.toString()})({selectors:{images:".img-preview-area .pr"}})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { window, calls, canvases, read };
}
function expected(width, height, pixels) {
  const dimensions = Buffer.alloc(8); dimensions.writeUInt32BE(width); dimensions.writeUInt32BE(height, 4);
  return `pixels:${width}x${height}:${createHash("sha256").update(dimensions).update(Buffer.from(pixels)).digest("hex")}`;
}

test("fingerprints hash the original RGBA pixels and dimensions without depending on blob or remote URLs", async (t) => {
  const rgba = [12, 34, 56, 255], changed = [12, 34, 57, 255];
  const f = fixture(t, card("first") + card("same", "blob:https://creator.xiaohongshu.com/new-id") + card("changed", "https://cdn.example/same.png"),
    { first: { pixels: rgba }, same: { pixels: rgba }, changed: { pixels: changed } });
  assert.deepEqual(await f.read(), [expected(1, 1, rgba), expected(1, 1, rgba), expected(1, 1, changed)]);
  assert.deepEqual(f.calls.filter(([action]) => action === "draw").map((call) => call.slice(1)), [["first", 0, 0, 1, 1], ["same", 0, 0, 1, 1], ["changed", 0, 0, 1, 1]]);
  assert.ok(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("dimensions and alpha are part of the fingerprint and canvases are processed in sequence", async (t) => {
  const rgba = [0, 1, 2, 255, 3, 4, 5, 0], alphaChanged = [...rgba.slice(0, -1), 1];
  let digesting = false;
  const f = fixture(t, card("wide") + card("tall") + card("alpha"), {
    wide: { width: 2, height: 1, pixels: rgba }, tall: { width: 1, height: 2, pixels: rgba }, alpha: { width: 2, height: 1, pixels: alphaChanged },
  }, { async onDigest() { assert.equal(digesting, false); digesting = true; await new Promise((resolve) => setTimeout(resolve, 5)); digesting = false; } });
  assert.deepEqual(await f.read(), [expected(2, 1, rgba), expected(1, 2, rgba), expected(2, 1, alphaChanged)]);
  assert.deepEqual(f.calls.map(([action]) => action), ["context", "draw", "read", "digest", "context", "draw", "read", "digest", "context", "draw", "read", "digest"]);
});

test("tainted images and incomplete decodes return null without falling back to an HTTPS source", async (t) => {
  const f = fixture(t, card("tainted", "https://cdn.example/private.png") + card("incomplete") + card("zero-width") + card("zero-height") + card("good"), {
    incomplete: { complete: false }, "zero-width": { width: 0 }, "zero-height": { height: 0 },
  }, { tainted: ["tainted"] });
  assert.deepEqual(await f.read(), [null, null, null, null, expected(1, 1, [12, 34, 56, 255])]);
  assert.equal(f.calls.filter(([action]) => action === "draw").length, 2);
  assert.ok(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("visible outermost cards retain DOM order while hidden and nested duplicate cards are ignored", async (t) => {
  const f = fixture(t, `<div hidden>${card("hidden")}</div><div aria-hidden="true">${card("aria")}</div><div style="display:none">${card("display")}</div>
    <div style="visibility:hidden">${card("visibility")}</div><div class="pr" data-zero="true"><img id="zero"></div>
    <div class="pr">${card("outer-image")}</div>${card("second")}`, { second: { pixels: [3, 4, 5, 255] } });
  assert.deepEqual(await f.read(), [expected(1, 1, [12, 34, 56, 255]), expected(1, 1, [3, 4, 5, 255])]);
  assert.deepEqual(f.calls.filter(([action]) => action === "draw").map(([, id]) => id), ["outer-image", "second"]);
});

test("image count and pixel bounds reject oversized inputs before allocating canvases", async (t) => {
  const excessive = fixture(t, Array.from({ length: 19 }, (_, index) => card(`image-${index}`)).join(""));
  assert.equal(await excessive.read(), null); assert.equal(excessive.canvases.length, 0);
  const oversized = fixture(t, card("pixels") + card("side") + card("missing"), {
    pixels: { width: 5000, height: 5000 }, side: { width: 16385, height: 1 },
  });
  oversized.window.document.querySelector("#missing").remove();
  assert.deepEqual(await oversized.read(), [null, null, null]); assert.equal(oversized.canvases.length, 0);
});

test("missing canvas context or digest capability cannot supply image identity", async (t) => {
  const withoutCanvas = fixture(t, card("image"), {}, { noContext: true });
  assert.deepEqual(await withoutCanvas.read(), [null]);
  const withoutDigest = fixture(t, card("image"), {}, { onDigest() { throw new Error("private data"); } });
  assert.deepEqual(await withoutDigest.read(), [null]);
  assert.ok(withoutDigest.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("a changed image list or unloaded image while hashing is not accepted as stable evidence", async (t) => {
  const reordered = fixture(t, card("first") + card("second"), {}, { onDigest(window) {
    const first = window.document.querySelector("#first").parentElement;
    first.parentElement.append(first);
  } });
  assert.equal(await reordered.read(), null);
  const unloaded = fixture(t, card("image"), {}, { onDigest(window) { Object.defineProperty(window.document.querySelector("img"), "complete", { value: false }); } });
  assert.deepEqual(await unloaded.read(), [null]);
});

test("a same-size source replacement during hashing invalidates the fingerprint without exposing its URL", async (t) => {
  for (const sourceType of ["src", "currentSrc"]) {
    await t.test(sourceType, async (t) => {
      const f = fixture(t, card("image"), {}, { onDigest(window) {
        const image = window.document.querySelector("img");
        const replacement = "blob:https://creator.xiaohongshu.com/replacement-private-source";
        if (sourceType === "src") image.setAttribute("src", replacement);
        else Object.defineProperty(image, "currentSrc", { value: replacement });
      } });
      if (sourceType === "currentSrc") Object.defineProperty(f.window.document.querySelector("img"), "currentSrc", { configurable: true, value: "blob:https://creator.xiaohongshu.com/decoded-original" });
      const result = await f.read();
      assert.deepEqual(result, [null]);
      assert.doesNotMatch(JSON.stringify(result), /blob:|replacement-private-source/u);
      assert.ok(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
    });
  }
});
