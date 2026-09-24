import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { makePng, shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewReady, importRichArticle, openWorkbench } from "./helpers";
import { startWechatTestServer } from "./wechat-server";

async function openDraftDialog(page: Page) {
  await page.getByRole("button", { name: "同步草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "同步与发布", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status", { name: "" }).filter({ hasText: "正在检查本机存档" })).toHaveCount(0);
  return dialog;
}

async function prepareRealImages(page: Page) {
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await expectPreviewReady(page);
  const dialog = await openDraftDialog(page);
  await expect(dialog.getByRole("link", { name: "下载 Mac 启动工具", exact: true })).toHaveCount(0);
  await expect(dialog.locator('a[href^="http://127.0.0.1:"], a[href^="http://localhost:"]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible({ timeout: 110_000 });
  await expect(dialog.locator(".draft-sync-footer-status")).toContainText("已准备");
  await waitAdaptedImages(dialog);
  await expect.poll(() => dialog.locator(".draft-sync-image-card img").first().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1080);
  return dialog;
}

async function choosePlatform(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await dialog.locator(".draft-sync-platforms").getByRole("button", { name: platform === "wechat" ? /^公众号贴图/ : /^小红书/ }).click();
}

const sourceCards = (dialog: Locator) => dialog.locator('.draft-sync-image-card');
const riskCard = (dialog: Locator) => dialog.locator('.draft-sync-image-card:has(.draft-sync-image-actions[hidden])');

async function waitAdaptedImages(dialog: Locator) {
  await expect(dialog.locator(".draft-sync-size-summary")).not.toContainText("正在");
  await expect.poll(() => dialog.locator(".draft-sync-image-card img").evaluateAll((images) => images.length > 0 && images.every((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 1080))).toBe(true);
}

async function imageManifest(dialog: Locator) {
  await waitAdaptedImages(dialog);
  return dialog.locator(".draft-sync-image-card").evaluateAll(async (cards) => Promise.all(cards.map(async (card) => {
    const image = card.querySelector("img")!, blob = await (await fetch(image.src)).blob(), bytes = await blob.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
    return { name: card.getAttribute("data-image-name")!, size: blob.size, hash, width: image.naturalWidth, height: image.naturalHeight, signature: Array.from(new Uint8Array(bytes).subarray(0, 8)) };
  })));
}

async function confirmRisk(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await waitAdaptedImages(dialog);
  const label = platform === "wechat" ? "公众号贴图" : "小红书";
  await dialog.getByLabel(new RegExp(`^我已确认${label}的风险提示`)).check();
  await waitAdaptedImages(dialog);
}

async function confirmPlatformImages(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await confirmRisk(dialog, platform);
  await dialog.getByRole("button", { name: platform === "wechat" ? "确认图片，选择公众号" : "确认图片，连接小红书", exact: true }).click();
}

async function connectLocalDevice(page: Page, dialog: Locator) {
  const pagesBefore = page.context().pages().length;
  await dialog.getByRole("button", { name: "连接这台电脑", exact: true }).click();
  await expect(dialog.locator(".draft-sync-connection")).toContainText("本机连接已保存");
  expect(page.context().pages()).toHaveLength(pagesBefore);
  await expect(dialog.getByLabel("本机连接口令", { exact: true })).toHaveCount(0);
  await expect(dialog.locator('.draft-sync-connection input[type="file"]')).toHaveCount(0);
}

async function captureConnectionSteps(page: Page, dialog: Locator, name: string) {
  for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const focus = name.includes("account-ready") ? dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true }) : dialog.locator(".draft-sync-connection");
    await focus.scrollIntoViewIfNeeded();
    await expect(focus).toBeInViewport();
    await page.screenshot({ path: `test-results/${name}-${viewport.width}.png` });
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1110, height: 770 });
}

async function captureContentStep(page: Page, dialog: Locator, platform: "xiaohongshu" | "wechat") {
  for (const viewport of [{ width: 1110, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await dialog.locator(".draft-sync-scroll").evaluate((element) => { element.scrollTop = 0; });
    await expect(dialog.locator(".draft-sync-platform-bar")).toBeInViewport();
    await page.screenshot({ path: `test-results/${platform}-content-${viewport.width}.png` });
    await riskCard(dialog).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/${platform}-risk-${viewport.width}.png` });
    await dialog.locator(".draft-sync-risk-confirm").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/${platform}-risk-confirmation-${viewport.width}.png` });
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1110, height: 770 });
}

async function lastPageBodyHash(dialog: Locator, bottomRatio: number) {
  return riskCard(dialog).locator("img").evaluate(async (node, ratio) => {
    const image = node as HTMLImageElement, canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = Math.floor(image.naturalHeight * ratio);
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))].map((value) => value.toString(16).padStart(2, "0")).join("");
  }, bottomRatio);
}

async function saveSamePageProof(page: Page, dialog: Locator, platform: "xiaohongshu" | "wechat") {
  const directory = ".wechat-sync-local/ui-proof-same-page-risk-20260924";
  mkdirSync(directory, { recursive: true });
  const bytes = await riskCard(dialog).locator("img").evaluate(async (node) => Array.from(new Uint8Array(await (await fetch((node as HTMLImageElement).src)).arrayBuffer())));
  writeFileSync(`${directory}/${platform}-whole-last-page.png`, Buffer.from(bytes));
  for (const viewport of [{ width: 1110, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await riskCard(dialog).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/${platform}-last-page-${viewport.width}.png` });
    await dialog.locator(".draft-sync-risk-confirm").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${directory}/${platform}-confirmation-${viewport.width}.png` });
  }
  await page.setViewportSize({ width: 1110, height: 770 });
}

