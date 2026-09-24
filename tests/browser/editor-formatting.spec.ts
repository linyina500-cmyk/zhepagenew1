import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expectCompletePreview, importRichArticle, mainEditor, mainEditorPanel, openWorkbench } from "./helpers";

const selectedText = "重点文字";
const body = `前文${selectedText}后文。`;

async function selectText(editor: Locator, text = selectedText) {
  await editor.evaluate((element, text) => {
    const current = (element as HTMLElement & { editor: Editor }).editor;
    let found = false;
    current.state.doc.descendants((node, position) => {
      if (found || !node.isText || !node.text?.includes(text)) return;
      const start = position + node.text.indexOf(text);
      current.chain().focus().setTextSelection({ from: start, to: start + text.length }).run();
      found = true;
    });
    if (!found) throw new Error(`未找到测试选区：${text}`);
  }, text);
}

async function colorPanel(page: Page, label: "字色" | "高亮") {
  await mainEditorPanel(page).getByRole("button", { name: new RegExp(`^${label}`) }).click();
  const panel = page.getByRole("dialog", { name: "统一颜色面板" });
  await expect(panel).toBeVisible();
  return panel;
}

async function textColor(surface: Locator) {
  return surface.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes(text)) return getComputedStyle(node.parentElement!).color;
    }
    return "missing";
  }, selectedText);
}

test("selected text keeps bold, color and both highlight styles through the toolbar and preview", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, `<h1>文字装饰回归</h1><p>${body}</p>`, "文字装饰回归" + body);
  const editor = mainEditor(page), toolbar = mainEditorPanel(page);
  await selectText(editor);
  await toolbar.locator('button[data-tooltip^="粗体"]').click();
  await toolbar.locator('button[data-tooltip^="斜体"]').click();
  await toolbar.locator('button[data-tooltip^="下划线"]').click();
  await toolbar.locator('button[data-tooltip^="删除线"]').click();
  for (const selector of ["strong", "em", "u", "s"]) await expect(editor.locator(selector)).toHaveText(selectedText);

  let picker = await colorPanel(page, "字色");
  await picker.getByRole("textbox", { name: "十六进制颜色值" }).fill("2457a7");
  await picker.getByRole("button", { name: "应用到文字", exact: true }).click();
  await expect.poll(() => textColor(editor)).toBe("rgb(36, 87, 167)");
  await expectCompletePreview(page, body);
  await expect.poll(() => textColor(page.locator(".poster-grid .article-flow"))).toBe("rgb(36, 87, 167)");

  for (const [name, type] of [["实色块", "block"], ["标记笔", "marker"]]) {
    await selectText(editor);
    picker = await colorPanel(page, "高亮");
    await picker.getByRole("radio", { name: new RegExp(name) }).click();
    await picker.getByRole("textbox", { name: "十六进制颜色值" }).fill("ffd66b");
    await picker.getByRole("button", { name: "应用到高亮", exact: true }).click();
    await expect(editor.locator("mark")).toHaveAttribute("data-highlight-style", type);
    await expect(editor.locator("mark")).toHaveText(selectedText);
    await expectCompletePreview(page, body);
    await expect(page.locator(".poster-grid .article-flow mark")).toHaveAttribute("data-highlight-style", type);
  }

  await selectText(editor);
  await toolbar.locator('button[data-tooltip^="清除选中文字"]').click();
  await expect(editor.locator("strong,em,u,s,mark")).toHaveCount(0);
  await expectCompletePreview(page, body);
  await expect(page.locator(".poster-grid .article-flow strong,.poster-grid .article-flow em,.poster-grid .article-flow u,.poster-grid .article-flow s,.poster-grid .article-flow mark").filter({ hasText: selectedText })).toHaveCount(0);
  await toolbar.locator('button[data-tooltip^="撤销上一步"]').click();
  await expect(editor.locator("mark")).toHaveAttribute("data-highlight-style", "marker");
  await expectCompletePreview(page, body);
});

test("imported text color can be changed and cleared without losing text or selection", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, `<h1>导入字色回归</h1><p>前文<span style="color:#cc2244;background-color:#f7e8b3">${selectedText}</span>后文。</p>`, "导入字色回归" + body);
  const editor = mainEditor(page);
  await selectText(editor);
  let picker = await colorPanel(page, "字色");
  await expect(picker.getByRole("textbox", { name: "十六进制颜色值" })).toHaveValue("cc2244");
  await picker.getByRole("textbox", { name: "十六进制颜色值" }).fill("2457a7");
  await picker.getByRole("button", { name: "应用到文字", exact: true }).click();
  await expect.poll(() => textColor(editor)).toBe("rgb(36, 87, 167)");
  await expectCompletePreview(page, body);
  await expect.poll(() => textColor(page.locator(".poster-grid .article-flow"))).toBe("rgb(36, 87, 167)");

  await selectText(editor);
  picker = await colorPanel(page, "字色");
  await picker.getByRole("button", { name: "清除颜色", exact: true }).click();
  await expect.poll(() => textColor(editor)).not.toBe("rgb(36, 87, 167)");
  await expect.poll(() => textColor(editor)).not.toBe("rgb(204, 34, 68)");
  await expect(editor.locator('span[style*="background-color"]').filter({ hasText: selectedText }).first()).toHaveCSS("background-color", "rgb(247, 232, 179)");
  await expectCompletePreview(page, body);
});
