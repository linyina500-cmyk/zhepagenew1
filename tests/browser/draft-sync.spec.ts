import { expect, test, type Locator, type Page } from "@playwright/test";
import { makePng, shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewReady, importRichArticle, openWorkbench } from "./helpers";

type SubmittedImage = { name: string; mime: string; width: number; height: number; base64: string };
type SubmittedJob = { requestId: string; accountId: string; content: { title: string; body: string }; images: SubmittedImage[] };

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
  await dialog.getByRole("button", { name: "用当前图片新建草稿", exact: true }).click();
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

test.beforeEach(async ({ page }) => { await openWorkbench(page); });

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
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
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

test("size acknowledgement and per-account receipts govern real PNG submissions and uncertain retries", async ({ page }) => {
  test.setTimeout(240_000);
  const jobs: SubmittedJob[] = [];
  const acknowledgements: unknown[] = [];
  let releaseFirstJob!: () => void;
  const firstJobResponse = new Promise<void>((resolve) => { releaseFirstJob = resolve; });
  let releaseFirstAcknowledgement!: () => void;
  const firstAcknowledgementResponse = new Promise<void>((resolve) => { releaseFirstAcknowledgement = resolve; });
  let wechatBlocked = false;
  await page.route("http://127.0.0.1:47831/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    const respond = (json: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(json) });
    if (request.method() === "OPTIONS") return respond({});
    expect(request.headers().authorization).toBe("Bearer test-local-pairing");
    if (path === "/api/accounts") return respond({ accounts: [
      { id: "xhs-test", platform: "xiaohongshu", displayName: "小红书测试账号", remoteId: "xhs-identity", ready: true },
      { id: "wechat-test", platform: "wechat", displayName: "公众号测试账号", remoteId: "wechat-identity", ready: true, syncBlocked: wechatBlocked },
    ] });
    if (path === "/api/jobs/acknowledge") {
      acknowledgements.push(request.postDataJSON());
      if (acknowledgements.length === 1) await firstAcknowledgementResponse;
      wechatBlocked = false;
      return respond({ ok: true });
    }
    if (path === "/api/jobs") {
      jobs.push(request.postDataJSON() as SubmittedJob);
      if (jobs.length === 1) await firstJobResponse;
      return respond({ state: "queued" });
    }
    const job = jobs.find((item) => path === `/api/jobs/${item.requestId}`);
    if (!job) throw new Error(`Unexpected companion request: ${path}`);
    if (job.accountId === "wechat-test") wechatBlocked = true;
    return respond({ state: "completed", receipt: job.accountId === "xhs-test"
      ? { accountId: job.accountId, platform: "xiaohongshu", status: "saved", draftId: "verified-xhs-draft", message: "测试助手已读取并核对草稿" }
      : jobs.indexOf(job) === 2
        ? { accountId: job.accountId, platform: "unknown-platform", status: "saved", draftId: "mismatched-draft", message: "畸形响应不能当作保存成功" }
        : { accountId: job.accountId, platform: "wechat", status: "needs_confirmation", message: "平台保存结果待核实，请先检查草稿" },
    });
  });
  const dialog = await prepareRealImages(page);
  await dialog.getByLabel("本机助手配对码", { exact: true }).fill("test-local-pairing");
  await dialog.getByRole("button", { name: "连接助手", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /小红书测试账号/ })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /小红书测试账号/ }).check();
  await dialog.getByLabel("小红书标题", { exact: true }).fill("小红书同步标题");
  await dialog.getByLabel("小红书文案", { exact: true }).fill("小红书同步配文");
  await choosePlatform(dialog, "wechat");
  await dialog.getByRole("checkbox", { name: /公众号测试账号/ }).check();
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("公众号同步标题");
  await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("公众号同步配文");
  const submit = dialog.locator(".draft-sync-footer-actions .primary");
  await expect(submit).toHaveText("同步到 2 个账号草稿");
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("region", { name: "同步前检查" })).toContainText("不是平台强制尺寸");
  expect(jobs).toHaveLength(0);
  await dialog.getByRole("checkbox", { name: "我已核对图片，沿用当前尺寸和比例", exact: true }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  try {
    await expect.poll(() => jobs.length).toBe(1);
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "关闭草稿同步", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "返回工作台调整海报尺寸", exact: true })).toBeDisabled();
    await dialog.press("Escape");
    await expect(dialog).toBeVisible();
    await submit.evaluate((button) => (button as HTMLButtonElement).click());
    expect(jobs).toHaveLength(1);
  } finally { releaseFirstJob(); }
  await expect(dialog.getByText("已保存平台草稿", { exact: true })).toBeVisible();
  await expect(dialog.getByText("待核实", { exact: true })).toBeVisible();
  await expect(dialog.locator(".draft-sync-footer-status")).toContainText("所选账号已处理");
  expect(jobs.map((job) => job.accountId)).toEqual(["xhs-test", "wechat-test"]);
  expect(jobs.map((job) => job.content)).toEqual([
    { title: "小红书同步标题", body: "小红书同步配文" },
    { title: "公众号同步标题", body: "公众号同步配文" },
  ]);
  for (const job of jobs) {
    const png = Buffer.from(job.images[0].base64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1440);
    expect(png.length).toBeGreaterThan(10_000);
  }
  expect(jobs[0].images).toEqual(jobs[1].images);
  await expect(submit).toHaveText("同步到 1 个账号草稿");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "刷新账号", exact: true }).click();
  await expect(submit).toBeDisabled();
  const wechatReceipt = dialog.getByRole("article", { name: "公众号测试账号的同步结果", exact: true });
  await wechatReceipt.getByRole("button", { name: "已在平台核对，确认已保存", exact: true }).click();
  try {
    await expect.poll(() => acknowledgements.length).toBe(1);
    await expect(wechatReceipt.getByRole("button", { name: "已在平台核对，确认未保存", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "关闭草稿同步", exact: true })).toBeDisabled();
    await dialog.press("Escape");
    await expect(dialog).toBeVisible();
  } finally { releaseFirstAcknowledgement(); }
  await expect(wechatReceipt.getByText("用户确认已保存", { exact: true })).toBeVisible();
  await expect(wechatReceipt).toContainText("本机助手未自动验证");
  await expect(wechatReceipt).toHaveClass(/confirmed_by_user/);
  await expect(wechatReceipt.getByText("已保存平台草稿", { exact: true })).toHaveCount(0);
  await expect(submit).toHaveText("同步到 0 个账号草稿");
  await expect(submit).toBeDisabled();
  expect(acknowledgements).toEqual([{ accountId: "wechat-test", outcome: "saved" }]);
  expect(jobs).toHaveLength(2);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("test-local-pairing");
  expect(await savedDraftSummary(page), "A sync itself must not opt the user into local draft storage").toBeNull();
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
  const saved = await savedDraftSummary(page);
  expect(saved?.selectedAccountIds).toEqual([]);
  expect(saved?.receipts.find((receipt) => receipt.accountId === "wechat-test")?.status).toBe("confirmed_by_user");

  await dialog.getByRole("checkbox", { name: /公众号测试账号/ }).check();
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("公众号后续草稿");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(wechatReceipt.getByText("待核实", { exact: true })).toBeVisible();
  await expect(wechatReceipt).toContainText("未收到完整结果");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
  expect((await savedDraftSummary(page))?.receipts.find((receipt) => receipt.accountId === "wechat-test")?.status).toBe("needs_confirmation");
  await wechatReceipt.getByRole("button", { name: "已在平台核对，确认未保存", exact: true }).click();
  await expect(wechatReceipt.getByText("未保存", { exact: true })).toBeVisible();
  await expect(wechatReceipt).toContainText("尚未再次发送");
  await expect(submit).toBeEnabled();
  expect(acknowledgements).toEqual([{ accountId: "wechat-test", outcome: "saved" }, { accountId: "wechat-test", outcome: "not_saved" }]);
  expect(jobs.map((job) => job.accountId)).toEqual(["xhs-test", "wechat-test", "wechat-test"]);
  expect((await savedDraftSummary(page))?.receipts.find((receipt) => receipt.accountId === "wechat-test")?.status).toBe("needs_confirmation");
  await dialog.press("Escape");
  await page.reload();
  const restored = await openDraftDialog(page);
  await restored.getByRole("button", { name: "继续本机存档", exact: true }).click();
  await restored.getByLabel("本机助手配对码", { exact: true }).fill("test-local-pairing");
  await restored.getByRole("button", { name: "连接助手", exact: true }).click();
  const historical = restored.getByRole("article", { name: "公众号测试账号的同步结果", exact: true });
  await expect(historical.getByText("历史回执", { exact: true })).toBeVisible();
  await expect(historical).toContainText("助手当前已解除锁定");
  await expect(historical.getByRole("button", { name: /^已在平台核对/ })).toHaveCount(0);
  await restored.getByRole("checkbox", { name: "我已核对图片，沿用当前尺寸和比例", exact: true }).check();
  await expect(restored.locator(".draft-sync-footer-actions .primary")).toBeEnabled();
  expect(jobs).toHaveLength(3);
  expect(acknowledgements).toHaveLength(2);
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
  let accountReply = 0;
  await page.route("http://127.0.0.1:47831/api/accounts", async (route) => {
    const headers = { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    const body = route.request().method() === "OPTIONS" ? {} : ++accountReply === 1 ? { accounts: null } : { accounts: [{ id: "invalid", platform: "unknown-platform", displayName: "无效账号", remoteId: "invalid", ready: true }] };
    await route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
  await dialog.getByLabel("本机助手配对码", { exact: true }).fill("invalid-response-test");
  await dialog.getByRole("button", { name: "连接助手", exact: true }).click();
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("账号列表无效");
  await dialog.getByRole("button", { name: "连接助手", exact: true }).click();
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("账号信息不完整");
  await expect(dialog.getByRole("checkbox", { name: /无效账号/ })).toHaveCount(0);
  await page.evaluate(() => {
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name: string, version?: number) {
      if (name === "zhepage-local-draft-sync") throw new DOMException("Test storage denied", "SecurityError");
      return originalOpen.call(this, name, version);
    };
  });
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("Test storage denied");
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toHaveCount(0);
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible();
  await dialog.press("Escape");
  await expect(page.getByRole("button", { name: "同步草稿", exact: true })).toBeFocused();
});
