import { measureHtml } from "./measureBlock";
import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";

const ATOMIC_SELECTOR = ".lead-magnet-card,.risk-note,.first-page-lede,.manual-empty-line";
const STRUCTURAL_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE"]);
const GROUP_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE", "BLOCKQUOTE", "UL", "OL"]);
const VISUAL_CONTENT_SELECTOR = "img,table,hr";
export const TABLE_SOURCE_ATTRIBUTE = "data-pagination-table";
export const TABLE_REPEAT_ATTRIBUTE = "data-pagination-table-repeat";

function meaningfulNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return Boolean(element.textContent?.trim())
    || element.classList.contains("manual-page-break")
    || element.matches(VISUAL_CONTENT_SELECTOR)
    || Boolean(element.querySelector(VISUAL_CONTENT_SELECTOR));
}

function hasVisiblePaint(style: string, property: string) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  if (!match) return false;
  return !/^(?:none|transparent|initial|inherit|unset|0(?:px)?)\s*$/i.test(match[1].trim());
}

export function hasVisualContainerStyle(element: Element) {
  if (element.matches(ATOMIC_SELECTOR)) return true;
  if (element.classList.contains(RICH_LAYOUT_CLASS)) return isRichLayoutGroup(element);
  if (!STRUCTURAL_TAGS.has(element.tagName)) return false;

  const style = element.getAttribute("style") || "";
  const layout = /display\s*:\s*(?:flex|inline-flex|grid|inline-grid)|grid-template|columns?\s*:/i.test(style);
  const background = hasVisiblePaint(style, "background(?:-color)?");
  const border = hasVisiblePaint(style, "border(?:-(?:top|right|bottom|left))?");
  const shadow = hasVisiblePaint(style, "box-shadow");
  const radius = hasVisiblePaint(style, "border-radius");
  const positioned = /position\s*:\s*(?:absolute|relative)/i.test(style)
    && /(?:top|right|bottom|left)\s*:/i.test(style);
  const visualChildren = [...element.children].filter((child) => meaningfulNode(child)).length;

  // Color, alignment and spacing are inheritable/presentational and do not make
  // an otherwise ordinary wrapper an indivisible card.
  return layout || positioned || shadow || background || (border || radius) && visualChildren > 0;
}

function preserveWrapperShell(element: Element) {
  return Boolean(element.getAttribute("style")?.trim() || element.getAttribute("class")?.trim());
}

type FragmentEdges = { start: boolean; end: boolean };

function wrapperFragment(source: Element, child: Node, edges: FragmentEdges) {
  const shell = source.cloneNode(false) as HTMLElement;
  shell.append(child);
  const previous = source.getAttribute("data-pagination-wrapper");
  const start = edges.start && previous !== "middle" && previous !== "end";
  const end = edges.end && previous !== "middle" && previous !== "start";
  if (start && end) return shell;
  shell.setAttribute("data-pagination-wrapper", start ? "start" : end ? "end" : "middle");
  for (const side of ["top", "bottom"] as const) {
    if (side === "top" ? start : end) continue;
    // Keep horizontal spacing and paint, but do not duplicate the article's
    // outer vertical padding/margins for every exposed child paragraph.
    shell.style.setProperty(`margin-${side}`, "0", "important");
    shell.style.setProperty(`padding-${side}`, "0", "important");
    shell.style.setProperty(`border-${side}-width`, "0", "important");
    shell.style.setProperty(`border-${side}-left-radius`, "0", "important");
    shell.style.setProperty(`border-${side}-right-radius`, "0", "important");
  }
  return shell;
}

