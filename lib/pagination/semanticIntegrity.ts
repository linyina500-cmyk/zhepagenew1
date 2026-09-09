import { TABLE_REPEAT_ATTRIBUTE, TABLE_SOURCE_ATTRIBUTE, tableHeader } from "./splitTable";

const INLINE_SEMANTIC_SELECTORS = ["strong", "b", "em", "i", "u", "s", "strike", "span[style]", "mark"];
const BLOCK_TEXT_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "COL", "COLGROUP", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const BLOCK_TEXT_SELECTOR = [...BLOCK_TEXT_TAGS].map((tag) => tag.toLowerCase()).join(",");

function semanticDocument(html: string) {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  parsed.querySelectorAll(".manual-page-break").forEach((element) => element.remove());
  return parsed;
}

function normalizeSemanticText(value: string | null) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function nearestMeaningfulSibling(node: Node, direction: "previousSibling" | "nextSibling") {
  let sibling = node[direction];
  while (sibling?.nodeType === Node.TEXT_NODE && !sibling.textContent?.trim()) sibling = sibling[direction];
  return sibling;
}

function removeFormattingWhitespace(parsed: Document) {
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
  const formattingWhitespace: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (!text.data.trim()) {
      // A blank imported paragraph is layout, not a space inside a sentence.
      // A generated continuation can be the original space between two words.
      const generatedFragment = text.parentElement?.closest("[data-pagination-fragment]");
      const block = text.parentElement?.closest(BLOCK_TEXT_SELECTOR);
      const emptyBlock = block && !block.textContent?.trim();
      const previous = nearestMeaningfulSibling(text, "previousSibling");
      const next = nearestMeaningfulSibling(text, "nextSibling");
      const bordersBlock = [previous, next].some((sibling) => (
        sibling?.nodeType === Node.ELEMENT_NODE && BLOCK_TEXT_TAGS.has((sibling as Element).tagName)
      ));
      if (!generatedFragment && (emptyBlock || text.parentElement === parsed.body || bordersBlock)) {
        formattingWhitespace.push(text);
      }
    }
    current = walker.nextNode();
  }
  formattingWhitespace.forEach((text) => text.remove());
}

function semanticPlainText(parsed: Document) {
  return normalizeSemanticText(parsed.body.textContent);
}

function semanticMedia(parsed: Document) {
  const media: Array<[string, number, string]> = [];
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let precedingText = "";
  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) precedingText += current.textContent || "";
    else {
      const element = current as Element;
      if (element.matches("img,hr,.manual-empty-line")) {
        const attributes = element.tagName === "IMG"
          ? JSON.stringify([...element.attributes].map(({ name, value }) => [name, value]).sort(([left], [right]) => left.localeCompare(right)))
          : "";
        media.push([element.tagName, normalizeSemanticText(precedingText).length, attributes]);
      }
    }
    current = walker.nextNode();
  }
  return JSON.stringify(media);
}

function semanticAttributeKey(element: Element) {
  const style = (element.getAttribute("style") || "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .sort()
    .join(";");
  const className = [...element.classList].sort().join(" ");
  return [
    element.tagName.toLowerCase(),
    className,
    style,
    element.getAttribute("data-color") || "",
    element.getAttribute("data-highlight-style") || "",
  ].join("|");
}

function semanticBuckets(parsed: Document, selector: string) {
  const buckets = new Map<string, string>();
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    // Compare text runs in document order at each active style depth. Whole
    // ancestor textContent duplicates nested spans and reorders that duplicate
    // text across pages. Retain the nesting count: opacity/em sizes can stack.
    const depths = new Map<string, number>();
    let ancestor = textNode.parentElement;
    while (ancestor) {
      if (ancestor.matches(selector)) {
        const key = semanticAttributeKey(ancestor);
        depths.set(key, (depths.get(key) || 0) + 1);
      }
      ancestor = ancestor.parentElement;
    }
    for (const [style, depth] of depths) {
      const key = JSON.stringify([style, depth]);
      buckets.set(key, `${buckets.get(key) || ""}${textNode.textContent || ""}`);
    }
    textNode = walker.nextNode();
  }
  return JSON.stringify([...buckets.entries()]
    .map(([key, value]) => [key, normalizeSemanticText(value)])
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function assertPaginationSemantics(sourceHtml: string, pages: string[]) {
  const source = semanticDocument(sourceHtml);
  const output = semanticDocument(pages.join(""));
  const sourceTables = [...source.querySelectorAll("table")];
  output.querySelectorAll(`[${TABLE_REPEAT_ATTRIBUTE}]`).forEach((element) => {
    const table = element.parentElement;
    const sourceIndex = table?.getAttribute(TABLE_SOURCE_ATTRIBUTE) || "";
    const sourceTable = /^\d+$/.test(sourceIndex) ? sourceTables[Number(sourceIndex)] : undefined;
    const original = sourceTable && (element.tagName === "THEAD"
      ? tableHeader(sourceTable)
      : element.tagName === "CAPTION" ? sourceTable.querySelector(":scope > caption") : null);
    const clone = element.cloneNode(true) as Element;
    clone.removeAttribute(TABLE_REPEAT_ATTRIBUTE);
    // Only exact copies of this table's own header/caption may repeat. A
    // marker on arbitrary content or on an altered header must still fail.
    if (table?.tagName !== "TABLE" || !original || clone.outerHTML !== original.outerHTML) {
      throw new Error("分页保真检查失败：续表表头或标题与原表不一致");
    }
    element.remove();
  });
  // Text, style and image checks share the same interpretation of formatting
  // whitespace, so cleaning up an empty span cannot fail a different check.
  removeFormattingWhitespace(source);
  removeFormattingWhitespace(output);
  const sourceText = semanticPlainText(source);
  const outputText = semanticPlainText(output);
  if (sourceText !== outputText) {
    let differenceAt = 0;
    while (differenceAt < sourceText.length && sourceText[differenceAt] === outputText[differenceAt]) differenceAt += 1;
    throw new Error(`分页保真检查失败：正文在第 ${differenceAt + 1} 字附近异常（源文 ${sourceText.length} 字 / 分页 ${outputText.length} 字）`);
  }
  if (semanticMedia(source) !== semanticMedia(output)) {
    throw new Error("分页保真检查失败：图片、分隔线或手动空行的内容与位置发生变化");
  }
  INLINE_SEMANTIC_SELECTORS.forEach((selector) => {
    if (semanticBuckets(source, selector) !== semanticBuckets(output, selector)) {
      throw new Error(`分页保真检查失败：${selector} 的颜色或强调样式未完整继承`);
    }
  });
}
