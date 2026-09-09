import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page, type TestInfo } from "@playwright/test";
import JSZip from "jszip";
import { makePng, shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewImage, expectPreviewReady, importRichArticle, mainEditor, mainEditorPanel, openRichTextImport, openWorkbench, pasteImage, uploadImage } from "./helpers";

type Marker = { pageNumber: number; x: number; y: number; red: number; green: number; blue: number };
const FIRST_COLOR = [17, 193, 137] as const;
const SECOND_COLOR = [23, 91, 227] as const;
const pngSource = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
const exportDiagnostics = new WeakMap<Page, { active: boolean; messages: string[] }>();

async function largeClipboardPng(page: Page, color: readonly [number, number, number]) {
  const base64 = await page.evaluate((rgb) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is required to create the large clipboard PNG fixture");
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#f4d452");
    gradient.addColorStop(1, "#243d73");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = `rgb(${rgb.join(",")})`;
    context.fillRect(400, 225, 800, 450);
    return canvas.toDataURL("image/png").split(",")[1];
  }, color);
  const png = Buffer.from(base64, "base64");
  expect(png.readUInt32BE(16)).toBe(1600);
  expect(png.readUInt32BE(20)).toBe(900);
  return png;
}

async function downloadOrExportError(page: Page, trigger: () => Promise<unknown>, timeout: number): Promise<Download> {
  const diagnostics = exportDiagnostics.get(page);
  if (diagnostics) diagnostics.active = true;
  await page.evaluate(() => { (window as Window & { __exportImageCaptureActive?: boolean }).__exportImageCaptureActive = true; });
  const result = Promise.race([
    page.waitForEvent("download", { timeout }),
    page.locator(".status-pill.error").waitFor({ state: "visible", timeout }).then(async () => {
      throw new Error(`Image export failed before download: ${await page.locator(".status-pill.error").textContent()}`);
    }),
  ]);
  // Observe trigger and both race branches immediately, including timeouts and
  // test teardown. A losing wait must not create an unhandled rejection.
  const [, download] = await Promise.all([Promise.resolve().then(trigger), result]);
  return download;
}

async function locateMarker(page: Page, source: string, color: readonly [number, number, number]): Promise<Marker> {
  await expectPreviewReady(page);
  return page.locator(".poster-grid .article-flow img").evaluateAll((nodes, input) => {
    const image = nodes.find((node) => (node as HTMLImageElement).src === input.source) as HTMLImageElement | undefined;
    if (!image?.complete || !image.naturalWidth) throw new Error("The real preview image must be decoded before exporting");
    const poster = image.closest<HTMLElement>(".poster-page");
    if (!poster) throw new Error("The uploaded image is missing from the rendered poster");
    const imageBox = image.getBoundingClientRect();
    const posterBox = poster.getBoundingClientRect();
    const posters = [...document.querySelectorAll(".poster-grid .poster-page")];
    return {
      pageNumber: posters.indexOf(poster) + 1,
      x: Math.round((imageBox.left + imageBox.width / 2 - posterBox.left) * 1080 / posterBox.width),
      y: Math.round((imageBox.top + imageBox.height / 2 - posterBox.top) * 1440 / posterBox.height),
      red: input.color[0], green: input.color[1], blue: input.color[2],
    };
  }, { source, color });
}

async function expectImagePixels(page: Page, png: Buffer, marker: Marker) {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1440);
  const result = await page.evaluate(async ({ base64, target }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas decoding is required to verify the exported image contents");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(target.x - 2, target.y - 2, 5, 5).data;
    let matching = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (Math.abs(pixels[index] - target.red) <= 4 && Math.abs(pixels[index + 1] - target.green) <= 4 && Math.abs(pixels[index + 2] - target.blue) <= 4 && pixels[index + 3] >= 250) matching += 1;
    }
    return { matching, center: [target.x, target.y], actual: Array.from(pixels.subarray(0, 4)) };
  }, { base64: png.toString("base64"), target: marker });
  expect(result.matching, `The downloaded PNG must contain the inserted picture at ${result.center}; sampled RGBA ${result.actual}`).toBeGreaterThanOrEqual(20);
}