function exposeManualPageBreaks(element: Element): Node[] {
  if (element.classList.contains("manual-page-break") || !element.querySelector(".manual-page-break")) return [element];
  const pieces: Node[] = [];
  let fragment = element.ownerDocument.createDocumentFragment();
  const flush = () => {
    if ([...fragment.childNodes].some((node) => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim())) {
      const shell = element.cloneNode(false) as Element;
      shell.append(fragment);
      pieces.push(shell);
    }
    fragment = element.ownerDocument.createDocumentFragment();
  };
  for (const child of [...element.childNodes]) {
    const children = child.nodeType === Node.ELEMENT_NODE ? exposeManualPageBreaks(child as Element) : [child];
    for (const piece of children) {
      if (piece.nodeType === Node.ELEMENT_NODE && (piece as Element).classList.contains("manual-page-break")) {
        flush();
        pieces.push(piece);
      } else fragment.append(piece);
    }
  }
  flush();
  return pieces;
}

export function articleBlocks(html: string) {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const root = parsed.querySelector("main")!;
  // These identifiers belong to this pagination run, never to imported HTML.
  root.querySelectorAll(`[${TABLE_REPEAT_ATTRIBUTE}]`).forEach((element) => element.removeAttribute(TABLE_REPEAT_ATTRIBUTE));
  root.querySelectorAll("table").forEach((table, index) => table.setAttribute(TABLE_SOURCE_ATTRIBUTE, String(index)));
  // Manual breaks take precedence over painted/atomic wrappers. Lift only the
  // marker while keeping the complete ancestor shells on both sides of it.
  for (const child of [...root.children]) {
    if (child.querySelector(".manual-page-break")) child.replaceWith(...exposeManualPageBreaks(child));
  }
  let changed = true;
  while (changed) {
    changed = false;
    [...root.querySelectorAll("section,div,article,main,aside")].reverse().forEach((element) => {
      if (element === root || element.hasAttribute("data-pagination-shell")) return;
      if (element.closest(ATOMIC_SELECTOR)) return;
      const richLayoutAncestor = element.parentElement?.closest(`.${RICH_LAYOUT_CLASS}`);
      if (richLayoutAncestor && isRichLayoutGroup(richLayoutAncestor)) return;
      if (element.classList.contains("manual-page-break") || hasVisualContainerStyle(element)) return;
      const nodes = [...element.childNodes].filter(meaningfulNode);
      if (!nodes.length) {
        element.remove();
        changed = true;
        return;
      }
      const replacements = nodes.map((node, index) => {
        if (!preserveWrapperShell(element)) return node.cloneNode(true);
        const shell = wrapperFragment(element, node.cloneNode(true), { start: index === 0, end: index === nodes.length - 1 });
        shell.setAttribute("data-pagination-shell", "true");
        return shell;
      });
      element.replaceWith(...replacements);
      changed = true;
    });
  }
  return [...root.childNodes]
    .filter(meaningfulNode)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const paragraph = parsed.createElement("p");
        paragraph.textContent = node.textContent;
        return paragraph.outerHTML;
      }
      const clone = node.cloneNode(true) as Element;
      clone.removeAttribute("data-pagination-shell");
      return clone.outerHTML;
    });
}

export function tableHeader(table: Element) {
  const explicitHead = table.querySelector(":scope > thead");
  if (explicitHead) return explicitHead.cloneNode(true) as Element;
  const firstRow = table.querySelector(":scope > tbody > tr, :scope > tr");
  if (!firstRow?.children.length || ![...firstRow.children].every((cell) => cell.tagName === "TH")) return null;
  const head = table.ownerDocument.createElement("thead");
  head.append(firstRow.cloneNode(true));
  return head;
}

