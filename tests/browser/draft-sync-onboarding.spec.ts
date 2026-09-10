import { expect, test } from "@playwright/test";
import { shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewReady, importRichArticle, openWorkbench } from "./helpers";
import { CLOUD_ORIGIN, cloudStep, openCloudDialog } from "../helpers/cloud-sync";

test.use({ baseURL: CLOUD_ORIGIN, ignoreHTTPSErrors: true });

test("an undeployed cloud service explains the unavailable sync while editing remains available", async ({ page }, testInfo) => {
  test.setTimeout(240000);
  const requests: string[] = [];
  const downloads: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.route("**/api/sync/**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "网页同步服务尚未部署，请联系站点管理员完成配置" }) }));
  await openWorkbench(page);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await expectPreviewReady(page);
  const dialog = await openCloudDialog(page);
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible({ timeout: 110000 });
  await dialog.getByLabel("小红书标题", { exact: true }).fill("网页继续编辑内容");
  await cloudStep(dialog, "选择账号");
  await expect(dialog.getByRole("alert").filter({ hasText: "网页同步服务尚未部署，请联系站点管理员完成配置" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "存到 0 个账号草稿", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("link", { name: /下载|打开本机版/ })).toHaveCount(0);
  await expect(dialog.locator('a[href^="http://127.0.0.1:"], a[href^="http://localhost:"], a[href*=".zip"]')).toHaveCount(0);
  await expect(dialog.getByLabel("本机助手配对码", { exact: true })).toHaveCount(0);
  expect(requests.filter((url) => /^https?:/.test(url) && ["localhost", "127.0.0.1"].includes(new URL(url).hostname) && new URL(url).origin !== CLOUD_ORIGIN)).toEqual([]);
  expect(requests.filter((url) => /\/downloads\/|\.zip(?:$|\?)/.test(url))).toEqual([]);
  expect(downloads).toEqual([]);
  await testInfo.attach("cloud-service-not-configured", { body: await page.screenshot(), contentType: "image/png" });
  await cloudStep(dialog, "确认内容");
  await expect(dialog.getByLabel("小红书标题", { exact: true })).toHaveValue("网页继续编辑内容");
  await dialog.getByRole("button", { name: "存到本机", exact: true }).click();
  await expect(dialog.getByText("图片、文案和账号选择已存到当前浏览器", { exact: true })).toBeVisible();
});
