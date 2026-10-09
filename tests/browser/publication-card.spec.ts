import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { makePng } from "./fixtures";
import { expectPreviewReady, mainEditor, openWorkbench } from "./helpers";

test("publication copy and QR updates persist, keep the card whole, and appear in the PNG", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    if (localStorage.getItem("publication-fixture")) return;
    localStorage.setItem("publication-fixture", "1");
    localStorage.setItem("zhepage-workspace-v2", JSON.stringify({ version: 2, title: "刊物编辑验证", articleHtml: "<p>正文前段。</p><div class=\"lead-card-placeholder\">PDF 刊物领取卡</div><p>正文末段。</p>", firstPageContent: false, showRiskNote: false, autoStructure: false, formatKey: "xiaohongshu", bottomReserve: 180 }));
  });
  await openWorkbench(page);
  await expectPreviewReady(page);
  const card = page.locator(".poster-grid .lead-magnet-card");
  await expect(card).toHaveCount(1);
  await page.getByLabel("刊物名称（可编辑）", { exact: true }).fill("机器人产业年度观察与关键方向");
  await page.getByLabel("刊物介绍", { exact: true }).fill("产业趋势与重点公司\n一起看懂下一阶段的变化");
  await page.getByText("修改其他文案", { exact: true }).click();
  const fields = { "顶部说明": "整理给关注产业趋势的你", "领取横条": "免费获取这份参考资料", "文件说明": "电子版 · 可随时阅读", "封面小字": "产业趋势 · 关键方向", "封面角标": "年度观察" };
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("底部领取引导语", { exact: true }).fill("扫描右侧二维码，获取完整资料");
  const firstQr = makePng(193, 35, 71);
  const updatedQr = makePng(17, 193, 137);
  for (const [index, buffer] of [firstQr, updatedQr].entries()) {
    await page.locator("#qr-upload").setInputFiles({ name: `qr-${index}.png`, mimeType: "image/png", buffer });
    await expectPreviewReady(page);
    await expect(card.locator(".lead-card-qr")).toHaveAttribute("src", `data:image/png;base64,${buffer.toString("base64")}`);
  }
  await expect(card.locator(".lead-card-title")).toHaveText("《机器人产业年度观察与关键方向》");
  await expect(card.locator(".lead-card-file-name")).toHaveText("机器人产业年度观察与关键方向.pdf");
  expect((await card.locator(".lead-card-cover-title").textContent())?.replace(/\s/g, "")).toBe("机器人产业年度观察与关键方向");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("zhepage-workspace-v2") || "{}").qrDataUrl)).toBe(`data:image/png;base64,${updatedQr.toString("base64")}`);
  await page.reload();
  await expect(mainEditor(page)).toBeVisible();
  await expectPreviewReady(page);
  await expect(card).toHaveCount(1);
  await expect(page.getByLabel("刊物名称（可编辑）", { exact: true })).toHaveValue("机器人产业年度观察与关键方向");
  await expect(card.locator(".lead-card-edition")).toHaveText("年度观察");
  await expect(card.locator(".lead-card-qr")).toHaveAttribute("src", `data:image/png;base64,${updatedQr.toString("base64")}`);
  const geometry = await card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const viewport = node.closest(".article-viewport")!.getBoundingClientRect();
    return { ratio: box.width / box.height, fits: box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1, overflowingText: [...node.querySelectorAll<HTMLElement>("[style]")].filter((element) => { const bounds = element.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect(); return text.left < bounds.left - 1 || text.right > bounds.right + 1; }).map((element) => element.className), qrFit: getComputedStyle(node.querySelector(".lead-card-qr")!).objectFit };
  });
  expect(geometry.ratio).toBeCloseTo(1.5, 3);
  expect(geometry).toMatchObject({ fits: true, overflowingText: [], qrFit: "contain" });
  const marker = await card.locator(".lead-card-qr").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const poster = node.closest<HTMLElement>(".poster-page")!;
    const posterBox = poster.getBoundingClientRect();
    return { page: [...document.querySelectorAll(".poster-grid .poster-page")].indexOf(poster) + 1, x: Math.round((box.left + box.width / 2 - posterBox.left) * 1080 / posterBox.width), y: Math.round((box.top + box.height / 2 - posterBox.top) * 1440 / posterBox.height) };
  });
  const downloaded = page.waitForEvent("download", { timeout: 110_000 });
  await page.getByRole("button", { name: `导出第 ${marker.page} 页`, exact: true }).click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const file = testInfo.outputPath("publication-edited.png");
  await download.saveAs(file);
  const png = await readFile(file);
  expect(png.readUInt32BE(16)).toBe(1080);
  expect(png.readUInt32BE(20)).toBe(1440);
  const pixel = await page.evaluate(async ({ base64, x, y }) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1440;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return [...context.getImageData(x, y, 1, 1).data];
  }, { base64: png.toString("base64"), x: marker.x, y: marker.y });
  expect(pixel).toEqual([17, 193, 137, 255]);
  await testInfo.attach("edited publication PNG", { path: file, contentType: "image/png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectPreviewReady(page);
  await expect(card).toHaveCount(1);
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await expectPreviewReady(page);
  await expect(card.locator(".lead-card-qr-placeholder")).toBeVisible();
});

