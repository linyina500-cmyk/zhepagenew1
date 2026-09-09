import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Mark } from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";
import { IMAGE_LIMITS, RICH_TEXT_LIMITS, embeddedImageByteLength, imageLimitMessage, normalizeRichHtmlDocument, richTextHtmlLimitMessage, richTextLimitMessage } from "./normalizeRichHtml";
import { insertImageFiles } from "./editorImages";

type Notice = (text: string, tone?: "success" | "error") => void;

export function preparePastedHtml(html: string) {
  const sourceLimit = richTextHtmlLimitMessage(html);
  if (sourceLimit) throw new Error(sourceLimit);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const inputLimit = richTextLimitMessage(html, parsed.body);
  if (inputLimit) throw new Error(inputLimit);
  parsed.body.querySelectorAll<HTMLElement>("*").forEach((element) => {
    if (!element.hasAttribute("style")) return;
    for (const property of ["font-size", "line-height", "font-family", "letter-spacing"]) element.style.removeProperty(property);
    if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
  });
  parsed.body.querySelectorAll("img").forEach((image) => {
    if (!image.getAttribute("src") && image.getAttribute("data-src")) image.setAttribute("src", image.getAttribute("data-src")!);
    image.removeAttribute("data-src");
  });
  normalizeRichHtmlDocument(parsed);
  const normalized = parsed.body.innerHTML;
  const outputLimit = richTextLimitMessage(normalized, parsed.body);
  if (outputLimit) throw new Error(outputLimit);
  return normalized;
}