async function uploadDraftFile(page: Page, button: Locator, name: string, png: Buffer) {
  const chooserPromise = page.waitForEvent("filechooser");
  await button.click();
  await (await chooserPromise).setFiles({ name, mimeType: "image/png", buffer: png });
}

async function savedDraftSummary(page: Page) {
  return page.evaluate(async () => {
    type Stored = { content: Record<string, { title: string; body: string }>; images: { name: string; mime: string; bytes: ArrayBuffer; width: number; height: number }[]; selectedAccountIds: string[]; receipts: { accountId: string; status: string }[] };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("zhepage-local-draft-sync", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const value = await new Promise<Stored | undefined>((resolve, reject) => {
        const transaction = database.transaction("drafts", "readonly");
        const request = transaction.objectStore("drafts").get("current");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
      });
      if (!value) return null;
      return {
        serialized: JSON.stringify(value),
        content: value.content,
        selectedAccountIds: value.selectedAccountIds,
        receipts: value.receipts,
        images: value.images.map((image) => ({
          name: image.name, width: image.width, height: image.height, size: image.bytes.byteLength,
          signature: Array.from(new Uint8Array(image.bytes.slice(0, 8))),
        })),
      };
    } finally { database.close(); }
  });
}

test.beforeEach(async ({ page }) => {
  await openWorkbench(page);
});

test("real poster images and independent platform copy survive explicit local save and restore", async ({ page }) => {
  test.setTimeout(240_000);
  let dialog = await prepareRealImages(page);
  const cards = sourceCards(dialog);
  const initialCount = await cards.count();
  expect(initialCount).toBeGreaterThan(0);
  const renderedImage = await cards.first().locator("img").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    const blob = await (await fetch(image.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { width: image.naturalWidth, height: image.naturalHeight, size: bytes.length, signature: Array.from(bytes.subarray(0, 8)) };
  });
  const originalName = await cards.first().getAttribute("data-image-name");
  expect(renderedImage).toMatchObject({ width: 1080, height: 1440, signature: [137, 80, 78, 71, 13, 10, 26, 10] });
  expect(renderedImage.size).toBeGreaterThan(10_000);
  expect(await savedDraftSummary(page), "Merely opening the dialog or generating images must not save a platform draft").toBeNull();

  await dialog.getByLabel("小红书标题", { exact: true }).fill("小红书的独立标题");
  await dialog.getByLabel("小红书文案", { exact: true }).fill("只属于小红书的配文。");
  await choosePlatform(dialog, "wechat");
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("公众号的独立标题");
  await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("只属于公众号的配文。");
  await uploadDraftFile(page, dialog.getByRole("button", { name: "＋ 添加图片", exact: true }), "extra-a.png", makePng(180, 20, 90));
  await expect(cards).toHaveCount(initialCount + 1);
  await uploadDraftFile(page, dialog.getByRole("button", { name: "＋ 添加图片", exact: true }), "extra-b.png", makePng(20, 180, 90));
  await expect(cards).toHaveCount(initialCount + 2);
  await cards.filter({ has: page.locator('[title="extra-b.png"]') }).getByRole("button", { name: /^前移/ }).click();
  await expect(cards.nth(initialCount - 1)).toHaveAttribute("data-image-name", "extra-b.png");
  await uploadDraftFile(page, cards.filter({ has: page.locator('[title="extra-a.png"]') }).getByRole("button", { name: /^替换/ }), "replacement.png", makePng(20, 90, 180));
  await expect(cards.nth(initialCount)).toHaveAttribute("data-image-name", "replacement.png");
  await cards.nth(initialCount - 1).getByRole("button", { name: /^删除/ }).click();
  await expect(cards).toHaveCount(initialCount + 1);
  const names = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-image-name")));
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.getByText("图片、独立文案和核对记录已存到当前浏览器", { exact: true })).toBeVisible();
  const saved = await savedDraftSummary(page);
  expect(saved?.content).toEqual({
    xiaohongshu: { title: "小红书的独立标题", body: "只属于小红书的配文。" },
    wechat: { title: "公众号的独立标题", body: "只属于公众号的配文。" },
  });
  expect(saved?.images.map((image) => image.name)).toEqual(names);
  expect(saved?.images.find((image) => image.name === originalName)).toMatchObject({ width: 1080, height: 1440, size: renderedImage.size, signature: renderedImage.signature });
  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "同步草稿", exact: true })).toBeFocused();

  await page.reload();
  dialog = await openDraftDialog(page);
  await expect(dialog.getByRole("button", { name: "继续本机存档", exact: true })).toBeVisible();
  await expect(dialog.locator(".draft-sync-image-card")).toHaveCount(0);
  await dialog.getByRole("button", { name: "继续本机存档", exact: true }).click();
  await expect(dialog.getByLabel("小红书标题", { exact: true })).toHaveValue("小红书的独立标题");
  await choosePlatform(dialog, "wechat");
  await expect(dialog.getByLabel("公众号贴图文案", { exact: true })).toHaveValue("只属于公众号的配文。");
  await waitAdaptedImages(dialog);
  expect(await sourceCards(dialog).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-image-name")))).toEqual(names);
  await dialog.getByRole("button", { name: "删除本机存档", exact: true }).click();
  await expect(dialog.getByText("本机存档已删除。当前窗口中的编辑仍可继续", { exact: true })).toBeVisible();
  expect(await savedDraftSummary(page)).toBeNull();
  await expect(sourceCards(dialog)).toHaveCount(initialCount + 1);
});