for (const preserveStyles of [true, false]) {
  test(`all three titles fit long Chinese, wide Latin and manual line breaks with ${preserveStyles ? "preserved" : "unified"} article styling`, async ({ page }) => {
    await page.addInitScript(({ preserve }) => {
      localStorage.setItem("zhepage-workspace-v2", JSON.stringify({ version: 2, title: "标题兼容性验证", articleHtml: '<div class="lead-card-placeholder">PDF 刊物领取卡</div>', firstPageContent: false, showRiskNote: false, autoStructure: false, formatKey: "portrait", preserveStyles: preserve }));
    }, { preserve: preserveStyles });
    await openWorkbench(page);
    await expectPreviewReady(page);
    const card = page.locator(".poster-grid .lead-magnet-card");
    for (const title of ["W".repeat(60), "长期产业观察与关键变化".repeat(8), "2026新能源汽车与AI固态电池产业报告", "第一行标题\n第二行标题\n第三行标题\n第四行标题\n第五行标题", ""]) {
      await page.getByLabel("刊物名称（可编辑）", { exact: true }).fill(title);
      await expect(card.locator(".lead-card-title")).toHaveText(title ? `《${title}》` : "");
      await expect(card.locator(".lead-card-file-name")).toHaveText(title ? `${title.replace(/\n/g, " ")}.pdf` : "");
      expect((await card.locator(".lead-card-cover-title").textContent())?.replace(/\n/g, "")).toBe(title.replace(/\n/g, ""));
      await expectPreviewReady(page);
      const overflow = await card.evaluate((node) => {
        const cardBox = node.getBoundingClientRect();
        return [...node.querySelectorAll<HTMLElement>(".lead-card-title,.lead-card-file-name,.lead-card-cover-title")].filter((element) => {
          if (!element.textContent) return false;
          const bounds = element.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          return text.left < bounds.left - 1 || text.right > bounds.right + 1 || text.top < cardBox.top || text.bottom > cardBox.bottom;
        }).map((element) => element.className);
      });
      expect(overflow, `Complete visible titles for ${JSON.stringify(title)}`).toEqual([]);
    }
    await page.getByLabel("底部领取引导语", { exact: true }).fill("长按识别二维码\n添加小助理\n即可领取！");
    await expectPreviewReady(page);
    const lines = await card.locator(".lead-card-guide-text").evaluate((element) => {
      const range = document.createRange(); range.selectNode(element.firstChild!);
      const textLines = [...range.getClientRects()].filter((rect) => rect.width > 1);
      return { previous: textLines.at(-1)!.top, final: element.querySelector("span")!.getBoundingClientRect().top };
    });
    expect(lines.final).toBeGreaterThan(lines.previous + 1);
  });
}
