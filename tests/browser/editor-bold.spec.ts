import { readFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expectCompletePreview, importRichArticle, mainEditor, mainEditorPanel, openWorkbench } from "./helpers";

async function select(editor: Locator, text?: string) {
  await editor.evaluate((element, text) => {
    const current = (element as HTMLElement & { editor: Editor }).editor;
    if (!text) { current.chain().focus().selectAll().run(); return; }
    let selected = false;
    current.state.doc.descendants((node, position) => {
      if (!selected && node.isText && node.text?.includes(text)) {
        const from = position + node.text.indexOf(text);
        current.chain().focus().setTextSelection({ from, to: from + text.length }).run(); selected = true;
      }
    });
    if (!selected) throw new Error(`Missing bold test selection: ${text}`);
  }, text);
}

async function weights(surface: Locator, texts: string[]) {
  return surface.evaluateAll((elements, texts) => {
    const result: Record<string, number> = {};
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const text of texts) if (node.textContent?.includes(text)) result[text] = Number(getComputedStyle(node.parentElement!).fontWeight);
      }
    }
    return result;
  }, texts);
}

test("imported semantic and inline/block bold can be removed in the editor and the real poster preview", async ({ page }) => {
  await openWorkbench(page);
  const labels = ["标签粗体", "另一标签", "六百字重", "七百字重", "关键字重", "段落字重", "容器字重"];
  const html = '<h1>加粗导入验证</h1><p><strong>标签粗体</strong> <b>另一标签</b></p>'
    + '<p><span style="font-weight:600">六百字重</span> <span style="font-weight:700">七百字重</span> <span style="font-weight:bold">关键字重</span></p>'
    + '<p style="font-weight:700">段落字重</p><section style="font-weight:bold"><p>容器字重</p></section>';
  await importRichArticle(page, html, "加粗导入验证" + labels.join(""));
  // Import enables the optional lead decoration (weight 610). The base view
  // isolates the author's bold edits without disabling product decorations.
  await page.getByRole("button", { name: "基础样式", exact: true }).click();
  const editor = mainEditor(page), button = mainEditorPanel(page).locator('button[data-tooltip^="粗体"]');
  for (const text of labels) {
    await select(editor, text);
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await weights(editor, [text]))[text]).toBeLessThan(500);
  }
  await expectCompletePreview(page, labels.join(""));
  const previewWeights = await weights(page.locator(".poster-grid .article-flow"), labels);
  expect(Object.keys(previewWeights)).toHaveLength(labels.length);
  expect(Object.values(previewWeights).every((weight) => weight < 500)).toBe(true);
});

test("mixed selections and normal overrides toggle consistently with the keyboard, clear and undo", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, '<h1>混合加粗验证</h1><p><strong>粗体甲<span style="font-weight:normal">普通乙</span></strong><span style="font-weight:400">普通丙</span></p>', "混合加粗验证粗体甲普通乙普通丙");
  const editor = mainEditor(page), toolbar = mainEditorPanel(page), texts = ["粗体甲", "普通乙", "普通丙"];
  const button = toolbar.locator('button[data-tooltip^="粗体"]');
  expect((await weights(editor, texts))["普通乙"]).toBeLessThan(500);
  await select(editor);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await editor.press("ControlOrMeta+B");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  expect(Object.values(await weights(editor, texts)).every((weight) => weight >= 600)).toBe(true);
  await button.click();
  expect(Object.values(await weights(editor, texts)).every((weight) => weight < 500)).toBe(true);
  await toolbar.locator('button[data-tooltip^="撤销上一步"]').click();
  expect(Object.values(await weights(editor, texts)).every((weight) => weight >= 600)).toBe(true);
  await toolbar.locator('button[data-tooltip^="清除选中文字"]').click();
  expect(Object.values(await weights(editor, texts)).every((weight) => weight < 500)).toBe(true);
  await toolbar.locator('button[data-tooltip^="撤销上一步"]').click();
  expect(Object.values(await weights(editor, texts)).every((weight) => weight >= 600)).toBe(true);
  await expectCompletePreview(page, texts.join(""));
});

test("bold edits reach the real export snapshot while independent imported text color survives", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const state = window as Window & { boldExportWeights?: Record<string, string>[] };
    state.boldExportWeights = [];
    window.Image = new Proxy(window.Image, {
      construct(target, args) {
        const image = Reflect.construct(target, args) as HTMLImageElement;
        image.addEventListener("load", () => {
          if (!image.src.startsWith("data:image/svg+xml")) return;
          const value = image.src.slice(image.src.indexOf(",") + 1);
          const svg = decodeURIComponent(value);
          const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
          const summary: Record<string, string> = {};
          const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const text of ["取消粗体", "新增粗体"]) {
              if (node.textContent?.includes(text)) summary[text] = (node.parentElement as HTMLElement).style.fontWeight;
            }
          }
          if (Object.keys(summary).length) state.boldExportWeights!.push(summary);
        });
        return image;
      },
    });
  });
  await openWorkbench(page);
  await importRichArticle(page, '<h1>加粗导出验证</h1><p><strong style="font-weight:700;color:#2457a7;background-color:#ffeebb">取消粗体</strong></p><p><span style="font-weight:400">新增粗体</span></p>', "加粗导出验证取消粗体新增粗体");
  await page.getByRole("button", { name: "基础样式", exact: true }).click();
  const editor = mainEditor(page), button = mainEditorPanel(page).locator('button[data-tooltip^="粗体"]');
  for (const text of ["取消粗体", "新增粗体"]) { await select(editor, text); await button.click(); }
  await expectCompletePreview(page, "取消粗体新增粗体");
  const preview = page.locator(".poster-grid .article-flow");
  expect((await weights(preview, ["取消粗体"]))["取消粗体"]).toBeLessThan(500);
  expect((await weights(preview, ["新增粗体"]))["新增粗体"]).toBeGreaterThanOrEqual(600);
  const textColor = await preview.evaluateAll((elements) => {
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes("取消粗体")) return getComputedStyle(node.parentElement!).color;
      }
    }
    return "missing";
  });
  expect(textColor).toBe("rgb(36, 87, 167)");
  const downloadPromise = page.waitForEvent("download", { timeout: 110_000 });
  await page.locator(".poster-grid .content-page .page-export").first().click();
  const download = await downloadPromise;
  const output = testInfo.outputPath("bold-export.png");
  await download.saveAs(output);
  const png = await readFile(output);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBe(1080);
  const snapshots = await page.evaluate(() => (window as Window & { boldExportWeights?: Record<string, string>[] }).boldExportWeights || []);
  expect(snapshots.some((snapshot) => Number(snapshot["取消粗体"]) < 500 && Number(snapshot["新增粗体"]) >= 600)).toBe(true);
  await testInfo.attach("bold-export", { path: output, contentType: "image/png" });
});