async function downloadImagePage(page: Page, marker: Marker, testInfo: TestInfo, name: string) {
  const download = await downloadOrExportError(page, () => page.getByRole("button", { name: `导出第 ${marker.pageNumber} 页`, exact: true }).click(), 110_000);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const output = testInfo.outputPath(name);
  await download.saveAs(output);
  const png = await readFile(output);
  await testInfo.attach(name, { path: output, contentType: "image/png" });
  await expectImagePixels(page, png, marker);
  await expect(page.locator(".status-pill.success")).toContainText("已导出为高清 PNG");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type DecodeError = { prefix: string; length: number; mime: string; parserError: string; svg?: string };
    const state = window as Window & { __exportImageCaptureActive?: boolean; __exportImageErrors?: DecodeError[] };
    state.__exportImageErrors = [];
    window.Image = new Proxy(window.Image, {
      construct(target, args) {
        const image = Reflect.construct(target, args) as HTMLImageElement;
        image.addEventListener("error", () => {
          if (!state.__exportImageCaptureActive || state.__exportImageErrors!.length >= 8) return;
          const source = image.currentSrc || image.src;
          const entry: DecodeError = { prefix: source.slice(0, 50), length: source.length, mime: /^data:([^;,]+)/.exec(source)?.[1] || "url", parserError: "" };
          if (entry.mime === "image/svg+xml") {
            try {
              const comma = source.indexOf(",");
              const svg = source.slice(0, comma).includes(";base64")
                ? new TextDecoder().decode(Uint8Array.from(atob(source.slice(comma + 1)), (character) => character.charCodeAt(0)))
                : decodeURIComponent(source.slice(comma + 1));
              const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
              entry.parserError = parsed.querySelector("parsererror")?.textContent?.slice(0, 1200) || "No XML parser error";
              // These tests use synthetic fixtures only. Retain one failing
              // SVG as an artifact, never dump its embedded base64 to console.
              if (!state.__exportImageErrors!.some((error) => error.svg)) entry.svg = svg;
            } catch (error) { entry.parserError = String(error).slice(0, 1200); }
          }
          state.__exportImageErrors!.push(entry);
        });
        return image;
      },
    });
  });
  const diagnostics = { active: false, messages: [] as string[] };
  exportDiagnostics.set(page, diagnostics);
  page.on("console", (message) => {
    if (diagnostics.active && ["warning", "error"].includes(message.type())) {
      const location = message.location();
      diagnostics.messages.push(`[console.${message.type()}] ${message.text()}\n${location.url}:${location.lineNumber}:${location.columnNumber}`);
    }
  });
  page.on("pageerror", (error) => {
    if (diagnostics.active) diagnostics.messages.push(`[pageerror] ${error.stack || error.message}`);
  });
  await openWorkbench(page);
});

test.afterEach(async ({ page }, testInfo) => {
  const imageErrors = await page.evaluate(() => (window as Window & { __exportImageErrors?: { prefix: string; length: number; mime: string; parserError: string; svg?: string }[] }).__exportImageErrors || []).catch(() => []);
  if (imageErrors.length) {
    for (const [index, error] of imageErrors.entries()) {
      if (error.svg) await testInfo.attach(`image-decode-failure-${index + 1}`, { body: error.svg, contentType: "image/svg+xml" });
    }
    await testInfo.attach("image-decode-errors", { body: JSON.stringify(imageErrors.map(({ prefix, length, mime, parserError }) => ({ prefix, length, mime, parserError })), null, 2), contentType: "application/json" });
  }
  const diagnostics = exportDiagnostics.get(page);
  if (diagnostics?.messages.length) await testInfo.attach("image-export-console", { body: diagnostics.messages.join("\n\n"), contentType: "text/plain" });
  if (testInfo.status !== testInfo.expectedStatus) {
    const status = await page.locator(".status-pill").textContent().catch(() => "Page unavailable");
    await testInfo.attach("image-export-status", { body: status || "", contentType: "text/plain" });
  }
});

test("uploading a PNG into the real editor allows downloading the image-containing page", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await mainEditor(page).click();
  await mainEditor(page).press("ControlOrMeta+End");
  await mainEditor(page).press("Enter");
  const png = makePng(...FIRST_COLOR);
  await uploadImage(page, mainEditorPanel(page), png, "uploaded-export-marker.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, pngSource(png));
  const marker = await locateMarker(page, pngSource(png), FIRST_COLOR);
  await downloadImagePage(page, marker, testInfo, "uploaded-image-page.png");
});

test("pasting a PNG into the real editor preserves its pixels in a single-page download", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const png = await largeClipboardPng(page, SECOND_COLOR);
  await testInfo.attach("large-clipboard-source", { body: png, contentType: "image/png" });
  await pasteImage(mainEditor(page), png, "pasted-export-marker.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, pngSource(png));
  const marker = await locateMarker(page, pngSource(png), SECOND_COLOR);
  await downloadImagePage(page, marker, testInfo, "pasted-image-page.png");
});