export function splitTableToPages(
  table: Element,
  parsed: Document,
  measure: HTMLDivElement,
  maxHeight: number,
  firstMaxHeight = maxHeight,
  firstPieceFits?: (html: string) => boolean,
  wrap: (element: Element, edges: FragmentEdges) => Element = (element) => element,
) {
  let rows = [...table.querySelectorAll(":scope > tbody > tr, :scope > tr")];
  const caption = table.querySelector(":scope > caption")?.cloneNode(true) as Element | undefined;
  const colgroup = table.querySelector(":scope > colgroup")?.cloneNode(true) as Element | undefined;
  const head = tableHeader(table);
  const foot = table.querySelector(":scope > tfoot")?.cloneNode(true) as Element | undefined;
  if (head && !table.querySelector(":scope > thead")) rows = rows.slice(1);
  if (!rows.length || rows.length === 1 && !foot) return [table.outerHTML];

  const buildTable = (bodyRows: Element[], includeFoot: boolean, continuation: boolean) => {
    const nextTable = table.cloneNode(false) as Element;
    const appendHeading = (element: Element | null | undefined) => {
      if (!element) return;
      const clone = element.cloneNode(true) as Element;
      if (continuation) clone.setAttribute(TABLE_REPEAT_ATTRIBUTE, "true");
      nextTable.append(clone);
    };
    appendHeading(caption);
    if (colgroup) nextTable.append(colgroup.cloneNode(true));
    appendHeading(head);
    const body = parsed.createElement("tbody");
    bodyRows.forEach((row) => body.append(row.cloneNode(true)));
    nextTable.append(body);
    if (includeFoot && foot) nextTable.append(foot.cloneNode(true));
    return nextTable;
  };
  const pieces: string[] = [];
  let chunkRows: Element[] = [];
  const fitsTable = (candidate: Element, end: boolean) => {
    const wrapped = wrap(candidate, { start: pieces.length === 0, end });
    return pieces.length === 0 && firstPieceFits
      ? firstPieceFits(wrapped.outerHTML)
      : measureHtml(measure, wrapped.outerHTML) <= (pieces.length ? maxHeight : firstMaxHeight) + 2;
  };
  let index = 0;
  while (index < rows.length) {
    const isLastRow = index === rows.length - 1;
    const candidate = buildTable([...chunkRows, rows[index]], isLastRow, pieces.length > 0);
    if (fitsTable(candidate, isLastRow)) {
      chunkRows.push(rows[index]);
      index += 1;
      continue;
    }
    if (isLastRow && foot) {
      const rowsWithoutFoot = buildTable([...chunkRows, rows[index]], false, pieces.length > 0);
      if (fitsTable(rowsWithoutFoot, false)) {
        // Keep all fitting body rows together before moving only the footer.
        pieces.push(rowsWithoutFoot.outerHTML, buildTable([], true, true).outerHTML);
        chunkRows = [];
        index += 1;
        continue;
      }
    }
    if (chunkRows.length) {
      pieces.push(buildTable(chunkRows, false, pieces.length > 0).outerHTML);
      chunkRows = [];
      // Retry this row on the next page, including its actual wrapper edges.
    } else {
      if (!pieces.length && firstPieceFits) {
        // No complete row fits beside existing content. Let the paginator retry
        // the original table on a fresh page without losing or duplicating rows.
        return [table.outerHTML];
      }
      // A single row is indivisible. Preserve it when it exceeds an entire page.
      pieces.push(candidate.outerHTML);
      index += 1;
    }
  }
  if (chunkRows.length) pieces.push(buildTable(chunkRows, true, pieces.length > 0).outerHTML);
  return pieces;
}

