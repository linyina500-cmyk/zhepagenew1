import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { articleBody, articleTitle, compactText, makePng, originalArticle, originalArticleHtml, shortArticleHtml, shortBody, shortTitle } from "./fixtures";
import { expectCompletePreview, expectFullEditorSelection, expectPreviewImage, expectPreviewReady, importRichArticle, mainEditor, mainEditorPanel, openRichTextImport, openWorkbench, pasteHtml, pasteHtmlAtSelection, pasteImage, uploadImage } from "./helpers";

const uncaughtErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  uncaughtErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await openWorkbench(page);
});

test.afterEach(async ({ page }, testInfo) => {
  const errors = uncaughtErrors.get(page) || [];
  if (errors.length) await testInfo.attach("uncaught-browser-errors", { body: errors.join("\n\n"), contentType: "text/plain" });
  if (testInfo.status !== testInfo.expectedStatus) {
    const status = await page.locator(".status-pill").textContent().catch(() => "The page closed before its status could be read.");
    await testInfo.attach("workbench-status", { body: status || "", contentType: "text/plain" });
  }
  expect(errors, "The browser must not report uncaught application errors").toEqual([]);
});

test("the regression article and its five NBSP paragraphs survive rich-text import and both previews", async ({ page }) => {
  await importRichArticle(page, originalArticleHtml, originalArticle);
  await expect(page.getByLabel("醒目标题", { exact: true })).toHaveValue(articleTitle);
  await expectCompletePreview(page, articleBody);

  await page.getByRole("button", { name: /一键自动排版/ }).click();
  await expectCompletePreview(page, articleBody);
  await expect(page.locator(".poster-grid .article-flow .auto-inferred-heading")).toHaveCount(7);
  for (const name of ["基础样式", "美化后"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expectCompletePreview(page, articleBody);
  }
});

test("changing page format, layout, font size, and theme preserves every line without clipping", async ({ page }) => {
  test.setTimeout(180_000);
  await importRichArticle(page, originalArticleHtml, originalArticle);
  for (const name of ["财经深读", "数据索引", "简洁资讯", "重点卡片", "小红书"]) {
    await page.locator(".layout-style-grid").getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expectCompletePreview(page, articleBody);
  }
  for (const name of ["公众号 4:5", "竖版 9:16", "小红书 3:4"]) {
    await page.locator(".format-grid").getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expectCompletePreview(page, articleBody);
  }
  await page.locator(".visual-advanced-settings > summary").click();
  const fontSize = page.getByRole("slider", { name: /^字号/ });
  await fontSize.focus();
  await fontSize.press("End");
  await expect(fontSize).toHaveValue("1.24");
  const bodyFont = page.locator(".font-grid label")
    .filter({ has: page.getByText("正文字体", { exact: true }) })
    .getByRole("combobox");
  await bodyFont.selectOption("sans");
  await expect(bodyFont).toHaveValue("sans");
  await expectCompletePreview(page, articleBody);
  await page.locator(".theme-selector > summary").click();
  const theme = page.locator(".theme-selector-panel").getByRole("button", { name: /^雾蓝珊瑚/ });
  await theme.click();
  await expect(theme).toHaveClass(/selected/);
  await expectCompletePreview(page, articleBody);
});

test("pasting a PNG into the main editor inserts a decoded image and supports undo and redo", async ({ page }) => {
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const png = makePng();
  const source = `data:image/png;base64,${png.toString("base64")}`;
  await pasteImage(mainEditor(page), png, "pasted-chart.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, source);
  await expectCompletePreview(page, shortBody);

  await mainEditorPanel(page).locator('button[data-tooltip^="撤销上一步"]').click();
  await expect(mainEditor(page).locator("img")).toHaveCount(0);
  await mainEditorPanel(page).locator('button[data-tooltip^="重做，也可按"]').click();
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, source);
  await expectCompletePreview(page, shortBody);
});

test("the image upload button works in both the import dialog and the main editor", async ({ page }) => {
  const { dialog, editor } = await openRichTextImport(page);
  await pasteHtml(editor, shortArticleHtml, shortTitle + shortBody);
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  const firstPng = makePng(180, 40, 80);
  await uploadImage(page, dialog, firstPng, "import-chart.png");
  await expect(editor.locator("img")).toHaveCount(1);
  await dialog.getByRole("button", { name: "导入并替换正文 →", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, `data:image/png;base64,${firstPng.toString("base64")}`);

  await mainEditor(page).click();
  await mainEditor(page).press("ControlOrMeta+End");
  await mainEditor(page).press("Enter");
  const secondPng = makePng(30, 170, 90);
  await uploadImage(page, mainEditorPanel(page), secondPng, "main-chart.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(2);
  await expectPreviewImage(page, `data:image/png;base64,${secondPng.toString("base64")}`, 2);
  await expectCompletePreview(page, shortBody);
});

test("a rejected oversized paste preserves the selected article and the next valid paste succeeds", async ({ page }) => {
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const selectedArticle = await pasteHtml(mainEditor(page), "", "文".repeat(30_001));
  await expect(page.locator(".status-pill.error")).toContainText("3 万字");
  await expect.poll(async () => compactText(await mainEditor(page).textContent() || "")).toBe(compactText(shortBody));
  expect(await expectFullEditorSelection(mainEditor(page)), "Rejecting a paste must preserve the original selection").toEqual(selectedArticle);

  const replacement = "恢复后正文完整。";
  // Paste into the selection that survived rejection; clicking or selecting
  // again here would conceal a lost-selection regression.
  await pasteHtmlAtSelection(mainEditor(page), `<p>${replacement}</p>`, replacement);
  await expectCompletePreview(page, replacement);
});

test("exporting a rendered page downloads a real PNG with the selected dimensions", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  await page.locator(".format-grid").getByRole("button", { name: /^公众号 4:5/ }).click();
  await expectCompletePreview(page, shortBody);
  const downloadPromise = page.waitForEvent("download", { timeout: 110_000 });
  await page.getByRole("button", { name: "导出第 1 页", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  expect(await download.failure()).toBeNull();
  const output = testInfo.outputPath("exported-page.png");
  await download.saveAs(output);
  const png = await readFile(output);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1350);
  expect(png.length).toBeGreaterThan(10_000);
  await testInfo.attach("exported-page", { path: output, contentType: "image/png" });
  await expect(page.locator(".status-pill.success")).toContainText("已导出为高清 PNG");
});

test("editing then reloading restores the article, image, title, and selected format", async ({ page }) => {
  await importRichArticle(page, shortArticleHtml, shortTitle + shortBody);
  const png = makePng();
  await pasteImage(mainEditor(page), png, "saved-chart.png");
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await mainEditor(page).click();
  await mainEditor(page).press("ControlOrMeta+End");
  await mainEditor(page).press("Enter");
  const addition = "这是刷新后仍需保留的新编辑。";
  await mainEditor(page).pressSequentially(addition);
  await page.getByLabel("醒目标题", { exact: true }).fill("恢复后的标题");
  await page.locator(".format-grid").getByRole("button", { name: /^竖版 9:16/ }).click();
  await expectCompletePreview(page, shortBody + addition);
  // Observe the write completing instead of waiting an arbitrary debounce.
  await expect.poll(() => page.evaluate((marker) => Object.values(localStorage).some((value) => value.includes(marker) && value.includes("恢复后的标题") && value.includes('"formatKey":"story"')), addition)).toBe(true);
  await page.reload();
  await expect(mainEditor(page)).toBeVisible();
  await expect(page.getByLabel("醒目标题", { exact: true })).toHaveValue("恢复后的标题");
  await expect(page.locator(".format-grid").getByRole("button", { name: /^竖版 9:16/ })).toHaveClass(/selected/);
  await expect(mainEditor(page).locator("img")).toHaveCount(1);
  await expectPreviewImage(page, `data:image/png;base64,${png.toString("base64")}`);
  await expectCompletePreview(page, shortBody + addition);
  await expectPreviewReady(page);
});
