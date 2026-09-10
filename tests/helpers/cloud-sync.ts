import { expect, type Locator, type Page } from "@playwright/test";
import { shortArticleHtml, shortBody, shortTitle } from "../browser/fixtures";
import { expectPreviewReady, importRichArticle, openWorkbench } from "../browser/helpers";

export const CLOUD_ORIGIN = "https://127.0.0.1:4174";
export const SERVICE_PASSWORD = "browser-test-service-password-not-a-real-secret";
export const PLATFORM_SECRET = "synthetic-test-platform-secret-only";
export type CloudState = {
  verifications: number; loginStarts: number; activeRuntimes: number; closedRuntimes: number;
  saves: { accountId: string; displayName: string; platform: string; content: { title: string; body: string }; images: { name: string; mime: string; width: number; height: number; bytes: number; sha256: string }[] }[];
};

export async function cloudState(page: Page): Promise<CloudState> {
  const response = await page.request.get(`${CLOUD_ORIGIN}/__cloud-test/state`);
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function openCloudDialog(page: Page) {
  await page.getByRole("button", { name: "同步草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "同步到平台草稿", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("正在检查本机存档…", { exact: true })).toHaveCount(0);
  return dialog;
}

export async function prepareCloudDraft(page: Page, loginMode: "waiting" | "complete" = "complete") {
  const reset = await page.request.post(`${CLOUD_ORIGIN}/__cloud-test/reset`, { data: { loginMode } });
  expect(reset.ok()).toBe(true);
  await openWorkbench(page);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await expectPreviewReady(page);
  const dialog = await openCloudDialog(page);
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible({ timeout: 110000 });
  await expect(dialog.locator(".draft-sync-footer-status")).toContainText("已准备");
  return dialog;
}

export async function cloudStep(dialog: Locator, step: "确认内容" | "选择账号" | "保存结果") {
  const button = dialog.getByRole("navigation", { name: "草稿保存步骤" }).getByRole("button", { name: step, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "step");
}

export async function cloudPlatform(dialog: Locator, platform: "xiaohongshu" | "wechat") {
  await dialog.locator(".draft-sync-platforms").getByRole("button", { name: platform === "wechat" ? /^公众号贴图/ : /^小红书/ }).click();
}

export async function connectCloud(dialog: Locator, remember = true) {
  await cloudStep(dialog, "选择账号");
  await dialog.getByLabel("同步服务口令", { exact: true }).fill(SERVICE_PASSWORD);
  await dialog.getByRole("checkbox", { name: "在此浏览器记住账号（点击连接服务后生效）", exact: true }).setChecked(remember);
  await dialog.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(dialog.getByText("网页同步服务已连接", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("重新登录同步服务", { exact: true })).toHaveValue("");
}

export async function addCloudWechat(dialog: Locator, displayName: string, appId: string) {
  await cloudPlatform(dialog, "wechat");
  const setup = dialog.locator(".draft-sync-wechat-setup");
  if (!(await setup.evaluate((node) => (node as HTMLDetailsElement).open))) await setup.locator("summary").click();
  await dialog.getByLabel("账号备注（选填）", { exact: true }).fill(displayName);
  await dialog.getByLabel("公众号 AppID", { exact: true }).fill(appId);
  await dialog.getByLabel("公众号 AppSecret", { exact: true }).fill(PLATFORM_SECRET);
  await dialog.getByRole("button", { name: "验证并添加公众号", exact: true }).click();
  const checkbox = dialog.getByRole("checkbox", { name: `选择同步账号 ${displayName}`, exact: true });
  await expect(checkbox).toBeVisible();
  await expect(dialog.getByLabel("公众号 AppSecret", { exact: true })).toHaveValue("");
  return checkbox;
}

export async function addCloudXhs(dialog: Locator, displayName: string) {
  await cloudPlatform(dialog, "xiaohongshu");
  await dialog.getByLabel("账号备注（选填）", { exact: true }).fill(displayName);
  await dialog.getByRole("button", { name: "显示小红书登录二维码", exact: true }).click();
  const checkbox = dialog.getByRole("checkbox", { name: `选择同步账号 ${displayName} · 测试创作者`, exact: true });
  await expect(checkbox).toBeVisible();
  return checkbox;
}

export async function credentialState(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("zhepage-cloud-sync-credentials", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      type Credential = { account: { id: string; displayName: string; platform: string }; envelope: string };
      const value = await new Promise<{ credentials: Credential[]; pending: unknown[]; settings: unknown[] }>((resolve, reject) => {
        const transaction = database.transaction(["credentials", "pending", "settings"], "readonly");
        const credentials = transaction.objectStore("credentials").getAll();
        const pending = transaction.objectStore("pending").getAll();
        const settings = transaction.objectStore("settings").getAll();
        transaction.oncomplete = () => resolve({ credentials: credentials.result, pending: pending.result, settings: settings.result });
        transaction.onerror = () => reject(transaction.error);
      });
      return { ...value, serialized: JSON.stringify({ ...value, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } }) };
    } finally { database.close(); }
  });
}
