import { DOMParser as ProseMirrorDOMParser, Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { IMAGE_LIMITS } from "./normalizeRichHtml";

export const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/webp";
type Notice = (text: string, tone?: "success" | "error") => void;
const IMAGE_STYLE = "width:100%;height:auto;max-width:100%;display:block;margin-left:auto;margin-right:auto";

export function isTemporaryImageUrl(value: string) {
  return !value.trim() || /^(?:blob|file|filesystem|cid):/i.test(value.trim());
}

function matchClipboardImages(html: string, files: File[]) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const groups = new Map<string, HTMLImageElement[]>();
  [...parsed.images].forEach((image, index) => {
    const src = (image.getAttribute("src") || "").trim();
    if (!isTemporaryImageUrl(src)) return;
    // Repeated references to the same temporary URL represent the same file.
    // Missing URLs have no shared identity and must be matched separately.
    const key = src || `missing:${index}`;
    groups.set(key, [...(groups.get(key) || []), image]);
  });
  const error = "剪贴板临时图片与图片文件无法逐一对应，原内容已保留。请单独复制图片，或使用“插入图片”后再粘贴文字";
  if (!groups.size) throw new Error(error);
  const used = new Set<number>();
  const replacements: Array<{ image: HTMLImageElement; fileIndex: number }> = [];
  for (const images of groups.values()) {
    let fileIndex = 0;
    if (groups.size !== 1 || files.length !== 1) {
      const names = new Set(images.map((image) => image.alt.trim()).filter(Boolean));
      for (const image of images) {
        try {
          const url = new URL(image.getAttribute("src") || "");
          const basename = decodeURIComponent(url.pathname.split("/").at(-1) || "");
          if (basename) names.add(basename);
        } catch { /* A single image can still match the single supplied file. */ }
      }
      const matches = files.map((file, index) => names.has(file.name) ? index : -1).filter((index) => index >= 0);
      if (matches.length !== 1) throw new Error(error);
      fileIndex = matches[0];
    }
    if (used.has(fileIndex)) throw new Error(error);
    used.add(fileIndex);
    images.forEach((image) => replacements.push({ image, fileIndex }));
  }
  if (used.size !== files.length) throw new Error(error);
  return { parsed, replacements };
}

