import { expect, test, type Locator, type Page } from "@playwright/test";
import { makePng, shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewReady, importRichArticle, openWorkbench } from "./helpers";

async function openDraftDialog(page: Page) {
  await page.getByRole("button", { name: "同步草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "同步到平台草稿", exact: true });
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
  await expect.poll(() => dialog.locator(".draft-sync-image-card img").first().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1080);
  return dialog;
}

async function choosePlatform(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await dialog.locator(".draft-sync-platforms").getByRole("button", { name: platform === "wechat" ? /^公众号贴图/ : /^小红书/ }).click();
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
  const cards = dialog.locator(".draft-sync-image-card");
  const initialCount = await cards.count();
  expect(initialCount).toBeGreaterThan(0);
  const renderedImage = await cards.first().locator("img").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    const blob = await (await fetch(image.src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { width: image.naturalWidth, height: image.naturalHeight, size: bytes.length, signature: Array.from(bytes.subarray(0, 8)) };
  });
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
  await expect(cards.nth(initialCount)).toHaveAttribute("data-image-name", "extra-b.png");
  await uploadDraftFile(page, cards.last().getByRole("button", { name: /^替换/ }), "replacement.png", makePng(20, 90, 180));
  await expect(cards.last()).toHaveAttribute("data-image-name", "replacement.png");
  await cards.nth(initialCount).getByRole("button", { name: /^删除/ }).click();
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
  expect(saved?.images[0]).toMatchObject({ width: 1080, height: 1440, size: renderedImage.size, signature: renderedImage.signature });
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
  expect(await dialog.locator(".draft-sync-image-card").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-image-name")))).toEqual(names);
  await dialog.getByRole("button", { name: "删除本机存档", exact: true }).click();
  await expect(dialog.getByText("本机存档已删除。当前窗口中的编辑仍可继续", { exact: true })).toBeVisible();
  expect(await savedDraftSummary(page)).toBeNull();
  await expect(dialog.locator(".draft-sync-image-card")).toHaveCount(initialCount + 1);
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

test("WeChat official draft flow uploads complete generated PNGs only after account confirmation", async ({ page }) => {
  test.setTimeout(180_000);
  const requests: string[] = [];
  let upload: { id: string; title: string; body: string; images: { name: string; size: number; signature: number[] }[] } | null = null;
  await page.route("**/api/wechat/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    expect(request.headers().authorization).toBe("Bearer browser-test-password");
    if (path === "/api/wechat/account") {
      await route.fulfill({ json: { account: { id: "browser-test-account", name: "贴图测试公众号" } } });
      return;
    }
    expect(path).toBe("/api/wechat/jobs"); expect(request.method()).toBe("POST");
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "content-type": request.headers()["content-type"] } }).formData();
    expect(form.get("expectedAccountId")).toBe("browser-test-account");
    const images = await Promise.all(form.getAll("images").map(async (value) => {
      const file = value as File;
      return { name: file.name, size: file.size, signature: Array.from(new Uint8Array(await file.arrayBuffer()).slice(0, 8)) };
    }));
    upload = { id: String(form.get("id")), title: String(form.get("title")), body: String(form.get("body")), images };
    const stored = await savedDraftSummary(page);
    expect(stored?.receipts).toContainEqual(expect.objectContaining({ accountId: "browser-test-account", jobId: upload.id, status: "needs_confirmation" }));
    expect(stored?.images.map((image) => image.size)).toEqual(images.map((image) => image.size));
    await route.fulfill({ status: 202, json: { job: { id: upload.id, accountId: "browser-test-account", accountName: "贴图测试公众号", title: upload.title, imageCount: images.length, uploadedCount: images.length, status: "saved", message: "模拟官方草稿读回核对通过", draftId: "mock-wechat-draft", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" } } });
  });
  const dialog = await prepareRealImages(page);
  await choosePlatform(dialog, "wechat");
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("真实海报贴图草稿");
  await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("多张海报完整同步。\n这一行也保留。");
  await dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true }).check();
  await dialog.getByRole("button", { name: "下一步：连接公众号", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "打开 Tampermonkey 商店", exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
  await dialog.getByLabel("公众号连接口令", { exact: true }).fill("browser-test-password");
  expect(requests).toEqual([]);
  await dialog.getByRole("button", { name: "检查公众号连接", exact: true }).click();
  await expect(dialog.locator(".draft-sync-wechat-account")).toContainText("贴图测试公众号");
  await dialog.getByRole("button", { name: "同步到公众号草稿箱", exact: true }).click();
  await expect(dialog.getByText("接口已核对，图片显示待人工检查", { exact: true })).toBeVisible();
  expect(requests).toEqual(["GET /api/wechat/account", "POST /api/wechat/jobs"]);
  expect(upload).toMatchObject({ title: "真实海报贴图草稿", body: "多张海报完整同步。\n这一行也保留。" });
  const received = upload as unknown as { images: { size: number; signature: number[] }[] };
  expect(received.images.length).toBeGreaterThan(0);
  for (const image of received.images) { expect(image.size).toBeGreaterThan(10_000); expect(image.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); }
  expect(JSON.stringify(await savedDraftSummary(page))).not.toContain("browser-test-password");
  await page.setViewportSize({ width: 390, height: 844 });
  const clipped = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll(".draft-sync-wechat button,.draft-sync-wechat input")].filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
    }).map((node) => node.textContent || node.id);
  });
  expect(clipped).toEqual([]);
  await dialog.getByRole("button", { name: "已在公众号草稿箱核对，图片显示正常", exact: true }).click();
  await expect(dialog.getByText("用户已确认图片正常", { exact: true })).toBeVisible();
});