export function createPasteHandlers(onNotice: Notice): EditorProps {
  let prepared: { source: string; html: string } | null = null;
  let rejected = false;
  const report = (error: unknown) => {
    rejected = true;
    onNotice(`未粘贴：${error instanceof Error ? error.message : "富文本读取失败，请检查内容"}`, "error");
  };
  const transferFiles = (transfer: DataTransfer | null) => {
    const files = Array.from(transfer?.files || []);
    if (files.length) return files;
    return Array.from(transfer?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  };
  return {
    // ProseMirror's handlePaste runs AFTER HTML parsing. Guard the native event
    // first so excessive markup never enters its schema parser.
    handleDOMEvents: {
      paste: (view, event) => {
        prepared = null;
        rejected = false;
        try {
          const html = event.clipboardData?.getData("text/html") || "";
          const text = event.clipboardData?.getData("text/plain") || "";
          const files = transferFiles(event.clipboardData);
          // Rich HTML can contain both text and images. Let its normal parser
          // preserve the whole selection instead of also inserting file copies.
          if (!html && files.length) {
            event.preventDefault();
            void insertImageFiles(view, files, onNotice);
            return true;
          }
          if (text.length > RICH_TEXT_LIMITS.textLength * 2 || Array.from(text).length > RICH_TEXT_LIMITS.textLength) throw new Error("正文超过 3 万字，请拆分文章后再导入");
          if (html) prepared = { source: html, html: preparePastedHtml(html) };
          return false;
        } catch (error) {
          event.preventDefault();
          report(error);
          return true;
        }
      },
      drop: (view, event) => {
        // ProseMirror owns moves of existing document content. External files
        // use the same validation and insertion path as the upload button.
        if (view.dragging) return false;
        const files = transferFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImageFiles(view, files, onNotice, position);
        return true;
      },
    },
    transformPastedHTML: (html) => {
      rejected = false;
      try {
        return prepared?.source === html ? prepared.html : preparePastedHtml(html);
      } catch (error) {
        report(error);
        return "";
      } finally {
        prepared = null;
      }
    },
    // Programmatic pasteHTML can bypass the DOM event. Keep a rejected paste
    // from deleting the current selection when its transformed slice is empty.
    handlePaste: () => {
      const wasRejected = rejected;
      rejected = false;
      return wasRejected;
    },
  };
}

function editorDocumentStats(doc: ProseMirrorNode) {
  let textLength = 0;
  let elementCount = 0;
  let payloadLength = 0;
  let imageBytes = 0;
  let imageMaxBytes = 0;
  let imageCount = 0;
  let maxDepth = 0;
  const stack = [{ node: doc, depth: 0, marks: [] as readonly Mark[] }];
  while (stack.length) {
    const { node, depth, marks } = stack.pop()!;
    if (node.isText) {
      textLength += Array.from(node.text || "").length;
    } else if (depth) elementCount += 1;
    elementCount += marks.length;
    maxDepth = Math.max(maxDepth, depth - (node.isText ? 1 : 0));
    payloadLength += node.text?.length || 0;
    if (node.type.name === "image") imageCount += 1;
    for (const attrs of [node.attrs, ...marks.map((mark) => mark.attrs)]) {
      for (const [key, value] of Object.entries(attrs)) {
        if (typeof value !== "string") continue;
        const bytes = attrs === node.attrs && node.type.name === "image" && key === "src" ? embeddedImageByteLength(value) : null;
        if (bytes !== null) {
          imageBytes += bytes;
          imageMaxBytes = Math.max(imageMaxBytes, bytes);
        } else payloadLength += value.length;
      }
    }
    let previousMarks: readonly Mark[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      let shared = 0;
      // Adjacent text runs share open marks in ProseMirror's DOMSerializer.
      // Count a spanning strong/span once, even when an inner mark changes.
      while (shared < previousMarks.length && shared < child.marks.length
        && child.marks[shared].eq(previousMarks[shared]) && child.marks[shared].type.spec.spanning !== false) shared += 1;
      stack.push({ node: child, depth: depth + 1 + child.marks.length, marks: child.marks.slice(shared) });
      previousMarks = child.marks;
    }
  }
  return { textLength, elementCount, depth: maxDepth, htmlLength: payloadLength, imageBytes, imageMaxBytes, imageCount };
}

function documentLimitMessage(stats: ReturnType<typeof editorDocumentStats>) {
  const imageMessage = imageLimitMessage(stats);
  if (imageMessage) return imageMessage;
  if (stats.textLength > RICH_TEXT_LIMITS.textLength) return "正文总量超过 3 万字，请拆分文章后再编辑";
  if (stats.elementCount > RICH_TEXT_LIMITS.elementCount) return "富文本节点总量超过 2500 个，请简化装饰或拆分文章";
  if (stats.depth > RICH_TEXT_LIMITS.depth) return "富文本嵌套过深，请简化包装后再导入";
  if (stats.htmlLength > RICH_TEXT_LIMITS.htmlLength) return "正文与样式总量超过 100 万字符，请简化包装或拆分文章";
  return "";
}

export function createContentLimitExtension(onNotice: Notice) {
  return Extension.create({
    name: "richTextContentLimit",
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction, state) {
          // Imports were already checked before updating the parent preview.
          // Do not reject its matching editor update due to schema-added marks.
          if (!transaction.docChanged || transaction.getMeta("richTextExternalContent")) return true;
          const stats = editorDocumentStats(transaction.doc);
          const message = documentLimitMessage(stats);
          if (!message) return true;
          const previous = editorDocumentStats(state.doc);
          const limits = { ...RICH_TEXT_LIMITS, imageBytes: IMAGE_LIMITS.totalBytes, imageMaxBytes: IMAGE_LIMITS.fileBytes, imageCount: IMAGE_LIMITS.count };
          const keys = Object.keys(stats) as (keyof typeof stats)[];
          // A restored oversized draft must still support gradual deletion and
          // undo, provided the edit reduces an exceeded limit without worsening others.
          if (keys.every((key) => stats[key] <= Math.max(previous[key], limits[key]))
            && keys.some((key) => previous[key] > limits[key] && stats[key] < previous[key])) return true;
          // Report outside the dispatch stack; the editor's previous document
          // and selection remain intact when a transaction is rejected.
          queueMicrotask(() => onNotice(`未修改：${message}`, "error"));
          return false;
        },
      })];
    },
  });
}
