import { expect, test, type Locator } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { expectCompletePreview, expectFullEditorSelection, importRichArticle, mainEditor, mainEditorPanel, openWorkbench, pasteHtml } from "./helpers";

const beforeBlank = "空行前。";
const afterBlank = "空行后。";
const afterHardBreak = "换行后。";
const body = beforeBlank + afterBlank + afterHardBreak;
const bodyParagraphs = "p:not(.first-page-lede p):not(.risk-note p)";

async function moveCaret(editor: Locator, edge: "start" | "end") {
  // Cmd+Home/End on macOS can scroll without moving the editing caret.
  // Collapsing a full selection works in each supported desktop browser.
  await editor.press("ControlOrMeta+A");
  await expectFullEditorSelection(editor);
  await editor.press(edge === "start" ? "ArrowLeft" : "ArrowRight");
  // Native selectionchange reaches ProseMirror asynchronously in Chromium.
  // Await the caret before typing so this test does not edit a stale selection.
  await expect.poll(() => editor.evaluate((element, target) => {
    const { state } = (element as HTMLElement & { editor: Editor }).editor;
    return state.selection.empty && state.selection.from === (target === "start" ? 1 : state.doc.content.size - 1);
  }, edge)).toBe(true);
}

async function expectVisibleBreaks(surface: Locator) {
  const paragraphs = surface.locator(bodyParagraphs);
  await expect(paragraphs).toHaveText([beforeBlank, "", afterBlank + afterHardBreak]);
  await expect(paragraphs.nth(2).locator("br:not(.ProseMirror-trailingBreak)")).toHaveCount(1);

  // Read painted geometry as well as document structure: an empty paragraph
  // that survives in HTML but collapses in the preview is still a regression.
  const geometry = await surface.evaluate((element, selector) => {
    const [before, blank, after] = [...element.querySelectorAll<HTMLElement>(selector)];
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(after, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) textNodes.push(node as Text);
    }
    const characterRect = (node: Text, offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect();
    };
    const firstText = characterRect(textNodes[0], 0);
    const lastText = characterRect(textNodes.at(-1)!, textNodes.at(-1)!.length - 1);
    const beforeRect = before.getBoundingClientRect();
    const blankRect = blank.getBoundingClientRect();
    const afterRect = after.getBoundingClientRect();
    return {
      blankHeight: blankRect.height,
      textHeight: firstText.height,
      spaceBetweenParagraphs: afterRect.top - beforeRect.bottom,
      blankIsBetweenParagraphs: blankRect.top >= beforeRect.bottom - 1 && blankRect.bottom <= afterRect.top + 1,
      hardBreakLineDistance: lastText.top - firstText.top,
    };
  }, bodyParagraphs);
  expect(geometry.textHeight).toBeGreaterThan(0);
  expect(geometry.blankHeight, "Enter's empty paragraph must occupy a visible text line").toBeGreaterThanOrEqual(geometry.textHeight * 0.9);
  expect(geometry.blankIsBetweenParagraphs, "The empty line must remain between the authored paragraphs").toBe(true);
  expect(geometry.spaceBetweenParagraphs).toBeGreaterThanOrEqual(geometry.blankHeight - 1);
  expect(geometry.hardBreakLineDistance, "Shift+Enter must move the following text onto another painted line").toBeGreaterThan(geometry.textHeight * 0.8);
}

