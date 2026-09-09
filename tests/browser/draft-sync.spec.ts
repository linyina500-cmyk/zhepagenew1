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
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible({ timeout: 110_000 });
  await expect(dialog.locator(".draft-sync-footer-status")).toContainText("已准备");
  await expect.poll(() => dialog.locator(".draft-sync-image-card img").first().evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(1080);
  return dialog;
}

async function choosePlatform(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await dialog.locator(".draft-sync-platforms").getByRole("button", { name: platform === "wechat" ? /^公众号贴图/ : /^小红书/ }).click();
}

async function chooseStep(dialog: Locator, step: "确认内容" | "选择账号" | "保存结果") {
  const button = dialog.getByRole("navigation", { name: "草稿保存步骤" }).getByRole("button", { name: step, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "step");
}

async function connectManually(dialog: Locator, token: string) {
  await chooseStep(dialog, "选择账号");
  await dialog.locator(".draft-sync-troubleshooting > summary").click();
  await dialog.getByLabel("本机助手配对码", { exact: true }).fill(token);
  await dialog.getByRole("button", { name: "连接助手", exact: true }).click();
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
  await expect(dialog.getByLabel("本机助手配对码", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("小红书标题", { exact: true }).fill("小红书同步标题");
  await dialog.getByLabel("小红书文案", { exact: true }).fill("小红书同步配文");
  await choosePlatform(dialog, "wechat");
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("公众号同步标题");
  await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("公众号同步配文");
  await dialog.getByRole("button", { name: "下一步：选择账号", exact: true }).click();
  await expect(dialog.getByLabel("本机助手配对码", { exact: true })).toBeHidden();
  await connectManually(dialog, "test-local-pairing");
  await expect(dialog.getByText("本机同步已就绪", { exact: true })).toBeVisible();
  await choosePlatform(dialog, "xiaohongshu");
  await expect(dialog.getByRole("checkbox", { name: /小红书测试账号/ })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /小红书测试账号/ }).check();
  await expect(dialog.getByRole("button", { name: "打开小红书登录窗口", exact: true })).toBeEnabled();
  await choosePlatform(dialog, "wechat");
  await dialog.getByRole("checkbox", { name: /公众号测试账号/ }).check();
  await expect(dialog.getByLabel("公众号 AppSecret", { exact: true })).toBeHidden();
  const submit = dialog.getByRole("button", { name: /^存到 \d+ 个账号草稿$/ });
  await expect(submit).toHaveText("存到 2 个账号草稿");
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("region", { name: "同步前检查" })).toContainText("不是平台强制尺寸");
  expect(jobs).toHaveLength(0);
  await dialog.getByRole("checkbox", { name: "我已核对图片，沿用当前尺寸和比例", exact: true }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  try {
    await expect.poll(() => jobs.length).toBe(1);
    await expect(submit).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "关闭草稿同步", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "返回选择账号", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("navigation").getByRole("button", { name: "确认内容", exact: true })).toBeDisabled();
    await dialog.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "完成", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(dialog).toBeVisible();
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
  await chooseStep(dialog, "选择账号");
  await expect(submit).toHaveText("存到 1 个账号草稿");
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "刷新账号", exact: true }).click();
  await expect(submit).toBeDisabled();
  await dialog.getByRole("button", { name: "查看保存结果", exact: true }).click();
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
  await dialog.getByRole("button", { name: "返回选择账号", exact: true }).click();
  await expect(submit).toHaveText("存到 0 个账号草稿");
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

  await chooseStep(dialog, "确认内容");
  await dialog.getByLabel("公众号贴图标题", { exact: true }).fill("公众号后续草稿");
  await dialog.getByRole("button", { name: "下一步：选择账号", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /公众号测试账号/ }).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(wechatReceipt.getByText("待核实", { exact: true })).toBeVisible();
  await expect(wechatReceipt).toContainText("未收到完整结果");
  await chooseStep(dialog, "选择账号");
  await expect(submit).toBeDisabled();
  await chooseStep(dialog, "保存结果");
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
  expect((await savedDraftSummary(page))?.receipts.find((receipt) => receipt.accountId === "wechat-test")?.status).toBe("needs_confirmation");
  await wechatReceipt.getByRole("button", { name: "已在平台核对，确认未保存", exact: true }).click();
  await expect(wechatReceipt.getByText("未保存", { exact: true })).toBeVisible();
  await expect(wechatReceipt).toContainText("尚未再次发送");
  await dialog.getByRole("button", { name: "返回选择账号", exact: true }).click();
  await expect(submit).toBeEnabled();
  expect(acknowledgements).toEqual([{ accountId: "wechat-test", outcome: "saved" }, { accountId: "wechat-test", outcome: "not_saved" }]);
  expect(jobs.map((job) => job.accountId)).toEqual(["xhs-test", "wechat-test", "wechat-test"]);
  expect((await savedDraftSummary(page))?.receipts.find((receipt) => receipt.accountId === "wechat-test")?.status).toBe("needs_confirmation");
  await dialog.press("Escape");
  await page.reload();
  const restored = await openDraftDialog(page);
  await restored.getByRole("button", { name: "继续本机存档", exact: true }).click();
  await connectManually(restored, "test-local-pairing");
  await chooseStep(restored, "保存结果");
  const historical = restored.getByRole("article", { name: "公众号测试账号的同步结果", exact: true });
  await expect(historical.getByText("历史回执", { exact: true })).toBeVisible();
  await expect(historical).toContainText("助手当前已解除锁定");
  await expect(historical.getByRole("button", { name: /^已在平台核对/ })).toHaveCount(0);
  await chooseStep(restored, "选择账号");
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
  await connectManually(dialog, "invalid-response-test");
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("账号列表无效");
  await dialog.getByRole("button", { name: "连接助手", exact: true }).click();
  await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("账号信息不完整");
  await expect(dialog.getByRole("checkbox", { name: /无效账号/ })).toHaveCount(0);
  await chooseStep(dialog, "确认内容");
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

test("account login keeps editing available and only unlocks after cancellation is reconciled", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const existing = { id: "existing-xhs", platform: "xiaohongshu", displayName: "已有小红书账号", remoteId: "existing-identity", ready: true };
  const late = { id: "cancelled-xhs", platform: "xiaohongshu", displayName: "取消后的迟到账号", remoteId: "late-identity", ready: true };
  const completed = { id: "completed-xhs", platform: "xiaohongshu", displayName: "取消前已完成的账号", remoteId: "completed-identity", ready: true };
  const wechat = { id: "background-wechat", platform: "wechat", displayName: "后台验证公众号", remoteId: "wx1234567890abcdef", ready: true };
  const accounts = [existing];
  let loginRequests = 0;
  let cancelRequests = 0;
  let jobRequests = 0;
  let helperRestarted = false;
  const loginRequestIds: string[] = [];
  const cancelledRequestIds: string[] = [];
  let activeLoginRequestId: string | null = null;
  const otherPageLoginId = "99999999-9999-4999-8999-999999999999";
  const accountAuthentications: string[] = [];
  let releaseFirstLogin!: () => void;
  let releaseSecondLogin!: () => void;
  let releaseCancellation!: () => void;
  let releaseWechat!: () => void;
  const firstLogin = new Promise<void>((resolve) => { releaseFirstLogin = resolve; });
  const secondLogin = new Promise<void>((resolve) => { releaseSecondLogin = resolve; });
  const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const wechatVerification = new Promise<void>((resolve) => { releaseWechat = resolve; });
  await page.route("http://127.0.0.1:47831/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "http://127.0.0.1:4173", "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    const respond = (json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(json) });
    if (request.method() === "OPTIONS") return respond({});
    if (path === "/api/accounts") {
      accountAuthentications.push(request.headers().authorization);
      return respond({ accounts: helperRestarted ? accounts.map((account) => ({ ...account, syncBlocked: account.id === existing.id })) : accounts });
    }
    if (path === "/api/accounts/xiaohongshu") {
      const attempt = ++loginRequests;
      const payload = request.postDataJSON() as { displayName: string; loginRequestId: string };
      expect(payload).toEqual({ displayName: "小红书账号", loginRequestId: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) });
      loginRequestIds.push(payload.loginRequestId);
      if (attempt === 4) {
        activeLoginRequestId = otherPageLoginId;
        return respond({ error: "请等待当前账号连接或同步完成" }, 409);
      }
      activeLoginRequestId = payload.loginRequestId;
      if (attempt === 3) return respond({ error: "原助手连接已中断" }, 503);
      await (attempt === 1 ? firstLogin : secondLogin);
      return respond({ account: attempt === 1 ? late : completed });
    }
    if (path === "/api/accounts/cancel-login") {
      cancelRequests += 1;
      const payload = request.postDataJSON() as { loginRequestId: string };
      cancelledRequestIds.push(payload.loginRequestId);
      expect(payload).toEqual({ loginRequestId: loginRequestIds[loginRequestIds.length - 1] });
      if (payload.loginRequestId !== activeLoginRequestId) return respond({ cancelled: false });
      if (cancelRequests === 1 || cancelRequests === 4) return respond({ error: "临时无法确认取消，请再试一次" }, 503);
      if (cancelRequests === 2) { await cancellation; activeLoginRequestId = null; return respond({ cancelled: true }); }
      activeLoginRequestId = null;
      accounts.push(completed);
      releaseSecondLogin();
      return respond({ cancelled: false });
    }
    if (path === "/api/accounts/wechat") {
      await wechatVerification;
      accounts.push(wechat);
      return respond({ account: wechat });
    }
    if (path === "/api/jobs") { jobRequests += 1; return respond({ error: "本测试不应提交平台草稿" }, 409); }
    throw new Error(`Unexpected companion request during login: ${path}`);
  });
  try {
    const dialog = await prepareRealImages(page);
    await dialog.getByLabel("小红书标题", { exact: true }).fill("扫码期间可以编辑");
    await connectManually(dialog, "login-progress-test");
    await dialog.getByRole("checkbox", { name: /已有小红书账号/ }).check();
    const submit = dialog.getByRole("button", { name: /^存到 \d+ 个账号草稿$/ });
    await expect(submit).toBeEnabled();
    const login = dialog.getByRole("button", { name: "打开小红书登录窗口", exact: true });
    await login.click();
    await expect.poll(() => loginRequests).toBe(1);
    const progress = dialog.getByRole("region", { name: "账号连接进度", exact: true });
    await expect(progress.getByText("请在新窗口扫码", { exact: true })).toBeVisible();
    await expect(login).toBeDisabled();
    await login.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /移除账号并删除本机登录状态 已有小红书账号/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "刷新账号", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "关闭草稿同步", exact: true })).toBeEnabled();
    await chooseStep(dialog, "确认内容");
    await dialog.getByLabel("小红书文案", { exact: true }).fill("扫码期间写下的文案仍然保留。");
    const before = await dialog.locator(".draft-sync-image-card").count();
    await uploadDraftFile(page, dialog.getByRole("button", { name: "＋ 添加图片", exact: true }), "during-login.png", makePng(90, 30, 180));
    await expect(dialog.locator(".draft-sync-image-card")).toHaveCount(before + 1);
    await dialog.locator(".draft-sync-image-card").last().getByRole("button", { name: /^删除/ }).click();
    await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
    await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
    expect((await savedDraftSummary(page))?.content.xiaohongshu.body).toBe("扫码期间写下的文案仍然保留。");
    await expect(progress).toBeVisible();
    const bounds = await progress.evaluate((element) => {
      const dialog = element.closest("dialog")!.getBoundingClientRect();
      const button = element.querySelector("button")!.getBoundingClientRect();
      return { left: button.left, right: button.right, dialogLeft: dialog.left, dialogRight: dialog.right, footerBottom: element.closest("dialog")!.querySelector(".draft-sync-footer")!.getBoundingClientRect().bottom, height: innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.dialogLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.dialogRight);
    expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.height);
    await progress.getByRole("button", { name: "取消登录", exact: true }).click();
    await expect(progress.getByRole("alert")).toContainText("临时无法确认取消");
    await expect(dialog.getByLabel("小红书文案", { exact: true })).toBeEnabled();
    await chooseStep(dialog, "选择账号");
    await expect(login).toBeDisabled();
    await expect(submit).toBeDisabled();
    await progress.getByRole("button", { name: "取消登录", exact: true }).click();
    await expect(progress.getByText("正在取消登录…", { exact: true })).toBeVisible();
    await expect(progress.getByRole("button", { name: "取消登录", exact: true })).toBeDisabled();
    const originalResponse = page.waitForResponse((response) => response.url().endsWith("/api/accounts/xiaohongshu") && response.request().method() === "POST");
    releaseFirstLogin();
    await originalResponse;
    releaseCancellation();
    await expect(progress).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: /取消后的迟到账号/ })).toHaveCount(0);
    await expect(login).toBeEnabled();
    await expect(submit).toBeEnabled();
    expect(loginRequests).toBe(1);
    expect(cancelRequests).toBe(2);
    expect(jobRequests).toBe(0);

    await login.click();
    await expect.poll(() => loginRequests).toBe(2);
    await dialog.getByRole("button", { name: "关闭草稿同步", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "同步草稿", exact: true })).toBeFocused();
    await openDraftDialog(page);
    await expect(progress).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: /取消前已完成的账号/ })).toBeVisible();
    await expect(dialog.locator(".draft-sync-footer-status")).toContainText("这次登录已经结束，已刷新账号列表");
    expect(cancelRequests).toBe(3);
    expect(jobRequests).toBe(0);

    await choosePlatform(dialog, "wechat");
    await dialog.locator(".draft-sync-wechat-setup > summary").click();
    await dialog.getByLabel("公众号 AppID", { exact: true }).fill("wx1234567890abcdef");
    await dialog.getByLabel("公众号 AppSecret", { exact: true }).fill("fake-secret-for-browser-test");
    await dialog.getByRole("button", { name: "验证并添加公众号", exact: true }).click();
    await expect(progress.getByText("正在验证公众号", { exact: true })).toBeVisible();
    await expect(progress.getByRole("button", { name: "取消登录", exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("公众号 AppSecret", { exact: true })).toHaveValue("");
    await chooseStep(dialog, "确认内容");
    await dialog.getByLabel("公众号贴图文案", { exact: true }).fill("公众号验证时也能继续编辑。");
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    await openDraftDialog(page);
    await expect(progress.getByText("正在验证公众号", { exact: true })).toBeVisible();
    releaseWechat();
    await expect(progress).toHaveCount(0);
    await chooseStep(dialog, "选择账号");
    await expect(dialog.getByRole("checkbox", { name: /后台验证公众号/ })).toBeVisible();
    expect(cancelRequests).toBe(3);
    expect(jobRequests).toBe(0);

    await choosePlatform(dialog, "xiaohongshu");
    await login.click();
    await expect(progress.getByText("登录状态尚未确认", { exact: true })).toBeVisible();
    await expect(login).toBeDisabled();
    expect(cancelRequests).toBe(4);
    helperRestarted = true;
    const freshToken = "fresh-process-pairing-token-1234567890";
    await page.evaluate((token) => { window.location.hash = `zhepage-pairing=${token}`; }, freshToken);
    await expect(progress).toHaveCount(0);
    await expect(dialog.locator(".draft-sync-footer-status")).toContainText("本机同步已重新连接，请核对账号后继续");
    await expect(login).toBeEnabled();
    await expect(dialog.getByRole("checkbox", { name: /已有小红书账号/ }).locator("..")).toContainText("上次结果待核实");
    await expect(submit).toBeDisabled();
    expect(accountAuthentications).toContain(`Bearer ${freshToken}`);
    expect(cancelRequests).toBe(4);
    expect(jobRequests).toBe(0);

    await login.click();
    await expect(dialog.locator(".draft-sync-footer-status").getByRole("alert")).toContainText("请等待当前账号连接或同步完成");
    await expect(progress).toHaveCount(0);
    expect(activeLoginRequestId).toBe(otherPageLoginId);
    expect(new Set(loginRequestIds).size).toBe(4);
    expect(cancelledRequestIds).toEqual([loginRequestIds[0], loginRequestIds[0], loginRequestIds[1], loginRequestIds[2], loginRequestIds[3]]);
    expect(cancelledRequestIds).not.toContain(otherPageLoginId);
    expect(jobRequests).toBe(0);
  } finally {
    releaseFirstLogin();
    releaseSecondLogin();
    releaseCancellation();
    releaseWechat();
  }
});
