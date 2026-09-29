import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import type * as Adapter from "../../lib/draftSync/adaptImages";

type AdapterWindow = Window & { imageAdapter: typeof Adapter };
const moduleSource = ts.transpileModule(await readFile("lib/draftSync/adaptImages.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html lang="zh-CN"><title>图片适配像素验证</title><body></body></html>');
  await page.addScriptTag({ type: "module", content: `${moduleSource}\nwindow.imageAdapter = { PLATFORM_IMAGE_SIZES, fitImageRect, adaptDraftImages };` });
});

test("real image adaptation preserves all four corners, white margins, transparency and original bytes for both platforms", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const results = await page.evaluate(async () => {
    const { adaptDraftImages } = (window as unknown as AdapterWindow).imageAdapter;
    const encode = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Fixture encoding failed")), "image/png"));
    const make = async (id: string, width: number, height: number, transparent = false) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      if (transparent) { context.fillStyle = "#000000"; context.fillRect(width / 4, height / 4, width / 2, height / 2); }
      else {
        for (const [x, y, color] of [[0, 0, "#ff0000"], [width / 2, 0, "#00ff00"], [0, height / 2, "#0000ff"], [width / 2, height / 2, "#ffff00"]] as const) {
          context.fillStyle = color; context.fillRect(x, y, width / 2, height / 2);
        }
      }
      return { id, name: `${id}.PNG`, blob: await encode(canvas), width, height };
    };
    const originals = [await make("landscape", 1600, 800), await make("portrait", 600, 1600), await make("transparent", 100, 100, true)];
    const before = await Promise.all(originals.map(async (image) => Array.from(new Uint8Array(await image.blob.arrayBuffer())).join(",")));
    const sample = async (blob: Blob, points: number[][]) => {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, colors: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
      } finally { bitmap.close(); }
    };
    const wechat = await adaptDraftImages(originals, "wechat");
    const xhs = await adaptDraftImages([originals[0]], "xiaohongshu");
    return {
      ids: wechat.map((image) => image.id), names: wechat.map((image) => image.name), types: wechat.map((image) => image.blob.type),
      landscape: await sample(wechat[0].blob, [[2, 407], [1077, 407], [2, 942], [1077, 942], [540, 10], [540, 1340]]),
      portrait: await sample(wechat[1].blob, [[290, 3], [790, 3], [290, 1346], [790, 1346], [100, 675], [1000, 675]]),
      transparent: await sample(wechat[2].blob, [[540, 20], [20, 200], [540, 675]]),
      xhs: await sample(xhs[0].blob, [[2, 452], [1077, 452], [2, 987], [1077, 987], [540, 10], [540, 1430]]),
      unchanged: before.every((bytes, index) => originals[index].name.endsWith(".PNG") && bytes.length > 0) && JSON.stringify(before) === JSON.stringify(await Promise.all(originals.map(async (image) => Array.from(new Uint8Array(await image.blob.arrayBuffer())).join(",")))),
    };
  });
  const cornersAndMargins = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255]];
  expect(results.ids).toEqual(["landscape", "portrait", "transparent"]);
  expect(results.names).toEqual(["landscape.png", "portrait.png", "transparent.png"]);
  expect(results.types).toEqual(["image/png", "image/png", "image/png"]);
  expect(results.landscape).toEqual({ width: 1080, height: 1350, colors: cornersAndMargins });
  expect(results.portrait).toEqual({ width: 1080, height: 1350, colors: cornersAndMargins });
  expect(results.transparent).toEqual({ width: 1080, height: 1350, colors: [[255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255]] });
  expect(results.xhs).toEqual({ width: 1080, height: 1440, colors: cornersAndMargins });
  expect(results.unchanged).toBe(true);
  expect(requests).toEqual([]);
});

test("real exact-size PNG and JPEG keep their original Blob and corrupt image data never bypasses decoding", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { adaptDraftImages } = (window as unknown as AdapterWindow).imageAdapter;
    const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1440;
    const context = canvas.getContext("2d")!; context.fillStyle = "#246810"; context.fillRect(0, 0, 1080, 1440);
    const blobs = await Promise.all(["image/png", "image/jpeg"].map((type) => new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), type))));
    const input = blobs.map((blob, index) => ({ id: `exact-${index}`, name: index ? "原图.jpeg" : "原图.PNG", width: 1, height: 1, blob }));
    const output = await adaptDraftImages(input, "xiaohongshu");
    let invalidMessage = "";
    try { await adaptDraftImages([{ ...input[0], width: 1080, height: 1440, blob: new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }) }], "xiaohongshu"); }
    catch (error) { invalidMessage = (error as Error).message; }
    return { sameBlobs: output.every((image, index) => image.blob === input[index].blob), metadata: output.map(({ width, height, name }) => ({ width, height, name })), invalidMessage };
  });
  expect(result.sameBlobs).toBe(true);
  expect(result.metadata).toEqual([{ width: 1080, height: 1440, name: "原图.png" }, { width: 1080, height: 1440, name: "原图.jpeg" }]);
  expect(result.invalidMessage).toContain("无法打开图片");
});