test("risk confirmation regenerates only the existing last page, preserving body decoration and independent platform approval", async ({ page }) => {
  test.setTimeout(240_000);
  const title = "末页正文与风险提示同页";
  const html = `<h1>${title}</h1><p>第一张正文原样保留。</p><div class="manual-page-break">— 手动分页 —</div><h2>末页正文标题</h2><p>这段正文必须保留，<strong>重点粗体</strong>和<span style="color:#2457a7">蓝色文字</span>不能丢失。</p><p>正文结束以后，才显示这个平台的风险提示。</p>`;
  await importRichArticle(page, html, title + "第一张正文原样保留。— 手动分页 —末页正文标题这段正文必须保留，重点粗体和蓝色文字不能丢失。正文结束以后，才显示这个平台的风险提示。");
  await expectPreviewReady(page);
  const originalPageCount = await page.locator(".poster-grid .content-page").count();
  expect(originalPageCount).toBe(2);
  const bodyBottomRatio = await page.locator(".poster-grid .content-page").last().evaluate((poster) => {
    const pageBox = poster.getBoundingClientRect(), riskBox = poster.querySelector(".risk-note")!.getBoundingClientRect();
    return (riskBox.top - pageBox.top) / pageBox.height - 0.01;
  });
  const dialog = await openDraftDialog(page);
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(sourceCards(dialog)).toHaveCount(originalPageCount, { timeout: 110_000 });
  await waitAdaptedImages(dialog);
  await page.evaluate(() => {
    const audit = { renders: 0 };
    Object.assign(window, { riskRenderAudit: audit });
    new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLIFrameElement && node.hasAttribute("sandbox")) audit.renders++; }).observe(document.body, { childList: true });
  });
  const renderCount = () => page.evaluate(() => (window as unknown as { riskRenderAudit: { renders: number } }).riskRenderAudit.renders);
  const confirmedByPlatform = new Map<string, Awaited<ReturnType<typeof imageManifest>>>();
  for (const platform of ["xiaohongshu", "wechat"] as const) {
    await choosePlatform(dialog, platform);
    const label = platform === "wechat" ? "公众号贴图" : "小红书";
    const approval = dialog.getByLabel(`我已确认${label}的风险提示`, { exact: true });
    await expect(approval).not.toBeChecked();
    const before = await imageManifest(dialog), bodyHash = await lastPageBodyHash(dialog, bodyBottomRatio);
    const beforePixels = await riskCard(dialog).locator("img").evaluate(async (node) => Array.from(new Uint8Array(await (await fetch((node as HTMLImageElement).src)).arrayBuffer())));
    const rendersBefore = await renderCount();
    await dialog.getByLabel("风险提示标题", { exact: true }).fill(`${label}风险提示`);
    await dialog.getByLabel("风险提示内容", { exact: true }).fill(`${label}内容仅供参考。\n\n保留独立判断，不构成投资建议。`);
    expect(await imageManifest(dialog)).toEqual(before);
    expect(await renderCount(), "typing must not regenerate the last page before approval").toBe(rendersBefore);
    await confirmRisk(dialog, platform);
    const confirmed = await imageManifest(dialog);
    expect(await renderCount()).toBe(rendersBefore + 1);
    expect(confirmed).toHaveLength(originalPageCount);
    expect(confirmed.map((image) => image.name)).toEqual(before.map((image) => image.name));
    expect(confirmed.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(confirmed.at(-1)?.hash).not.toBe(before.at(-1)?.hash);
    const afterBodyHash = await lastPageBodyHash(dialog, bodyBottomRatio);
    if (afterBodyHash !== bodyHash) {
      const afterPixels = await riskCard(dialog).locator("img").evaluate(async (node) => Array.from(new Uint8Array(await (await fetch((node as HTMLImageElement).src)).arrayBuffer())));
      await test.info().attach(`${platform}-before-risk`, { body: Buffer.from(beforePixels), contentType: "image/png" });
      await test.info().attach(`${platform}-after-risk`, { body: Buffer.from(afterPixels), contentType: "image/png" });
      const difference = await riskCard(dialog).locator("img").evaluate(async (node, { bytes, ratio }) => {
        const image = node as HTMLImageElement, canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = Math.floor(image.naturalHeight * ratio);
        const context = canvas.getContext("2d")!, old = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        context.drawImage(old, 0, 0); const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
        context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0); const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let changed = 0, maximum = 0, total = 0; const rows = new Map<number, number>();
        for (let pixel = 0; pixel < before.length; pixel += 4) {
          const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(before[pixel + channel] - after[pixel + channel])));
          if (delta) { changed++; maximum = Math.max(maximum, delta); total += delta; const y = Math.floor(pixel / 4 / canvas.width); rows.set(y, (rows.get(y) || 0) + 1); }
        }
        old.close(); return { width: canvas.width, height: canvas.height, changed, maximum, meanDelta: changed ? total / changed : 0, rows: [...rows] };
      }, { bytes: beforePixels, ratio: bodyBottomRatio });
      console.info("Risk body pixel difference", JSON.stringify(difference));
    }
    expect(afterBodyHash, "the original header, body and decorations must retain their painted pixels").toBe(bodyHash);
    confirmedByPlatform.set(platform, confirmed);
    await saveSamePageProof(page, dialog, platform);
  }
  await choosePlatform(dialog, "xiaohongshu");
  await expect(dialog.getByLabel("我已确认小红书的风险提示", { exact: true })).toBeChecked();
  expect(await imageManifest(dialog)).toEqual(confirmedByPlatform.get("xiaohongshu"));
  await dialog.getByLabel("在末页显示风险提示", { exact: true }).uncheck();
  await expect(dialog.getByLabel(/^我已确认小红书的风险提示/)).not.toBeChecked();
  await confirmRisk(dialog, "xiaohongshu");
  const withoutRisk = await imageManifest(dialog);
  expect(withoutRisk).toHaveLength(originalPageCount);
  expect(withoutRisk.slice(0, -1)).toEqual(confirmedByPlatform.get("xiaohongshu")!.slice(0, -1));
  expect(withoutRisk.at(-1)?.hash).not.toBe(confirmedByPlatform.get("xiaohongshu")!.at(-1)?.hash);
  await choosePlatform(dialog, "wechat");
  await expect(dialog.getByLabel("我已确认公众号贴图的风险提示", { exact: true })).toBeChecked();
  expect(await imageManifest(dialog)).toEqual(confirmedByPlatform.get("wechat"));
});

