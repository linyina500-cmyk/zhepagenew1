import { expect, test, type Locator } from "@playwright/test";
import { expectCompletePreview, importRichArticle, mainEditor, openWorkbench } from "./helpers";

const beforeBlank = "空行前。";
const afterBlank = "空行后。";
const afterHardBreak = "换行后。";
const body = beforeBlank + afterBlank + afterHardBreak;
const bodyParagraphs = "p:not(.first-page-lede p):not(.risk-note p)";

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
  await editor.press("ControlOrMeta+End");
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