function imageMimeType(bytes: string) {
  if (bytes.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (bytes.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

function readImageFile(file: File, view: EditorView): Promise<string> {
  return new Promise((resolve, reject) => {
    const ownerWindow = view.dom.ownerDocument.defaultView;
    if (!ownerWindow) return reject(new Error("编辑器已关闭，请重新打开后插入图片"));
    const reader = new ownerWindow.FileReader();
    reader.onerror = () => reject(new Error(`图片“${file.name || "未命名"}”读取失败，请重新选择`));
    reader.onabort = () => reject(new Error("图片读取已取消，请重新选择"));
    reader.onload = () => {
      try {
        const result = typeof reader.result === "string" ? reader.result : "";
        const base64 = result.slice(result.indexOf(",") + 1);
        const mime = imageMimeType(ownerWindow.atob(base64.slice(0, 24)));
        if (!mime) throw new Error(`图片“${file.name || "未命名"}”不是有效的 PNG、JPG 或 WebP 文件`);
        // File names and declared MIME types can be missing or inaccurate in
        // clipboard files. Keep the bytes and use their actual image format.
        resolve(`data:${mime};base64,${base64}`);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("图片格式无法识别，请使用 PNG、JPG 或 WebP"));
      }
    };
    reader.readAsDataURL(file);
  });
}

/** Insert one upload/paste/drop batch at its original selection in one undo step. */
export async function insertImageFiles(view: EditorView, files: File[], onNotice: Notice, position?: number, clipboardHtml?: string): Promise<boolean> {
  if (!files.length || view.isDestroyed) return false;
  const initialState = view.state;
  try {
    if (!initialState.schema.nodes.image) throw new Error("当前编辑器不支持插入图片");
    if (files.length > IMAGE_LIMITS.count) throw new Error(`一次最多插入 ${IMAGE_LIMITS.count} 张图片，请分批选择`);
    let totalBytes = 0;
    for (const file of files) {
      if (!file.size) throw new Error(`图片“${file.name || "未命名"}”是空文件，请重新选择`);
      if (file.size > IMAGE_LIMITS.fileBytes) throw new Error(`图片“${file.name || "未命名"}”超过 ${IMAGE_LIMITS.fileBytes / 1024 / 1024} MiB，请选择较小的图片`);
      totalBytes += file.size;
    }
    if (totalBytes > IMAGE_LIMITS.totalBytes) throw new Error(`本次图片总量超过 ${IMAGE_LIMITS.totalBytes / 1024 / 1024} MiB，请减少图片或选择较小的文件`);
    if (position !== undefined && (!Number.isInteger(position) || position < 0 || position > initialState.doc.content.size)) {
      throw new Error("图片插入位置已失效，请在正文中重新选择位置");
    }
    const selection = position === undefined ? initialState.selection : Selection.near(initialState.doc.resolve(position));
    const clipboard = clipboardHtml === undefined ? null : matchClipboardImages(clipboardHtml, files);
    const sources = await Promise.all(files.map((file) => readImageFile(file, view)));
    if (view.isDestroyed) return false;
    if (view.state.doc !== initialState.doc) throw new Error("图片读取期间正文已更新，请在当前内容中重新插入图片");

    let slice: Slice;
    const imageNodes: ProseMirrorNode[] = [];
    if (clipboard) {
      clipboard.replacements.forEach(({ image, fileIndex }) => {
        image.setAttribute("src", sources[fileIndex]);
        image.removeAttribute("srcset");
      });
      const parser = view.someProp("clipboardParser") || view.someProp("domParser") || ProseMirrorDOMParser.fromSchema(initialState.schema);
      slice = parser.parseSlice(clipboard.parsed.body, { preserveWhitespace: true, context: selection.$from });
      slice.content.descendants((node) => { if (node.type.name === "image") imageNodes.push(node); });
      if (imageNodes.length !== clipboard.parsed.images.length) throw new Error("当前格式不能完整保留剪贴板图片，原内容已保留。请使用“插入图片”重试");
    } else {
      imageNodes.push(...sources.map((src, index) => initialState.schema.nodes.image.create({ src, alt: files[index].name, style: IMAGE_STYLE })));
      slice = new Slice(Fragment.fromArray(imageNodes), 0, 0);
    }
    const insertedNodes = new Set(imageNodes);
    const transaction = closeHistory(view.state.tr)
      .setSelection(selection)
      .replaceSelection(slice);
    if (clipboard) transaction.setMeta("paste", true).setMeta("uiEvent", "paste");
    const positions: number[] = [];
    transaction.doc.descendants((node, pos) => {
      if (insertedNodes.has(node)) positions.push(pos);
    });
    if (positions.length !== imageNodes.length) throw new Error("当前选中位置无法插入图片，请在正文段落中重试");
    if (!clipboard) transaction.setSelection(NodeSelection.create(transaction.doc, positions[positions.length - 1]));
    view.dispatch(transaction.scrollIntoView());
    // A content-limit filter may reject dispatch, while a trailing-paragraph
    // plugin may append to an accepted document. Check the actual image nodes.
    if (view.isDestroyed) return false;
    if (view.state.doc === initialState.doc || !positions.every((pos, index) => view.state.doc.nodeAt(pos)?.eq(imageNodes[index]))) {
      throw new Error("图片未插入，请检查正文或图片总量限制后重试");
    }
    view.dispatch(closeHistory(view.state.tr));
    view.focus();
    onNotice(clipboard ? `已粘贴富文本和 ${imageNodes.length} 张图片` : `已插入 ${files.length} 张图片，可继续调整尺寸、对齐、圆角和图注`, "success");
    return true;
  } catch (error) {
    if (!view.isDestroyed) onNotice(error instanceof Error ? error.message : "图片插入失败，请重新选择", "error");
    return false;
  }
}