test("mobile draft controls stay usable and a denied local save never reports success", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await prepareRealImages(page);
  const geometry = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const footer = element.querySelector(".draft-sync-footer")!.getBoundingClientRect();
    return { left: box.left, right: box.right, bottom: box.bottom, footerBottom: footer.bottom, width: innerWidth, height: innerHeight, overflow: element.scrollWidth - element.clientWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  const clippedControls = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("button,input,textarea,summary")].filter((node) => {
      if (!node.getClientRects().length) return false;
      const box = node.getBoundingClientRect();
      return box.left < bounds.left - 1 || box.right > bounds.right + 1;
    }).map((node) => node.getAttribute("aria-label") || node.textContent);
  });
  expect(clippedControls, "Narrow-screen controls must remain inside the dialog").toEqual([]);
  await dialog.getByRole("button", { name: "关闭草稿同步", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // Native dialogs may move focus to browser chrome at a tab boundary (W3C
  // H102). The page behind the modal must remain inert, and Tab must return.
  const boundaryFocus = await dialog.evaluate((element) => {
    const active = document.activeElement;
    return {
      modal: element.matches(":modal"),
      backgroundFocused: Boolean(active && active !== document.body && active !== document.documentElement && !element.contains(active)),
      activeTag: active?.tagName,
    };
  });
  expect(boundaryFocus).toMatchObject({ modal: true, backgroundFocused: false });
  const backgroundTrigger = page.locator(".draft-sync-trigger");
  await backgroundTrigger.evaluate((button) => (button as HTMLButtonElement).focus());
  await expect(backgroundTrigger).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.evaluate(() => {
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name: string, version?: number) {
      if (name === "zhepage-local-draft-sync") throw new DOMException("Test storage denied", "SecurityError");
      return originalOpen.call(this, name, version);
    };
  });
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("Test storage denied");
  await expect(dialog.getByText("图片、独立文案和核对记录已存到当前浏览器", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible();
  await dialog.press("Escape");
  await expect(page.getByRole("button", { name: "同步草稿", exact: true })).toBeFocused();
});

test("WeChat local accounts batch real PNG drafts and require explicit publication confirmation", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit blocks HTTPS to HTTP loopback; sync is supported in Chrome/Firefox and its Safari guidance is tested separately.");
  test.setTimeout(240_000);
  const requests: string[] = [];
  const accounts = [1, 2].map((number) => { const appId = `wx-browser-account-${number}`; return { appId, id: createHash("sha256").update(appId).digest("hex").slice(0, 20), name: `贴图测试公众号${number}`, appSecret: `browser-private-secret-${number}` }; });
  const jobs = new Map<string, Record<string, unknown>>();
  const publications = new Map<string, Record<string, unknown>>();
  const uploads: { id: string; accountId: string; title: string; body: string; images: { name: string; size: number; signature: number[]; hash: string; width: number; height: number }[] }[] = [];
  let confirmedImages: Awaited<ReturnType<typeof imageManifest>> = [];
  const server = await startWechatTestServer(new URL(page.url()).origin, async (request, response) => {
    const path = new URL(request.url!, "http://test.local").pathname;
    const reply = (status: number, json: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(json)); };
    requests.push(`${request.method} ${path}`);
    expect(request.headers.authorization).toBe("Bearer browser-test-password-0123456789abcdef");
    if (path === "/api/wechat/connection") { reply(200, { deviceId: "11111111111111111111111111111111" }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (path === "/api/wechat/accounts/connect") {
      const body = JSON.parse(bytes.toString("utf8"));
      const account = accounts.find((item) => item.appId === body.appId)!;
      expect(body).toEqual({ deviceId: "11111111111111111111111111111111", appId: account.appId, appSecret: account.appSecret, name: account.name });
      reply(200, { account: { id: account.id, name: account.name } }); return;
    }
    const scoped = /^\/api\/wechat\/accounts\/([a-f0-9]{20})\/jobs(?:\/([a-f0-9-]+))?(.*)$/.exec(path)!;
    expect(scoped).not.toBeNull();
    const [, accountId, jobId, suffix] = scoped;
    const account = accounts.find((item) => item.id === accountId)!;
    if (suffix === "/publication") {
      if (request.method === "POST") {
        expect(JSON.parse(bytes.toString("utf8"))).toEqual({ confirm: true });
        expect(publications.has(jobId)).toBe(false);
        expect((await savedDraftSummary(page))?.receipts).toContainEqual(expect.objectContaining({ accountId, jobId, publicationAttempted: true }));
        publications.set(jobId, { jobId, status: "published", publishId: `publish-${jobId}`, articleId: `article-${jobId}`, urls: ["https://mp.weixin.qq.com/s/mock-article"], message: "模拟微信发表完成", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" });
      }
      reply(200, { publication: publications.get(jobId) || null }); return;
    }
    if (jobId) { expect(jobs.get(jobId)?.accountId).toBe(accountId); reply(200, { job: jobs.get(jobId) }); return; }
    expect(request.method).toBe("POST");
    const form = await new Response(new Uint8Array(bytes), { headers: { "content-type": request.headers["content-type"]! } }).formData();
    expect(form.get("expectedAccountId")).toBe(accountId);
    const images = await Promise.all(form.getAll("images").map(async (value) => { const file = value as File, bytes = Buffer.from(await file.arrayBuffer()); return { name: file.name, size: file.size, signature: Array.from(bytes.subarray(0, 8)), hash: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }));
    expect(images).toEqual(confirmedImages);
    const upload = { id: String(form.get("id")), accountId, title: String(form.get("title")), body: String(form.get("body")), images };
    uploads.push(upload);
    const stored = await savedDraftSummary(page);
    expect(stored?.receipts).toContainEqual(expect.objectContaining({ accountId, jobId: upload.id, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), status: "needs_confirmation" }));
    expect(stored?.images).toHaveLength(images.length);
    expect(stored?.images.every((image) => !image.name.endsWith("-风险提示.png"))).toBe(true);
    expect(stored?.images[0]).toMatchObject({ width: 1080, height: 1440 });
    expect(stored?.content.wechat.body).toBe("多张海报完整同步。\n\n这一行也保留。\n");
    const job = { id: upload.id, accountId, accountName: account.name, title: upload.title, imageCount: images.length, uploadedCount: images.length, status: "saved", message: "模拟官方草稿读回核对通过", draftId: `mock-draft-${accountId}`, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" };
    jobs.set(upload.id, job); reply(202, { job });
  }, { connectionToken: "browser-test-password-0123456789abcdef", deviceId: "11111111111111111111111111111111" });
  try {
    await server.mount(page);
    await page.goto(server.origin);
    let dialog = await prepareRealImages(page);
    await choosePlatform(dialog, "wechat");
    await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("这是一个超过二十个字符需要用户缩短的公众号贴图标题");
    await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("多张海报完整同步。\n\n这一行也保留。\n");
    await expect(dialog.getByLabel("公众号贴图标题", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#draft-title-help")).toContainText("标题超出");
    await expect(dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true })).toHaveCount(0);
    // The step navigation can reach accounts before content is ready. The
    // action area must explain every content blocker and let users resolve it.
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    expect(requests).toEqual([]);
    await expect(dialog.getByRole("button", { name: "连接这台电脑", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "同步到草稿箱", exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("本机连接口令", { exact: true })).toHaveCount(0);
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await dialog.locator(".draft-sync-connection").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/wechat-first-connection-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1110, height: 770 });
    expect(requests).toEqual([]);
    await connectLocalDevice(page, dialog);
    expect(requests).toEqual(["GET /api/wechat/connection"]);
    for (const account of accounts) {
      const settings = dialog.locator(".draft-sync-wechat-settings");
      if (!(await settings.evaluate((element) => (element as HTMLDetailsElement).open))) await settings.locator(":scope > summary").click();
      await dialog.getByLabel("公众号名称", { exact: true }).fill(account.name);
      await dialog.getByLabel("AppID", { exact: true }).fill(account.appId);
      await dialog.getByLabel("AppSecret", { exact: true }).fill(account.appSecret);
      await dialog.getByRole("button", { name: "保存并连接公众号", exact: true }).click();
      await expect(dialog.getByRole("article", { name: `${account.name} 的结果` })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "同步到草稿箱", exact: true })).toBeDisabled();
    }
    expect(uploads).toHaveLength(0);
    const callsBeforeSwitch = requests.length;
    await choosePlatform(dialog, "xiaohongshu");
    await expect(dialog.getByLabel("小红书标题", { exact: true })).toHaveAttribute("aria-invalid", "false");
    await expect(dialog.locator("#draft-title-help")).not.toContainText("标题超出");
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    await expect(dialog.getByRole("button", { name: "打开登录窗口", exact: true })).toBeEnabled();
    await expect(dialog.locator(".draft-sync-connection")).toContainText("本机连接已保存");
    await expect(dialog.getByRole("button", { name: "连接这台电脑", exact: true })).toBeHidden();
    await choosePlatform(dialog, "wechat");
    expect(requests).toHaveLength(callsBeforeSwitch);
    await expect(dialog.locator(".draft-sync-wechat-account-row")).toHaveCount(2);
    const actions = dialog.getByRole("region", { name: "公众号操作", exact: true });
    await expect(actions.getByRole("region", { name: "同步前检查", exact: true })).toContainText("标题最多 20 个字符");
    await actions.getByRole("button", { name: "查看并确认图片", exact: true }).click();
    await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("真实海报贴图草稿");
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    await dialog.getByLabel("全选", { exact: true }).check();
    await expect(actions.getByRole("button", { name: "同步到草稿箱", exact: true })).toBeDisabled();
    // Results previously hid the validation entirely, leaving both actions
    // permanently disabled with no explanation or way to confirm the images.
    await dialog.locator(".draft-sync-steps button").nth(2).click();
    await expect(actions.getByRole("region", { name: "同步前检查", exact: true })).toBeVisible();
    expect(uploads).toHaveLength(0); expect(publications.size).toBe(0);
    await actions.getByRole("button", { name: "查看并确认图片", exact: true }).click();
    await expect(dialog.getByLabel("我已确认公众号贴图的风险提示", { exact: true })).not.toBeChecked();
    const originalImages = await imageManifest(dialog);
    await confirmRisk(dialog, "wechat");
    confirmedImages = await imageManifest(dialog);
    expect(confirmedImages).toHaveLength(originalImages.length);
    expect(confirmedImages.map((image) => image.name)).toEqual(originalImages.map((image) => image.name));
    expect(confirmedImages.every((image) => image.width === 1080 && image.height === 1350)).toBe(true);
    expect(confirmedImages.slice(0, -1)).toEqual(originalImages.slice(0, -1));
    await expect(riskCard(dialog).getByRole("button")).toHaveCount(0);
    await captureContentStep(page, dialog, "wechat");
    await confirmPlatformImages(dialog, "wechat");
    await expect(actions.getByRole("button", { name: "同步到草稿箱", exact: true })).toBeEnabled();
    await expect(actions.getByRole("button", { name: "立即发布", exact: true })).toBeEnabled();
    expect(uploads).toHaveLength(0); expect(publications.size).toBe(0);
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    // Account checkboxes must never inherit the global full-width text-input rule.
    // Check both the user's laptop size and narrow screens before any upload.
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const settings = dialog.locator(".draft-sync-wechat-settings");
      if (await settings.evaluate((element) => (element as HTMLDetailsElement).open)) await settings.locator(":scope > summary").click();
      const rows = await dialog.locator(".draft-sync-wechat-account-choice").evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect(), checkbox = node.querySelector("input")!.getBoundingClientRect(), name = node.querySelector("strong")!.getBoundingClientRect();
        return { height: box.height, checkboxWidth: checkbox.width, checkboxHeight: checkbox.height, nameWidth: name.width, overflow: node.scrollWidth - node.clientWidth };
      }));
      for (const row of rows) {
        expect(row.height).toBeLessThan(120);
        expect(row.checkboxWidth).toBe(16); expect(row.checkboxHeight).toBe(16);
        expect(row.nameWidth).toBeGreaterThan(150); expect(row.overflow).toBeLessThanOrEqual(1);
      }
      await dialog.locator(".draft-sync-wechat-targets").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/wechat-accounts-${viewport.width}.png` });
      await dialog.locator(".draft-sync-wechat-actions").scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "立即发布", exact: true })).toBeInViewport();
      await page.screenshot({ path: `test-results/wechat-actions-${viewport.width}.png` });
      const clipped = await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("button,input,summary")].filter((node) => {
          if (!node.getClientRects().length) return false;
          const box = node.getBoundingClientRect();
          return box.left < bounds.left - 1 || box.right > bounds.right + 1;
        }).map((node) => node.textContent || node.id);
      });
      expect(clipped).toEqual([]);
    }
    await page.setViewportSize({ width: 1110, height: 770 });
    await dialog.getByLabel("全选", { exact: true }).check();
    await dialog.getByRole("button", { name: "同步到草稿箱", exact: true }).click();
    await expect.poll(() => server.failure() || uploads.length).toBe(2);
    expect(server.failure()).toBeUndefined();
    await expect(dialog.getByText("草稿已保存", { exact: true })).toHaveCount(2);
    for (const upload of uploads) {
      expect(upload).toMatchObject({ title: "真实海报贴图草稿", body: "多张海报完整同步。\r\n\r\n这一行也保留。\r\n" });
      expect(upload.images.length).toBeGreaterThan(0);
      for (const image of upload.images) { expect(image.size).toBeGreaterThan(0); expect(image.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect([image.width, image.height]).toEqual([1080, 1350]); }
    }
    expect((await savedDraftSummary(page))?.receipts).toHaveLength(2);
    const protectedVault = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("zhepage-wechat-device-vault", 1); request.onsuccess = () => resolve(request.result); });
      try {
        const records = await new Promise<Record<string, unknown>[]>((resolve) => { const transaction = db.transaction("records", "readonly"), request = transaction.objectStore("records").getAll(); transaction.oncomplete = () => resolve(request.result); });
        const key = records.find((record) => record.key === "encryption-key")!.value as CryptoKey;
        let blocked = false; try { await crypto.subtle.exportKey("raw", key); } catch { blocked = true; }
        return { serialized: JSON.stringify(records), extractable: key.extractable, blocked };
      } finally { db.close(); }
    });
    expect(protectedVault).toMatchObject({ extractable: false, blocked: true });
    expect(protectedVault.serialized).not.toContain("browser-private-secret");
    expect(protectedVault.serialized).not.toContain("browser-test-password-0123456789abcdef");
    await dialog.getByRole("button", { name: "立即发布", exact: true }).click();
    const confirmation = dialog.getByRole("region", { name: "确认立即发布", exact: true });
    await expect(confirmation).toBeFocused();
    await expect(confirmation).toContainText("真实海报贴图草稿");
    await expect(confirmation).toContainText(accounts[0].name); await expect(confirmation).toContainText(accounts[1].name);
    expect(publications.size).toBe(0);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    expect(publications.size).toBe(0);
    await dialog.getByRole("button", { name: "立即发布", exact: true }).click();
    await dialog.getByRole("button", { name: "确认立即发布", exact: true }).click();
    await expect.poll(() => server.failure() || publications.size).toBe(2);
    await expect(dialog.getByText("已发表", { exact: true })).toHaveCount(2);
    expect(uploads).toHaveLength(2);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll(".draft-sync-wechat button,.draft-sync-wechat input")].filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1); }).map((node) => node.textContent || node.id);
    })).toEqual([]);
    const callsBeforeReload = requests.length;
    await page.reload(); dialog = await openDraftDialog(page);
    await dialog.getByRole("button", { name: "继续本机存档", exact: true }).click(); await choosePlatform(dialog, "wechat");
    await confirmPlatformImages(dialog, "wechat");
    await expect(dialog.getByRole("article", { name: `${accounts[0].name} 的结果` })).toBeVisible();
    expect(requests).toHaveLength(callsBeforeReload);
    await dialog.getByRole("button", { name: `刷新 ${accounts[0].name} 状态`, exact: true }).click();
    await expect(dialog.getByRole("article", { name: `${accounts[0].name} 的结果` })).toContainText("已发表");
    expect(publications.size).toBe(2); expect(uploads).toHaveLength(2); expect(server.failure()).toBeUndefined();
    await dialog.locator(".draft-sync-steps button").first().click();
    await choosePlatform(dialog, "xiaohongshu");
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    await expect(dialog.getByRole("button", { name: "打开登录窗口", exact: true })).toBeEnabled();
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await dialog.locator(".draft-sync-xhs").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/xiaohongshu-panel-${viewport.width}.png` });
      expect(await dialog.locator(".draft-sync-xhs").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }

  } finally { await server.close(); }
});

