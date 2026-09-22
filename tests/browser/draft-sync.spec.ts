import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
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

test("WeChat local accounts batch real PNG drafts and require explicit publication confirmation", async ({ page }) => {
  test.setTimeout(240_000);
  const requests: string[] = [];
  const accounts = [1, 2].map((number) => { const appId = `wx-browser-account-${number}`; return { appId, id: createHash("sha256").update(appId).digest("hex").slice(0, 20), name: `贴图测试公众号${number}`, appSecret: `browser-private-secret-${number}` }; });
  const jobs = new Map<string, Record<string, unknown>>();
  const publications = new Map<string, Record<string, unknown>>();
  const uploads: { id: string; accountId: string; title: string; body: string; images: { name: string; size: number; signature: number[] }[] }[] = [];
  const server = await startWechatTestServer(new URL(page.url()).origin, async (request, response) => {
    const path = new URL(request.url!, "http://test.local").pathname;
    const reply = (status: number, json: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(json)); };
    requests.push(`${request.method} ${path}`);
    expect(request.headers.authorization).toBe("Bearer browser-test-password");
    if (path === "/api/wechat/connection") { reply(200, { deviceId: "browser-test-device" }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (path === "/api/wechat/accounts/connect") {
      const body = JSON.parse(bytes.toString("utf8"));
      const account = accounts.find((item) => item.appId === body.appId)!;
      expect(body).toEqual({ deviceId: "browser-test-device", appId: account.appId, appSecret: account.appSecret, name: account.name });
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
    const images = await Promise.all(form.getAll("images").map(async (value) => { const file = value as File; return { name: file.name, size: file.size, signature: Array.from(new Uint8Array(await file.arrayBuffer()).slice(0, 8)) }; }));
    const upload = { id: String(form.get("id")), accountId, title: String(form.get("title")), body: String(form.get("body")), images };
    uploads.push(upload);
    const stored = await savedDraftSummary(page);
    expect(stored?.receipts).toContainEqual(expect.objectContaining({ accountId, jobId: upload.id, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), status: "needs_confirmation" }));
    expect(stored?.images.map((image) => image.size)).toEqual(images.map((image) => image.size));
    expect(stored?.content.wechat.body).toBe("多张海报完整同步。\n\n这一行也保留。\n");
    const job = { id: upload.id, accountId, accountName: account.name, title: upload.title, imageCount: images.length, uploadedCount: images.length, status: "saved", message: "模拟官方草稿读回核对通过", draftId: `mock-draft-${accountId}`, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" };
    jobs.set(upload.id, job); reply(202, { job });
  });
  try {
    await page.goto(server.origin);
    let dialog = await prepareRealImages(page);
    await choosePlatform(dialog, "wechat");
    await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("真实海报贴图草稿");
    await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("多张海报完整同步。\n\n这一行也保留。\n");
    await expect(dialog.locator(".draft-sync-validation li").filter({ hasText: "并非平台强制要求" })).toHaveCount(1);
    await dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true }).check();
    await dialog.getByRole("button", { name: "下一步：选择公众号", exact: true }).click();
    expect(requests).toEqual([]);
    await dialog.getByLabel("本机连接口令", { exact: true }).fill("browser-test-password");
    await dialog.getByRole("button", { name: "连接本机服务", exact: true }).click();
    for (const account of accounts) {
      const settings = dialog.locator(".draft-sync-wechat-settings");
      if (!(await settings.evaluate((element) => (element as HTMLDetailsElement).open))) await settings.locator("summary").click();
      await dialog.getByLabel("公众号名称", { exact: true }).fill(account.name);
      await dialog.getByLabel("AppID", { exact: true }).fill(account.appId);
      await dialog.getByLabel("AppSecret", { exact: true }).fill(account.appSecret);
      await dialog.getByRole("button", { name: "保存并连接公众号", exact: true }).click();
      await expect(dialog.getByRole("article", { name: `${account.name} 的结果` })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "同步到草稿箱", exact: true })).toBeEnabled();
    }
    expect(uploads).toHaveLength(0);
    // Account checkboxes must never inherit the global full-width text-input rule.
    // Check both the user's laptop size and narrow screens before any upload.
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const settings = dialog.locator(".draft-sync-wechat-settings");
      if (await settings.evaluate((element) => (element as HTMLDetailsElement).open)) await settings.locator("summary").click();
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
      for (const image of upload.images) { expect(image.size).toBeGreaterThan(10_000); expect(image.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); }
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
    expect(protectedVault.serialized).not.toContain("browser-test-password");
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
    await dialog.getByLabel("我已核对图片，沿用当前尺寸和比例", { exact: true }).check();
    await dialog.getByRole("button", { name: "下一步：选择公众号", exact: true }).click();
    await expect(dialog.getByRole("article", { name: `${accounts[0].name} 的结果` })).toBeVisible();
    expect(requests).toHaveLength(callsBeforeReload);
    await dialog.getByRole("button", { name: `刷新 ${accounts[0].name} 状态`, exact: true }).click();
    await expect(dialog.getByRole("article", { name: `${accounts[0].name} 的结果` })).toContainText("已发表");
    expect(publications.size).toBe(2); expect(uploads).toHaveLength(2); expect(server.failure()).toBeUndefined();
    await dialog.locator(".draft-sync-steps button").first().click();
    await choosePlatform(dialog, "xiaohongshu");
    await dialog.locator(".draft-sync-steps button").nth(1).click();
    await expect(dialog.getByRole("button", { name: "同步到小红书草稿箱", exact: true })).toBeVisible();
    for (const viewport of [{ width: 1110, height: 770 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await dialog.locator(".draft-sync-xhs").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/xiaohongshu-panel-${viewport.width}.png` });
      expect(await dialog.locator(".draft-sync-xhs").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }

  } finally { await server.close(); }
});