function collectTextNodes(root: Element) {
  const nodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function cloneTextRange(source: Element, start: number, end: number) {
  if (end <= start) return null;
  // Range.cloneContents() omits inline ancestors when a range begins inside
  // <strong>, <span style>, <mark>, etc. Clone the full DOM first and trim
  // text nodes by global offsets so every continuation keeps the complete
  // ancestor chain and therefore its color, emphasis and highlight styles.
  const shell = source.cloneNode(true) as Element;
  const nodes = collectTextNodes(shell);
  let traversed = 0;
  nodes.forEach((node) => {
    const nodeStart = traversed;
    const nodeEnd = nodeStart + node.data.length;
    traversed = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) {
      node.remove();
      return;
    }
    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(node.data.length, end - nodeStart);
    node.data = node.data.slice(localStart, localEnd);
  });
  const keptTextNodes = collectTextNodes(shell).filter((node) => node.data.length > 0);
  shell.querySelectorAll("br").forEach((lineBreak) => {
    const hasTextBefore = keptTextNodes.some((node) => Boolean(node.compareDocumentPosition(lineBreak) & Node.DOCUMENT_POSITION_FOLLOWING));
    const hasTextAfter = keptTextNodes.some((node) => Boolean(node.compareDocumentPosition(lineBreak) & Node.DOCUMENT_POSITION_PRECEDING));
    if (!hasTextBefore || !hasTextAfter) lineBreak.remove();
  });
  [...shell.querySelectorAll("*")].reverse().forEach((element) => {
    const hasText = Boolean(element.textContent);
    const hasVisual = element.matches(`${VISUAL_CONTENT_SELECTOR},br`) || Boolean(element.querySelector(`${VISUAL_CONTENT_SELECTOR},br`));
    if (!hasText && !hasVisual) element.remove();
  });
  return shell;
}

function semanticCut(text: string, start: number, maximum: number) {
  const minimum = Math.max(start + 12, maximum - Math.min(24, Math.floor((maximum - start) * 0.15)));
  for (let index = maximum; index >= minimum; index -= 1) {
    if (/[。！？；.!?;：:\n]/.test(text[index - 1] || "")) return index;
  }
  for (let index = maximum; index >= minimum; index -= 1) {
    if (/[,，、\s]/.test(text[index - 1] || "")) return index;
  }
  return maximum;
}

function splitTextPreservingDom(
  source: Element,
  measure: HTMLDivElement,
  pageHeight: number,
  firstHeight: number,
  firstPieceFits?: (html: string) => boolean,
  wrap: (element: Element, edges: FragmentEdges) => Element = (element) => element,
) {
  const text = collectTextNodes(source).map((node) => node.data).join("");
  if (text.length < 2) return [source.cloneNode(true) as Element];
  const pieces: Element[] = [];
  let start = 0;
  let limit = firstHeight;
  const originalPosition = source.getAttribute("data-pagination-fragment");
  const cloneFragment = (from: number, to: number) => {
    const fragment = cloneTextRange(source, from, to);
    if (!fragment) return null;
    const startsOriginal = from === 0 && originalPosition !== "middle" && originalPosition !== "end";
    const endsOriginal = to === text.length && originalPosition !== "middle" && originalPosition !== "start";
    // Probe the same attributes that will be rendered. Continuation labels can
    // change height, and a fragment of a continuation cannot become a new start.
    if (!startsOriginal || !endsOriginal) {
      fragment.setAttribute("data-pagination-fragment", startsOriginal ? "start" : endsOriginal ? "end" : "middle");
    }
    return fragment;
  };

  while (start < text.length) {
    const remainder = cloneFragment(start, text.length);
    if (!remainder) break;
    const fitsCurrentLimit = (candidate: Element, end: number) => {
      const wrapped = wrap(candidate, { start: start === 0, end: end === text.length });
      return pieces.length === 0 && firstPieceFits
        ? firstPieceFits(wrapped.outerHTML)
        : measureHtml(measure, wrapped.outerHTML) <= limit + 2;
    };
    if (fitsCurrentLimit(remainder, text.length)) {
      pieces.push(remainder);
      break;
    }

    let low = start + 1;
    let high = text.length - 1;
    let best = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = cloneFragment(start, middle);
      if (candidate && fitsCurrentLimit(candidate, middle)) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }

    if (best <= start) {
      if (!pieces.length) return [source.cloneNode(true) as Element];
      pieces.push(remainder);
      break;
    }
    const cut = semanticCut(text, start, best);
    const piece = cloneFragment(start, cut) || cloneFragment(start, best);
    if (!piece) break;
    pieces.push(piece);
    start = cut > start ? cut : best;
    limit = pageHeight;
  }
  return pieces.length ? pieces : [source.cloneNode(true) as Element];
}

export type BlockSplit = { pieces: string[]; splitAtPageBoundary: boolean };

