import { measureParts } from "./measureBlock";
import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { TABLE_REPEAT_ATTRIBUTE, TABLE_SOURCE_ATTRIBUTE, articleBlocks, blockIsHeading, blockText, splitOversizedBlock, tableHeader } from "./splitDomBlock";
import type { PaginationResult } from "./paginationTypes";

const FIT_TOLERANCE = 2;
const INLINE_SEMANTIC_SELECTORS = ["strong", "b", "em", "i", "u", "s", "strike", "span[style]", "mark"];
const BLOCK_TEXT_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "COL", "COLGROUP", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

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

function semanticPlainText(parsed: Document) {
  const clone = parsed.body.cloneNode(true) as HTMLElement;
  const walker = parsed.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const formattingWhitespace: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (!text.data.trim()) {
      const previous = nearestMeaningfulSibling(text, "previousSibling");
      const next = nearestMeaningfulSibling(text, "nextSibling");
      const bordersBlock = [previous, next].some((sibling) => (
        sibling?.nodeType === Node.ELEMENT_NODE && BLOCK_TEXT_TAGS.has((sibling as Element).tagName)
      ));
      if (text.parentElement === clone || bordersBlock) formattingWhitespace.push(text);
    }
    current = walker.nextNode();
  }
  formattingWhitespace.forEach((text) => text.remove());
  return normalizeSemanticText(clone.textContent);
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
  const sourceText = semanticPlainText(source);
  if (!sourceText) return;
  const outputText = semanticPlainText(output);
  if (sourceText !== outputText) {
    let differenceAt = 0;
    while (differenceAt < sourceText.length && sourceText[differenceAt] === outputText[differenceAt]) differenceAt += 1;
    throw new Error(`分页保真检查失败：正文在第 ${differenceAt + 1} 字附近异常（源文 ${sourceText.length} 字 / 分页 ${outputText.length} 字）`);
  }
  INLINE_SEMANTIC_SELECTORS.forEach((selector) => {
    if (semanticBuckets(source, selector) !== semanticBuckets(output, selector)) {
      throw new Error(`分页保真检查失败：${selector} 的颜色或强调样式未完整继承`);
    }
  });
}

export function paginateArticle(html: string, measure: HTMLDivElement, maxHeight: number): PaginationResult {
  const pages: string[] = [];
  let current: string[] = [];
  const queue = articleBlocks(html);

  const heightOf = (parts: string[]) => measureParts(measure, parts);
  const fits = (parts: string[]) => heightOf(parts) <= maxHeight + FIT_TOLERANCE;
  const commit = () => {
    if (current.length) pages.push(current.join(""));
    current = [];
  };
  const fitCompositeVisual = (block: string) => {
    if (!new RegExp(`class=["'][^"']*${RICH_LAYOUT_CLASS}`).test(block)) return block;
    const parsed = new DOMParser().parseFromString(`<main>${block}</main>`, "text/html");
    const candidate = parsed.querySelector("main")?.firstElementChild;
    if (!candidate || !isRichLayoutGroup(candidate)) return block;
    const originalHeight = heightOf([block]);
    if (originalHeight <= maxHeight + FIT_TOLERANCE) return block;
    const scale = Math.min(0.98, (maxHeight - 8) / originalHeight);
    const fittedHeight = Math.min(maxHeight, Math.ceil(originalHeight * scale));
    const innerWidth = (100 / scale).toFixed(3);
    return `<div class="scaled-composite-visual" style="height:${fittedHeight}px"><div class="scaled-composite-visual-inner" style="width:${innerWidth}%;transform:scale(${scale.toFixed(4)})">${block}</div></div>`;
  };

  while (queue.length) {
    const block = queue.shift()!;
    if (/class=["'][^"']*manual-page-break/.test(block)) {
      commit();
      continue;
    }
    if (fits([...current, block])) {
      current.push(block);
      continue;
    }

    const fittedVisual = fitCompositeVisual(block);
    if (fittedVisual !== block) {
      commit();
      current.push(fittedVisual);
      commit();
      continue;
    }

    if (current.length) {
      const availableHeight = Math.max(1, maxHeight - heightOf(current));
      // Measure the first fragment together with the content already on the
      // page. Measuring it alone loses collapsed margins and can incorrectly
      // move a splittable paragraph to the next page, leaving a large hole.
      const { pieces, splitAtPageBoundary } = splitOversizedBlock(
        block,
        measure,
        maxHeight,
        availableHeight,
        (piece) => fits([...current, piece]),
      );
      // Exposing child paragraphs is not a page break. Keep packing them in
      // order instead of committing a mostly empty page after the first child.
      if (pieces.length > 1 && !splitAtPageBoundary) {
        queue.unshift(...pieces);
        continue;
      }
      const firstPieceFits = pieces.length > 1 && fits([...current, pieces[0]]);
      const splitFollowerIsUseful = !blockIsHeading(current[current.length - 1])
        || blockText(pieces[0]).trim().length >= 18;
      if (firstPieceFits && splitFollowerIsUseful) {
        current.push(pieces[0]);
        commit();
        queue.unshift(...pieces.slice(1));
        continue;
      }

      // A measured fragment may be unsuitable after a heading or wrapper.
      // Retry its smaller pieces in order before abandoning the page space.
      if (pieces.length > 1) {
        queue.unshift(...pieces);
        continue;
      }

      // Move a trailing heading only when it leaves content on the old page.
      // A heading already alone on a fresh page cannot move any farther:
      // retrying it with the same unsplittable follower would loop forever.
      if (current.length > 1 && blockIsHeading(current[current.length - 1])) {
        const heading = current.pop()!;
        commit();
        queue.unshift(heading, block);
        continue;
      }

      commit();
      queue.unshift(block);
      continue;
    }

    const { pieces } = splitOversizedBlock(block, measure, maxHeight, maxHeight);
    if (!pieces.length) continue;
    if (pieces.length > 1) {
      queue.unshift(...pieces);
      continue;
    }
    current.push(block);
    commit();
  }

  commit();
  const normalizedPages = pages.length ? pages : ["<p>暂无正文内容</p>"];
  assertPaginationSemantics(html, normalizedPages);
  const usage = normalizedPages.map((page) => Math.min(1.5, heightOf([page]) / maxHeight));
  measure.innerHTML = "";
  return { pages: normalizedPages, usage };
}