test("an image-only one-click import retains the pasted PNG and downloads its image page", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { dialog, editor } = await openRichTextImport(page);
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  const png = makePng(...FIRST_COLOR);
  await pasteImage(editor, png, "image-only-import.png");
  await expect(editor.locator("img")).toHaveCount(1);
  await expect(editor.locator("img")).toHaveAttribute("src", pngSource(png));
  await expect.poll(async () => (await editor.textContent() || "").trim()).toBe("");
  await dialog.getByRole("button", { name: "导入并替换正文 →", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expect(mainEditor(page).locator("img")).toHaveAttribute("src", pngSource(png));
  await expect(page.getByLabel("醒目标题", { exact: true })).toHaveValue("未命名文章");
  await expectPreviewImage(page, pngSource(png));
  const marker = await locateMarker(page, pngSource(png), FIRST_COLOR);
  await downloadImagePage(page, marker, testInfo, "image-only-import-page.png");
});

test("the batch ZIP opens with all pages and both inserted images intact", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const first = makePng(...FIRST_COLOR);
  const second = makePng(...SECOND_COLOR);
  await pasteImage(mainEditor(page), first, "first-zip-marker.png");
  await expectPreviewImage(page, pngSource(first));
  await mainEditor(page).click();
  await mainEditor(page).press("ControlOrMeta+End");
  await mainEditor(page).press("Enter");
  await mainEditorPanel(page).locator('button[data-tooltip="从光标位置开始新的一张贴图"]').click();
  await pasteImage(mainEditor(page), second, "second-zip-marker.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(2);
  await expectPreviewImage(page, pngSource(second), 2);
  const markers = [await locateMarker(page, pngSource(first), FIRST_COLOR), await locateMarker(page, pngSource(second), SECOND_COLOR)];
  expect(markers[1].pageNumber).toBeGreaterThan(markers[0].pageNumber);
  const totalPages = await page.locator(".poster-grid .poster-page").count();
  const download = await downloadOrExportError(page, () => page.getByRole("button", { name: /^批量导出 \d+ 张$/ }).click(), 160_000);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const output = testInfo.outputPath("image-pages.zip");
  await download.saveAs(output);
  await testInfo.attach("image-pages", { path: output, contentType: "application/zip" });
  const zip = await JSZip.loadAsync(await readFile(output), { checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir).sort((left, right) => left.name.localeCompare(right.name));
  expect(entries).toHaveLength(totalPages);
  for (const [index, entry] of entries.entries()) {
    expect(entry.name).toBe(`折页-小红书-${String(index + 1).padStart(2, "0")}.png`);
    const png = await entry.async("nodebuffer");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1440);
    for (const marker of markers.filter((item) => item.pageNumber === index + 1)) await expectImagePixels(page, png, marker);
  }
  await expect(page.locator(".status-pill.success")).toContainText(`${totalPages} 张贴图已打包下载`);
});

test("an external article image uses the image proxy and remains in the downloaded PNG", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const png = makePng(...FIRST_COLOR);
  const remote = "https://images.example.com/export-regression.png";
  const proxy = `/api/image?url=${encodeURIComponent(remote)}`;
  let proxyRequests = 0;
  await page.route("**/api/image?**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("url")).toBe(remote);
    proxyRequests += 1;
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  const html = `${shortArticleHtml}<p><img src="${remote}" alt="导出图片验证"></p>`;
  await importRichArticle(page, html, shortTitle + shortBody);
  await expect(mainEditor(page).locator("img")).toHaveAttribute("src", proxy);
  const source = new URL(proxy, page.url()).href;
  await expectPreviewImage(page, source);
  expect(proxyRequests).toBeGreaterThan(0);
  const marker = await locateMarker(page, source, FIRST_COLOR);
  await downloadImagePage(page, marker, testInfo, "proxied-image-page.png");
});

test("clipboard image metadata that is valid HTML cannot break SVG-based PNG export", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const png = makePng(...FIRST_COLOR);
  await pasteImage(mainEditor(page), png, "剪贴板\u000b图片.png");
  await expectPreviewImage(page, pngSource(png));
  const originalAlt = await mainEditor(page).locator("img").getAttribute("alt");
  expect(originalAlt).toContain("\u000b");
  const marker = await locateMarker(page, pngSource(png), FIRST_COLOR);
  await downloadImagePage(page, marker, testInfo, "clipboard-metadata-image.png");
  await expect(mainEditor(page).locator("img")).toHaveAttribute("alt", originalAlt!);
});

test("an already decoded preview image exports even if a subsequent proxy request fails", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const png = makePng(...SECOND_COLOR);
  const remote = "https://images.example.com/preview-only-image.png";
  const proxy = `/api/image?url=${encodeURIComponent(remote)}`;
  let unavailable = false;
  let requestsAfterPreview = 0;
  await page.route("**/api/image?**", async (route) => {
    if (unavailable) { requestsAfterPreview++; await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "simulated upstream failure after preview" }) }); }
    else await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await importRichArticle(page, `${shortArticleHtml}<p><img src="${remote}" alt="已加载图片"></p>`, shortTitle + shortBody);
  const source = new URL(proxy, page.url()).href;
  await expectPreviewImage(page, source);
  const marker = await locateMarker(page, source, SECOND_COLOR);
  unavailable = true;
  await downloadImagePage(page, marker, testInfo, "image-with-unavailable-proxy.png");
  expect(requestsAfterPreview).toBe(0);
});