export function splitOversizedBlock(
  html: string,
  measure?: HTMLDivElement,
  maxHeight?: number,
  firstMaxHeight?: number,
  firstPieceFits?: (html: string) => boolean,
): BlockSplit {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const element = parsed.querySelector("main")?.firstElementChild;
  if (!element) return { pieces: [html], splitAtPageBoundary: false };

  type ElementSplit = { pieces: Element[]; splitAtPageBoundary: boolean };
  const splitElement = (
    source: Element,
    wrap: (element: Element, edges: FragmentEdges) => Element = (element) => element,
  ): ElementSplit => {
    const unchanged = () => ({ pieces: [source.cloneNode(true) as Element], splitAtPageBoundary: false });
    const isVerifiedComposite = source.classList.contains(RICH_LAYOUT_CLASS) && isRichLayoutGroup(source);
    if (source.classList.contains(RICH_LAYOUT_CLASS) && !isVerifiedComposite) source.classList.remove(RICH_LAYOUT_CLASS);
    if (source.matches(`${ATOMIC_SELECTOR},h1,h2,h3`) || isVerifiedComposite) return unchanged();

    if (source.matches("img,hr") || !GROUP_TAGS.has(source.tagName) && source.querySelector(VISUAL_CONTENT_SELECTOR)) return unchanged();

    if (source.tagName === "TABLE" && measure && maxHeight) {
      return {
        pieces: splitTableToPages(source, parsed, measure, maxHeight, Math.max(1, firstMaxHeight ?? maxHeight), firstPieceFits, wrap).map((piece) => (
          new DOMParser().parseFromString(`<main>${piece}</main>`, "text/html").querySelector("main")!.firstElementChild!
        )),
        splitAtPageBoundary: true,
      };
    }

    const nodes = [...source.childNodes].filter(meaningfulNode);
    if (!nodes.length) return { pieces: [], splitAtPageBoundary: false };
    if (GROUP_TAGS.has(source.tagName) && nodes.length > 1) {
      return {
        pieces: nodes.map((node, index) => wrapperFragment(source, node.cloneNode(true), { start: index === 0, end: index === nodes.length - 1 })),
        splitAtPageBoundary: false,
      };
    }
    if (GROUP_TAGS.has(source.tagName) && nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE) {
      const inner = nodes[0] as Element;
      const isAtomicInner = inner.matches(`${ATOMIC_SELECTOR},h1,h2,h3,img,hr`)
        || inner.classList.contains(RICH_LAYOUT_CLASS) && isRichLayoutGroup(inner);
      if (isAtomicInner) return unchanged();
      // Every fit probe must include the complete ancestor chain: padding and
      // narrowed line width can make a bare inner paragraph look much smaller.
      const result = splitElement(inner, (piece, edges) => wrap(wrapperFragment(source, piece.cloneNode(true), edges), edges));
      return {
        pieces: result.pieces.map((piece, index) => wrapperFragment(source, piece, { start: index === 0, end: index === result.pieces.length - 1 })),
        splitAtPageBoundary: result.splitAtPageBoundary,
      };
    }

    if (measure && maxHeight) {
      return {
        pieces: splitTextPreservingDom(source, measure, maxHeight, Math.max(1, firstMaxHeight ?? maxHeight), firstPieceFits, wrap),
        splitAtPageBoundary: true,
      };
    }
    return unchanged();
  };

  const result = splitElement(element);
  return { ...result, pieces: result.pieces.map((piece) => piece.outerHTML) };
}

export function blockIsHeading(html: string) {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const element = parsed.querySelector("main")?.firstElementChild;
  if (!element) return false;
  if (element.matches("h1,h2,h3")) return true;
  const visible = [...element.children].filter((child) => meaningfulNode(child));
  return visible.length === 1 && visible[0].matches("h1,h2,h3") && !(element.textContent || "").replace(visible[0].textContent || "", "").trim();
}

export function blockText(html: string) {
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}
