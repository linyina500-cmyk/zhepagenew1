import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectPreviewReady, importRichArticle, mainEditor } from "./helpers";

test("online preview explains the Mac startup route without offering unusable account pairing", async ({ page }, testInfo) => {
  test.setTimeout(240000);
  const localRequests: string[] = [];
  await page.route("http://127.0.0.1:47831/**", async (route) => {
    localRequests.push(route.request().url());
    await route.abort();
  });
  // Exercise the built application on a genuine non-loopback browser origin.
  // All page assets still come from the isolated runner, with no external site.
  await page.route("https://draft-preview.example.test/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.addInitScript(() => localStorage.setItem("zhepage-guide-seen-v1", "1"));
  await page.goto("https://draft-preview.example.test/#zhepage-pairing=public-page-must-not-use-this-test-token");
  await expect(mainEditor(page)).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await expectPreviewReady(page);
  await page.getByRole("button", { name: "同步草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "同步到平台草稿", exact: true });
  await dialog.getByRole("button", { name: "用当前海报开始", exact: true }).click();
  await expect(dialog.locator(".draft-sync-image-card").first()).toBeVisible({ timeout: 110000 });
  await dialog.getByLabel("小红书标题", { exact: true }).fill("在线先确认内容");
  await dialog.getByRole("button", { name: "下一步：选择账号", exact: true }).click();
  const download = dialog.getByRole("link", { name: "下载 Mac 启动工具", exact: true });
  await expect(download).toHaveAttribute("href", "/downloads/zhepage-draft-helper.zip");
  await expect(dialog.getByRole("link", { name: "打开本机版", exact: true })).toHaveAttribute("href", "http://127.0.0.1:5173/");
  await expect(dialog.getByText(/双击“启动折页.command”/)).toBeVisible();
  await expect(dialog.getByLabel("本机助手配对码", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "存到 0 个账号草稿", exact: true })).toBeDisabled();
  expect(localRequests).toEqual([]);
  await download.scrollIntoViewIfNeeded();
  await testInfo.attach("online-preview-startup-guidance", { body: await page.screenshot(), contentType: "image/png" });
  const pendingDownload = page.waitForEvent("download");
  await download.click();
  const packageDownload = await pendingDownload;
  expect(await packageDownload.failure()).toBeNull();
  const packagePath = await packageDownload.path();
  expect(packagePath).not.toBeNull();
  const archive = await JSZip.loadAsync(await readFile(packagePath!), { checkCRC32: true });
  expect(archive.file("启动折页.command")).not.toBeNull();
  expect(archive.file("程序文件/companion/launch.mjs")).not.toBeNull();
  expect(archive.file("程序文件/companion/browserRuntime.mjs")).not.toBeNull();
  await dialog.getByRole("button", { name: "上一步", exact: true }).click();
  await expect(dialog.getByLabel("小红书标题", { exact: true })).toHaveValue("在线先确认内容");
});