test("a fresh browser connects once and saves the confirmed XHS preview with risk on its existing last page", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit blocks HTTPS to HTTP loopback; sync is supported in Chrome/Firefox and its Safari guidance is tested separately.");
  test.setTimeout(240_000);
  const connectionToken = "xhs-browser-private-connection-token", deviceId = "22222222222222222222222222222222";
  const account = { id: "0123456789abcdefabcd", name: "小红书测试账号" };
  const requests: { method: string; path: string; body: string }[] = [];
  const originals: { name: string; size: number; hash: string; width: number; height: number; signature: number[] }[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  let loginOpened = false, createCount = 0;
  const server = await startWechatTestServer(new URL(page.url()).origin, async (request, response) => {
    const path = new URL(request.url!, "http://test.local").pathname;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    requests.push({ method: request.method!, path, body: bytes.toString("utf8") });
    expect(request.headers.authorization).toBe(`Bearer ${connectionToken}`);
    expect(request.url).not.toContain(connectionToken);
    expect(bytes.toString("utf8")).not.toContain(connectionToken);
    const reply = (status: number, json: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(json)); };
    if (path === "/api/wechat/connection") { reply(200, { deviceId }); return; }
    if (path === "/api/xiaohongshu/login") { expect(request.method).toBe("POST"); loginOpened = true; reply(200, {}); return; }
    if (path === "/api/xiaohongshu/account") { expect(loginOpened).toBe(true); reply(200, { account }); return; }
    if (path === "/api/xiaohongshu/jobs") {
      expect(request.method).toBe("POST"); createCount++;
      const form = await new Response(new Uint8Array(bytes), { headers: { "content-type": request.headers["content-type"]! } }).formData();
      expect(form.get("expectedAccountId")).toBe(account.id);
      expect(form.get("title")).toBe("小红书独立贴图");
      expect(form.get("body")).toBe("保留全部海报。\r\n第二行也保留。");
      const images = await Promise.all(form.getAll("images").map(async (value) => {
        const file = value as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        return { name: file.name, size: file.size, hash: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), signature: Array.from(bytes.subarray(0, 8)) };
      }));
      expect(images).toEqual(originals);
      const id = String(form.get("id"));
      expect((await savedDraftSummary(page))?.receipts).toContainEqual(expect.objectContaining({ accountId: account.id, jobId: id, status: "needs_confirmation" }));
      const job = { id, accountId: account.id, accountName: account.name, title: "小红书独立贴图", imageCount: images.length, uploadedCount: images.length,
        status: "saved", draftId: "mock-xhs-draft", message: "模拟小红书草稿回读通过" };
      jobs.set(id, job); reply(202, { job }); return;
    }
    const read = /^\/api\/xiaohongshu\/jobs\/([a-f0-9-]+)$/.exec(path);
    if (read && request.method === "GET") { expect(jobs.has(read[1])).toBe(true); reply(200, { job: jobs.get(read[1]) }); return; }
    throw new Error(`Unexpected platform request: ${request.method} ${path}`);
  }, { connectionToken, deviceId });
  try {
    await server.mount(page);
    await page.goto(server.origin);
    let dialog = await prepareRealImages(page);
    await dialog.getByLabel("小红书标题", { exact: true }).fill("小红书独立贴图");
    await dialog.getByLabel("小红书文案", { exact: true }).fill("保留全部海报。\n第二行也保留。");
    const secondPoster = Buffer.from(await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1440;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#e7f2f1"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#243f3b"; context.font = "bold 80px sans-serif";
      context.fillText("原图顺序验证 02", 90, 240);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }));
    await uploadDraftFile(page, dialog.getByRole("button", { name: "＋ 添加图片", exact: true }), "xhs-extra.png", secondPoster);
    await uploadDraftFile(page, dialog.getByRole("button", { name: "＋ 添加图片", exact: true }), "xhs-extra-b.png", makePng(50, 160, 120));
    await dialog.getByRole("button", { name: "前移第 2 张图片", exact: true }).click();
    await waitAdaptedImages(dialog);
    const beforeRisk = await imageManifest(dialog);
    await confirmRisk(dialog, "xiaohongshu");
    await dialog.getByLabel("风险提示内容", { exact: true }).fill("小红书独立风险提示。\n内容仅供参考，请独立判断。");
    await expect(dialog.getByLabel("我已确认小红书的风险提示", { exact: true })).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: "确认图片，连接小红书", exact: true })).toBeDisabled();
    expect(await imageManifest(dialog), "editing text must only invalidate approval, not render an unconfirmed last page").toEqual(beforeRisk);
    await confirmRisk(dialog, "xiaohongshu");
    originals.push(...await imageManifest(dialog));
    expect(originals).toHaveLength(beforeRisk.length);
    expect(originals.at(-1)?.hash).not.toBe(beforeRisk.at(-1)?.hash);
    expect(originals.slice(0, -1)).toEqual(beforeRisk.slice(0, -1));
    expect(originals.at(-1)?.name).toBe(beforeRisk.at(-1)?.name);
    expect(originals.every((image) => image.width === 1080 && image.height === 1440)).toBe(true);
    await expect(riskCard(dialog).getByRole("button")).toHaveCount(0);
    await captureContentStep(page, dialog, "xiaohongshu");
    expect(originals.length).toBeGreaterThan(1);
    await expect(dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true })).toHaveCount(0);
    await confirmPlatformImages(dialog, "xiaohongshu");
    await expect(dialog.getByRole("button", { name: "打开登录窗口", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true })).toHaveCount(0);
    expect(requests).toEqual([]);
    await captureConnectionSteps(page, dialog, "xiaohongshu-first-connection");
    await connectLocalDevice(page, dialog);
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /api/wechat/connection"]);
    await expect(dialog.getByRole("button", { name: "打开登录窗口", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "我已登录", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "打开登录窗口", exact: true }).click();
    await expect.poll(() => server.failure() || loginOpened).toBe(true);
    await captureConnectionSteps(page, dialog, "xiaohongshu-login");
    await dialog.getByRole("button", { name: "我已登录", exact: true }).click();
    await expect(dialog.getByText(account.name, { exact: true })).toBeVisible();
    await captureConnectionSteps(page, dialog, "xiaohongshu-account-ready");
    await dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "小红书同步结果", exact: true })).toContainText("模拟小红书草稿回读通过");
    expect(createCount).toBe(1);
    expect((await savedDraftSummary(page))?.receipts).toContainEqual(expect.objectContaining({ accountId: account.id, status: "saved", draftId: "mock-xhs-draft" }));
    await expect(dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true })).toBeDisabled();
    const callsBeforeSwitch = requests.length;
    await choosePlatform(dialog, "wechat");
    await expect(dialog.getByLabel("公众号贴图标题", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("风险提示内容", { exact: true })).not.toHaveValue("小红书独立风险提示。\n内容仅供参考，请独立判断。");
    await expect(dialog.getByLabel("我已确认公众号贴图的风险提示", { exact: true })).not.toBeChecked();
    await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("这是公众号自己的超长标题不得影响小红书同步结果和账号");
    await expect(dialog.locator("#draft-title-help")).toContainText("标题超出");
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    await expect(dialog.getByText("本机连接已保存", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("公众号名称", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "连接这台电脑", exact: true })).toBeHidden();
    expect(requests).toHaveLength(callsBeforeSwitch);
    await choosePlatform(dialog, "xiaohongshu");
    await expect(dialog.getByRole("button", { name: "刷新账号", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("region", { name: "小红书同步结果", exact: true })).toContainText("模拟小红书草稿回读通过");
    await expect(dialog.getByText("标题最多 20 个字符", { exact: false })).toBeHidden();
    expect(requests).toHaveLength(callsBeforeSwitch);
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await dialog.locator(".draft-sync-connection").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/xiaohongshu-shared-connection-${viewport.width}.png` });
      expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    const serialized = JSON.stringify(await savedDraftSummary(page));
    expect(serialized).not.toContain(connectionToken);
    expect(serialized).not.toContain("appSecret");
    expect(requests.some(({ path }) => path.includes("/accounts/") || path.includes("publication"))).toBe(false);
    await page.reload(); dialog = await openDraftDialog(page);
    await dialog.getByRole("button", { name: "继续本机存档", exact: true }).click();
    await expect(dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true })).toHaveCount(0);
    await confirmPlatformImages(dialog, "xiaohongshu");
    await expect(dialog.getByText("本机连接已保存", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "打开登录窗口", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "我已登录", exact: true }).click();
    await dialog.getByRole("button", { name: "读取小红书同步状态", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "小红书同步结果", exact: true })).toContainText("模拟小红书草稿回读通过");
    expect(createCount).toBe(1);
    expect(server.failure()).toBeUndefined();
  } finally { await server.close(); }
});

test("an unavailable helper shows recovery inside the editor without opening a refused localhost page", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "WebKit rejects the transport before it can test an offline helper; Safari guidance has its own case.");
  test.setTimeout(180_000);
  const server = await startWechatTestServer(new URL(page.url()).origin, async () => { throw new Error("A stopped fixture must not receive API work"); },
    { deviceId: "a".repeat(32), connectionToken: "offline-fixture-private-connection-token-".repeat(2) });
  try {
    await server.mount(page); await page.goto(server.origin);
    const dialog = await prepareRealImages(page);
    await confirmPlatformImages(dialog, "xiaohongshu");
    await server.close();
    const pagesBefore = context.pages().length;
    await dialog.getByRole("button", { name: "连接这台电脑", exact: true }).click();
    await expect(dialog.getByRole("alert").first()).toContainText("本机助手");
    await expect(dialog.getByText("本机连接已保存", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "连接这台电脑", exact: true })).toBeEnabled();
    expect(context.pages()).toHaveLength(pagesBefore);
    expect(new URL(page.url()).origin).toBe(server.origin);
    await captureConnectionSteps(page, dialog, "local-assistant-offline");
    expect(server.failure()).toBeUndefined();
  } finally { await server.close(); }
});


test("Safari explains which browser to use immediately without attempting local pairing or opening a window", async ({ page, context, browserName }) => {
  test.skip(browserName !== "webkit", "This case verifies the real WebKit mixed-content boundary and Safari-specific product guidance.");
  const server = await startWechatTestServer(new URL(page.url()).origin, async () => { throw new Error("Unsupported browsers must not start platform API work"); },
    { deviceId: "a".repeat(32), connectionToken: "safari-fixture-private-connection-token-".repeat(2) });
  const localRequests: string[] = [];
  page.on("request", (request) => { if (/^http:\/\/127\.0\.0\.1:878[89]\//.test(request.url())) localRequests.push(request.url()); });
  try {
    await server.mount(page); await page.goto(server.origin);
    const dialog = await prepareRealImages(page);
    await confirmPlatformImages(dialog, "xiaohongshu");
    const pagesBefore = context.pages().length;
    await dialog.getByRole("button", { name: "连接这台电脑", exact: true }).click();
    await expect(dialog.getByRole("alert").first()).toContainText("请使用这台 Mac 上的 Chrome", { timeout: 2_000 });
    await expect(dialog.getByText("本机连接已保存", { exact: true })).toHaveCount(0);
    expect(localRequests).toEqual([]);
    expect(context.pages()).toHaveLength(pagesBefore);
    expect(new URL(page.url()).origin).toBe(server.origin);
    expect(server.failure()).toBeUndefined();
  } finally { await server.close(); }
});
