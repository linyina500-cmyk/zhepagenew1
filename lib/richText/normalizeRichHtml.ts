import { meaningfulContentNode as meaningfulNode, normalizeContentSpacing } from "./contentNodes";

export const RICH_LAYOUT_CLASS = "imported-composite-visual";
export const INLINE_RUN_CLASS = "imported-inline-run";

export const RICH_TEXT_LIMITS = {
  htmlLength: 1_000_000,
  textLength: 30_000,
  elementCount: 2_500,
  depth: 64,
} as const;

export const IMAGE_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  count: 80,
} as const;

export function embeddedImageByteLength(src: string): number | null {
  const prefix = /^data:image\/(?:png|jpe?g|webp);base64,/i.exec(src);
  if (!prefix) return null;
  const encoded = src.slice(prefix[0].length);
  if (encoded.length % 4 || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) return null;
  return encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
}

export function imageLimitMessage(stats: { imageBytes: number; imageMaxBytes: number; imageCount: number }) {
  if (stats.imageMaxBytes > IMAGE_LIMITS.fileBytes) return "单张图片超过 10 MiB，请换用较小的图片";
  if (stats.imageBytes > IMAGE_LIMITS.totalBytes) return "内嵌图片总量超过 20 MiB，请减少图片或拆分文章";
  if (stats.imageCount > IMAGE_LIMITS.count) return "图片超过 80 张，请拆分文章后再导入";
  return "";
}

function imagePayloadStats(root: ParentNode) {
  let payloadLength = 0;
  let imageBytes = 0;
  let imageMaxBytes = 0;
  const images = [...root.querySelectorAll("img")];
  for (const image of images) {
    // Lazy sources are counted before sanitization as well as normal src.
    for (const attribute of ["src", "data-src"]) {
      const value = image.getAttribute(attribute) || "";
      const bytes = embeddedImageByteLength(value);
      if (bytes === null) continue;
      payloadLength += value.length;
      imageBytes += bytes;
      imageMaxBytes = Math.max(imageMaxBytes, bytes);
    }
  }
  return { payloadLength, imageBytes, imageMaxBytes, imageCount: images.length };
}

const STRUCTURAL_SELECTOR = "section,div,article,aside";
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "IMG", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "TABLE", "UL",
]);

function styleValue(style: string, property: string) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() || "";
}

function hasPaint(style: string, property: string) {
  const value = styleValue(style, property);
  return Boolean(value) && !/^(?:none|transparent|initial|inherit|unset|0(?:px)?)$/i.test(value);
}

function visualSignals(element: Element) {
  const style = element.getAttribute("style") || "";
  return {
    background: hasPaint(style, "background(?:-color)?"),
    border: hasPaint(style, "border(?:-(?:top|right|bottom|left))?"),
    gradient: /background(?:-image)?\s*:\s*(?:linear|radial)-gradient/i.test(style),
    layout: /display\s*:\s*(?:flex|inline-flex|grid|inline-grid)|grid-template|columns?\s*:/i.test(style),
    padding: hasPaint(style, "padding(?:-(?:top|right|bottom|left))?"),
    radius: hasPaint(style, "border-radius"),
    shadow: hasPaint(style, "box-shadow"),
  };
}

/**
 * Detects a designed rich-text group such as a KPI row, bordered company card
 * or CTA panel. Ordinary article wrappers are deliberately excluded so normal
 * paragraphs remain splittable.
 */
export function isRichLayoutGroup(element: Element) {
  if (!element.matches(STRUCTURAL_SELECTOR)) return false;
  const children = [...element.children].filter(meaningfulNode);
  const textLength = Array.from(element.textContent?.trim() || "").length;
  if (children.length < 2 || children.length > 24 || textLength > 1_800) return false;

  const own = visualSignals(element);
  const style = element.getAttribute("style") || "";
  const horizontalLayout = own.layout && !/flex-direction\s*:\s*column/i.test(style);
  const paragraphs = [...element.querySelectorAll("p")].filter((paragraph) => (
    !paragraph.closest("table,li,blockquote,figcaption") && Boolean(paragraph.textContent?.trim())
  ));
  const longParagraphs = paragraphs.filter((paragraph) => (paragraph.textContent?.trim().length || 0) >= 80);
  // Backgrounds and borders also commonly surround an entire AI-formatted
  // article. Keep its prose splittable, while retaining compact visual cards.
  if (element.tagName === "ARTICLE" || element.querySelector("h1") || longParagraphs.length >= 2) return false;
  if (!horizontalLayout && element.querySelectorAll("h2,h3,h4,h5,h6").length >= 2) return false;
  if (paragraphs.length >= 4 && paragraphs.some((paragraph) => (paragraph.textContent?.trim().length || 0) >= 32)) return false;

  const childSignals = children.map(visualSignals);
  const paintedChildren = childSignals.filter((signal) => (
    signal.background || signal.border || signal.gradient || signal.layout || signal.radius || signal.shadow
  )).length;
  const hasTableComposition = Boolean(element.querySelector("table")) && paragraphs.length <= 1 && children.length >= 2;
  const hasCallToAction = textLength <= 400 && Boolean(element.querySelector("a,button,img"));

  if (horizontalLayout && children.length >= 2) return true;
  if ((own.border || own.shadow) && children.length >= 2) return true;
  if (own.gradient && children.length >= 2) return true;
  if (hasTableComposition) return true;
  if (own.background && own.padding && hasCallToAction) return true;
  return own.padding && paintedChildren >= 2;
}

