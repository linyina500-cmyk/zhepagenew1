import { measureParts } from "./measureBlock";
import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { articleBlocks, blockIsHeading, blockText, splitOversizedBlock } from "./splitDomBlock";
import type { PaginationResult } from "./paginationTypes";

const FIT_TOLERANCE = 2;
const INLINE_SEMANTIC_SELECTORS = ["strong", "b", "em", "i", "u", "s", "strike", "span[style]", "mark"];
const BLOCK_TEXT_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
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
  parsed.querySelectorAll(selector).forEach((element) => {
    const key = semanticAttributeKey(element);
    buckets.set(key, `${buckets.get(key) || ""}${element.textContent || ""}`);
  });
  return JSON.stringify([...buckets.entries()]
    .map(([key, value]) => [key, normalizeSemanticText(value)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function assertPaginationSemantics(sourceHtml: string, pages: string[]) {
  const source = semanticDocument(sourceHtml);
  const output = semanticDocument(pages.join(""));
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
      const pieces = splitOversizedBlock(
        block,
        measure,
        maxHeight,
        availableHeight,
        (piece) => fits([...current, piece]),
      );
      const firstPieceFits = pieces.length > 1 && fits([...current, pieces[0]]);
      const splitFollowerIsUseful = !blockIsHeading(current[current.length - 1])
        || blockText(pieces[0]).trim().length >= 18;
      if (firstPieceFits && splitFollowerIsUseful) {
        current.push(pieces[0]);
        commit();
        queue.unshift(...pieces.slice(1));
        continue;
      }

      // A styled wrapper can contain several normal paragraphs. Expose those
      // children to the queue before giving up on the remaining page space;
      // each child can then be split without losing its wrapper styles.
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

    const pieces = splitOversizedBlock(block, measure, maxHeight, maxHeight);
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
