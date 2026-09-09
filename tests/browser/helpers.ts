import { expect, type Locator, type Page } from "@playwright/test";
import { compactText } from "./fixtures";

export const mainEditor = (page: Page) => page.locator(".professional-editor:not(.compact) .tiptap-surface");
export const mainEditorPanel = (page: Page) => page.locator(".professional-editor:not(.compact)");

export async function openWorkbench(page: Page) {
  // Each Playwright test has a fresh context. Skip only the first-visit guide;
  // the actual draft is created and restored through the application's UI.
  await page.addInitScript(() => localStorage.setItem("zhepage-guide-seen-v1", "1"));
  await page.goto("/");
  await expect(mainEditor(page)).toBeVisible();
}

export async function pasteHtml(editor: Locator, html: string, text: string, replace = true) {
  await editor.click();
  if (replace) await editor.press("ControlOrMeta+A");
  await editor.evaluate((element, clipboard) => {
    const transfer = new DataTransfer();
    if (clipboard.html) transfer.setData("text/html", clipboard.html);
    transfer.setData("text/plain", clipboard.text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { html, text });
}

export async function pasteImage(editor: Locator, png: Buffer, name: string) {
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.evaluate((element, file) => {
    const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { base64: png.toString("base64"), name });
}

export async function openRichTextImport(page: Page) {
  await page.getByRole("button", { name: "＋ 一键导入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "一键导入并替换正文" });
  await dialog.getByRole("button", { name: "富文本", exact: true }).click();
  const editor = dialog.locator(".tiptap-surface");
  await expect(editor).toBeVisible();
  return { dialog, editor };
}

export async function importRichArticle(page: Page, html: string, text: string) {
  const { dialog, editor } = await openRichTextImport(page);
  await pasteHtml(editor, html, text);
  await expect.poll(async () => compactText(await editor.textContent() || ""), { message: "The import editor must receive the complete source text" }).toBe(compactText(text));
  await dialog.getByRole("button", { name: "导入并替换正文 →", exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function uploadImage(page: Page, panel: Locator, png: Buffer, name: string) {
  const chooserPromise = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "＋图片", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: "image/png", buffer: png });
}

export async function expectPreviewReady(page: Page) {
  await expect(page.locator(".poster-grid")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: /^批量导出 \d+ 张$/ })).toBeEnabled();
  await expect(page.locator(".poster-font-loading")).toHaveCount(0);
  const showAll = page.getByRole("button", { name: "查看全部页面", exact: true });
  if (await showAll.count()) await showAll.click();
  await expect(page.locator(".poster-grid .content-page").first()).toBeVisible();
}

export async function expectCompletePreview(page: Page, expectedBody: string) {
  await expectPreviewReady(page);
  await expect.poll(async () => compactText(await mainEditor(page).textContent() || ""), { message: "The main editor must preserve the source body" }).toBe(compactText(expectedBody));
  await expect.poll(async () => {
    const fragments = await page.locator(".poster-grid .article-flow").evaluateAll((flows) => flows.map((flow) => {
      const copy = flow.cloneNode(true) as HTMLElement;
      // Product-added cover and disclaimer are outside the imported body.
      copy.querySelectorAll(".first-page-lede,.risk-note").forEach((node) => node.remove());
      return copy.textContent || "";
    }));
    return compactText(fragments.join(""));
  }, { message: "All rendered pages must contain the original body exactly once and in order" }).toBe(compactText(expectedBody));
  const geometry = await page.locator(".poster-grid .article-viewport").evaluateAll((viewports) => viewports.map((viewport, pageIndex) => {
    const flow = viewport.querySelector<HTMLElement>(".article-flow")!;
    return {
      page: pageIndex + 1,
      overflowY: flow.scrollHeight - viewport.clientHeight,
      overflowX: flow.scrollWidth - viewport.clientWidth,
    };
  }));
  expect(geometry.filter((box) => box.overflowY > 2 || box.overflowX > 2), "No page may clip the user's article").toEqual([]);
}

export async function expectPreviewImage(page: Page, source: string, count = 1) {
  await expectPreviewReady(page);
  const images = page.locator(".poster-grid .article-flow img");
  await expect(images).toHaveCount(count);
  await expect.poll(() => images.evaluateAll((nodes, expectedSource) => nodes.some((node) => {
    const image = node as HTMLImageElement;
    return image.src === expectedSource && image.complete && image.naturalWidth > 0;
  }), source)).toBe(true);
}