test("keyboard Enter spacing and Shift+Enter line breaks survive the editor and both previews", async ({ page }) => {
  await openWorkbench(page);
  const title = "手动换行回归";
  await importRichArticle(page, `<h1>${title}</h1><p>${beforeBlank}</p>`, title + beforeBlank);
  const editor = mainEditor(page);
  await editor.click();
  await moveCaret(editor, "end");
  await editor.press("Enter");
  await editor.press("Enter");
  await editor.pressSequentially(afterBlank);
  await editor.press("Shift+Enter");
  await editor.pressSequentially(afterHardBreak);
  await expectVisibleBreaks(editor);

  await expectCompletePreview(page, body);
  await expect(page.locator(".poster-grid .article-flow")).toHaveCount(1);
  await expectVisibleBreaks(page.locator(".poster-grid .article-flow"));

  await page.getByRole("button", { name: /一键自动排版/ }).click();
  for (const name of ["基础样式", "美化后"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expectCompletePreview(page, body);
    await expectVisibleBreaks(page.locator(".poster-grid .article-flow"));
  }
});

async function paintedLineCount(paragraph: Locator) {
  return paragraph.evaluate((element) => {
    const style = getComputedStyle(element);
    const innerHeight = (element as HTMLElement).offsetHeight
      - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
      - Number.parseFloat(style.borderTopWidth) - Number.parseFloat(style.borderBottomWidth);
    return innerHeight / Number.parseFloat(style.lineHeight);
  });
}

test("a trailing Shift+Enter paints its blank line before more text is entered", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, `<h1>段末换行</h1><p><strong>${beforeBlank}</strong></p>`, "段末换行" + beforeBlank);
  const editor = mainEditor(page);
  await editor.click();
  await moveCaret(editor, "end");
  for (let breaks = 1; breaks <= 2; breaks += 1) {
    await editor.press("Shift+Enter");
    await expect.poll(() => paintedLineCount(editor.locator("p").last())).toBeCloseTo(breaks + 1, 1);
    await expectCompletePreview(page, beforeBlank);
    for (const name of ["基础样式", "美化后"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expectCompletePreview(page, beforeBlank);
      await expect.poll(() => paintedLineCount(page.locator(".poster-grid .article-flow").locator(bodyParagraphs).last())).toBeCloseTo(breaks + 1, 1);
    }
    await editor.click();
    await moveCaret(editor, "end");
  }
  await editor.pressSequentially(afterHardBreak);
  await expectCompletePreview(page, beforeBlank + afterHardBreak);
  await expect.poll(() => paintedLineCount(page.locator(".poster-grid .article-flow").locator(bodyParagraphs).last())).toBeCloseTo(3, 1);
});

test("plain-text paste retains consecutive blank lines and supports complete undo and redo", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, `<h1>粘贴空行</h1><p>${beforeBlank}</p>`, "粘贴空行" + beforeBlank);
  const editor = mainEditor(page);
  const pasted = "\n粘贴首段。\n\n\n粘贴末段。\n";
  const paragraphs = ["", "粘贴首段。", "", "", "粘贴末段。", ""];
  await pasteHtml(editor, "", pasted);
  await expect(editor.locator("p")).toHaveText(paragraphs);
  await expectCompletePreview(page, pasted);
  await expect(page.locator(".poster-grid .article-flow").locator(bodyParagraphs)).toHaveText(paragraphs);

  await mainEditorPanel(page).locator('button[data-tooltip^="撤销上一步"]').click();
  await expect(editor.locator("p")).toHaveText([beforeBlank]);
  await expectCompletePreview(page, beforeBlank);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect(editor.locator("p")).toHaveText(paragraphs);
  await expectCompletePreview(page, pasted);
  await expect(page.locator(".poster-grid .article-flow").locator(bodyParagraphs)).toHaveText(paragraphs);
});

test("leading and trailing Enter paragraphs remain visible and follow keyboard undo and redo", async ({ page }) => {
  await openWorkbench(page);
  await importRichArticle(page, `<h1>首尾空行</h1><p>${beforeBlank}</p>`, "首尾空行" + beforeBlank);
  const editor = mainEditor(page);
  await editor.click();
  await moveCaret(editor, "start");
  await editor.press("Enter");
  await moveCaret(editor, "end");
  await editor.press("Enter");
  await editor.press("Enter");
  const expected = ["", beforeBlank, "", ""];
  await expect(editor.locator("p")).toHaveText(expected);
  await expectCompletePreview(page, beforeBlank);
  await expect(page.locator(".poster-grid .article-flow").locator(bodyParagraphs)).toHaveText(expected);
  const heights = await page.locator(".poster-grid .article-flow .manual-empty-line").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).offsetHeight));
  expect(heights).toHaveLength(3);
  expect(heights.every((height) => height > 20)).toBe(true);
  await editor.press("ControlOrMeta+Z");
  await expect(editor.locator("p")).not.toHaveText(expected);
  await mainEditorPanel(page).locator('button[data-tooltip^="重做，也可按"]').click();
  await expect(editor.locator("p")).toHaveText(expected);
  await expectCompletePreview(page, beforeBlank);
  await expect(page.locator(".poster-grid .article-flow").locator(bodyParagraphs)).toHaveText(expected);
});
