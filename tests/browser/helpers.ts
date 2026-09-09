import { expect, type Locator, type Page } from "@playwright/test";
import { compactText } from "./fixtures";

export const mainEditor = (page: Page) => page.locator(".professional-editor:not(.compact) .tiptap-surface");
export const mainEditorPanel = (page: Page) => page.locator(".professional-editor:not(.compact)");

type ClipboardPayload = { html?: string; text?: string; file?: { base64: string; name: string } };

// This function is serialized by Locator.evaluate, so keep its browser-side
// dependencies inside it. Both text and image paste use the actual DOM event.
function dispatchClipboardPaste(element: Element, payload: ClipboardPayload) {
  const transfer = new DataTransfer();
  if (payload.html) transfer.setData("text/html", payload.html);
  if (payload.text !== undefined) transfer.setData("text/plain", payload.text);
  if (payload.file) {
    const bytes = Uint8Array.from(atob(payload.file.base64), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], payload.file.name, { type: "image/png" }));
  }
  const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  // Firefox can ignore the constructor's clipboardData (Mozilla bug 2027025).
  // Preserve the real DataTransfer for the editor's normal paste handlers.
  if (event.clipboardData !== transfer) Object.defineProperty(event, "clipboardData", { value: transfer });
  const actual = event.clipboardData;
  if (!actual || actual.getData("text/html") !== (payload.html || "") || actual.getData("text/plain") !== (payload.text || "")) {
    throw new Error("Synthetic paste setup failed: ClipboardEvent did not preserve the supplied HTML/plain text.");
  }
  const expectedFiles = [...transfer.files];
  const actualFiles = [...actual.files];
  if (expectedFiles.length !== (payload.file ? 1 : 0) || actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("Synthetic paste setup failed: ClipboardEvent did not preserve the supplied image files.");
  }
  element.dispatchEvent(event);
}

export async function openWorkbench(page: Page) {
  // Each Playwright test has a fresh context. Skip only the first-visit guide;
  // the actual draft is created and restored through the application's UI.
  await page.addInitScript(() => localStorage.setItem("zhepage-guide-seen-v1", "1"));
  await page.goto("/");
  await expect(mainEditor(page)).toBeVisible();
}

export async function expectFullEditorSelection(editor: Locator) {
  const selection = await editor.evaluate((element) => {
    const current = element.ownerDocument.getSelection();
    const path = (node: Node | null) => {
      const indices: number[] = [];
      while (node && node !== element) {
        const parent = node.parentNode;
        if (!parent) return null;
        indices.unshift([...parent.childNodes].indexOf(node as ChildNode));
        node = parent;
      }
      return node === element ? indices : null;
    };
    return {
      focused: element.ownerDocument.activeElement === element,
      collapsed: current?.isCollapsed ?? true,
      anchor: path(current?.anchorNode || null),
      anchorOffset: current?.anchorOffset,
      focus: path(current?.focusNode || null),
      focusOffset: current?.focusOffset,
      selectedText: current?.rangeCount ? current.getRangeAt(0).cloneContents().textContent : null,
      editorText: element.textContent,
    };
  });
  expect(selection, "Replacing the article requires the editor's complete DOM selection").toMatchObject({
    focused: true, collapsed: false, selectedText: selection.editorText,
  });
  expect(selection.anchor, "The selection anchor must belong to the editor").not.toBeNull();
  expect(selection.focus, "The selection focus must belong to the editor").not.toBeNull();
  return selection;
}

export async function pasteHtmlAtSelection(editor: Locator, html: string, text: string) {
  await editor.evaluate(dispatchClipboardPaste, { html, text });
}

export async function pasteHtml(editor: Locator, html: string, text: string, replace = true) {
  await editor.click();
  if (replace) await editor.press("ControlOrMeta+A");
  const selection = replace ? await expectFullEditorSelection(editor) : undefined;
  await pasteHtmlAtSelection(editor, html, text);
  return selection;
}

export async function pasteImage(editor: Locator, png: Buffer, name: string) {
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.evaluate(dispatchClipboardPaste, { file: { base64: png.toString("base64"), name } });
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
  // CSS tooltip text participates in the button's accessible name. Use the
  // existing tooltip attribute to identify the actual upload control.
  await panel.locator('button[data-tooltip^="插入 PNG、JPG 或 WebP 图片"]').click();
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