function normalizeTables(root: ParentNode, documentNode: Document) {
  root.querySelectorAll("table").forEach((table) => {
    const directRows = [...table.children].filter((child) => child.tagName === "TR");
    if (directRows.length) {
      const body = documentNode.createElement("tbody");
      directRows.forEach((row) => body.append(row));
      table.append(body);
    }
    table.querySelectorAll("tr").forEach((row) => {
      [...row.children].filter((child) => child.matches("td,th")).forEach((cell) => {
        if (!cell.childNodes.length) cell.append(documentNode.createElement("p"));
        [...cell.childNodes].forEach((node) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return;
          const paragraph = documentNode.createElement("p");
          paragraph.textContent = node.textContent;
          node.replaceWith(paragraph);
        });
      });
    });
  });
}

function wrapDirectInlineRuns(root: ParentNode, documentNode: Document) {
  [...root.querySelectorAll(STRUCTURAL_SELECTOR)].reverse().forEach((container) => {
    let run: Node[] = [];
    const flush = () => {
      if (!run.some(meaningfulNode)) {
        run.forEach((node) => node.parentNode?.removeChild(node));
        run = [];
        return;
      }
      const paragraph = documentNode.createElement("p");
      paragraph.className = INLINE_RUN_CLASS;
      paragraph.setAttribute("style", "margin:0;padding:0;font:inherit;color:inherit;line-height:inherit");
      run[0].parentNode?.insertBefore(paragraph, run[0]);
      run.forEach((node) => paragraph.append(node));
      run = [];
    };

    [...container.childNodes].forEach((node) => {
      const isBlock = node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName);
      if (isBlock) flush();
      else run.push(node);
    });
    flush();
  });
}

export function markRichLayoutGroups(root: ParentNode) {
  root.querySelectorAll(`.${RICH_LAYOUT_CLASS}`).forEach((element) => element.classList.remove(RICH_LAYOUT_CLASS));
  root.querySelectorAll(STRUCTURAL_SELECTOR).forEach((element) => {
    if (isRichLayoutGroup(element)) element.classList.add(RICH_LAYOUT_CLASS);
  });
}

export function normalizeRichHtmlDocument(documentNode: Document) {
  normalizeTables(documentNode.body, documentNode);
  normalizeContentSpacing(documentNode.body);
  wrapDirectInlineRuns(documentNode.body, documentNode);
  markRichLayoutGroups(documentNode.body);
  return documentNode;
}

export function richTextStats(root: ParentNode) {
  let elementCount = 0;
  let depth = 0;
  const stack = [...root.children].map((element) => ({ element, depth: 1 }));
  while (stack.length) {
    const current = stack.pop()!;
    elementCount += 1;
    depth = Math.max(depth, current.depth);
    for (const element of current.element.children) stack.push({ element, depth: current.depth + 1 });
  }
  return {
    textLength: Array.from(root.textContent || "").length,
    elementCount,
    depth,
  };
}

export function richTextHtmlLimitMessage(html: string) {
  if (html.length <= RICH_TEXT_LIMITS.htmlLength) return "";
  const message = "HTML 源码超过 100 万字符，请拆分文章后再导入";
  // Bound the entire input before parsing. Image bytes have a separate budget;
  // a screenshot's base64 is not a million characters of article markup.
  const maximum = RICH_TEXT_LIMITS.htmlLength + Math.ceil(IMAGE_LIMITS.totalBytes / 3) * 4 + IMAGE_LIMITS.count * 40;
  if (html.length > maximum) return "正文与内嵌图片总量过大，请减少图片或拆分文章";
  let payloadLength = 0;
  let imageBytes = 0;
  let imageMaxBytes = 0;
  let imageCount = 0;
  for (const match of html.matchAll(/data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/]*={0,2}/gi)) {
    const bytes = embeddedImageByteLength(match[0]);
    if (bytes === null) continue;
    payloadLength += match[0].length;
    imageBytes += bytes;
    imageMaxBytes = Math.max(imageMaxBytes, bytes);
    imageCount += 1;
  }
  // This is only a cheap preflight. After parsing, only actual img attributes
  // are exempted, so data-looking text or style attributes cannot bypass limits.
  return imageLimitMessage({ imageBytes, imageMaxBytes, imageCount })
    || (html.length - payloadLength > RICH_TEXT_LIMITS.htmlLength ? message : "");
}

export function richTextLimitMessage(html: string, root: ParentNode) {
  const htmlMessage = richTextHtmlLimitMessage(html);
  if (htmlMessage) return htmlMessage;
  const images = imagePayloadStats(root);
  const imageMessage = imageLimitMessage(images);
  if (imageMessage) return imageMessage;
  if (html.length - images.payloadLength > RICH_TEXT_LIMITS.htmlLength) return "HTML 源码超过 100 万字符，请拆分文章后再导入";
  const stats = richTextStats(root);
  if (stats.textLength > RICH_TEXT_LIMITS.textLength) return "正文超过 3 万字，请拆分文章后再导入";
  if (stats.elementCount > RICH_TEXT_LIMITS.elementCount) return "富文本节点超过 2500 个，请简化装饰或拆分文章后再导入";
  if (stats.depth > RICH_TEXT_LIMITS.depth) return "富文本嵌套超过 64 层，请简化装饰或改用纯文本粘贴";
  return "";
}
