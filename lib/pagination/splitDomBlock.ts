import { measureHtml } from "./measureBlock";
import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";

const ATOMIC_SELECTOR = ".lead-magnet-card,.risk-note,.first-page-lede,.manual-empty-line";
const STRUCTURAL_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE"]);
const GROUP_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE", "BLOCKQUOTE", "UL", "OL"]);
const VISUAL_CONTENT_SELECTOR = "img,table,hr";

function meaningfulNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return Boolean(element.textContent?.trim())
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

export function articleBlocks(html: string) {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const root = parsed.querySelector("main")!;
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
      const replacements = nodes.map((node) => {
        if (!preserveWrapperShell(element)) return node.cloneNode(true);
        const shell = element.cloneNode(false) as Element;
        shell.setAttribute("data-pagination-shell", "true");
        shell.append(node.cloneNode(true));
        return shell;
      });
      element.replaceWith(...replacements);
      changed = true;
    });
  }
  return [...root.childNodes]
    .filter(meaningfulNode)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return `<p>${node.textContent || ""}</p>`;
      const clone = node.cloneNode(true) as Element;
      clone.removeAttribute("data-pagination-shell");
      return clone.outerHTML;
    });
}

export function splitTableToPages(table: Element, parsed: Document, measure: HTMLDivElement, maxHeight: number) {
  let rows = [...table.querySelectorAll(":scope > tbody > tr, :scope > tr")];
  if (rows.length <= 1) return [table.outerHTML];
  const caption = table.querySelector(":scope > caption")?.cloneNode(true) as Element | undefined;
  const colgroup = table.querySelector(":scope > colgroup")?.cloneNode(true) as Element | undefined;
  let head = table.querySelector(":scope > thead")?.cloneNode(true) as Element | undefined;
  const foot = table.querySelector(":scope > tfoot")?.cloneNode(true) as Element | undefined;
  if (!head && rows[0]?.children.length && [...rows[0].children].every((cell) => cell.tagName === "TH")) {
    head = parsed.createElement("thead");
    head.append(rows[0].cloneNode(true));
    rows = rows.slice(1);
  }

  const buildTable = (bodyRows: Element[], includeFoot = false) => {
    const nextTable = table.cloneNode(false) as Element;
    if (caption) nextTable.append(caption.cloneNode(true));
    if (colgroup) nextTable.append(colgroup.cloneNode(true));
    if (head) nextTable.append(head.cloneNode(true));
    const body = parsed.createElement("tbody");
    bodyRows.forEach((row) => body.append(row.cloneNode(true)));
    nextTable.append(body);
    if (includeFoot && foot) nextTable.append(foot.cloneNode(true));
    return nextTable.outerHTML;
  };
  const pieces: string[] = [];
  let chunkRows: Element[] = [];
  rows.forEach((row, index) => {
    const candidate = buildTable([...chunkRows, row], index === rows.length - 1);
    if (chunkRows.length && measureHtml(measure, candidate) > maxHeight) {
      pieces.push(buildTable(chunkRows));
      chunkRows = [row];
    } else chunkRows.push(row);
  });
  if (chunkRows.length) pieces.push(buildTable(chunkRows, true));
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
  const minimum = Math.max(start + 12, maximum - 90);
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
) {
  const text = collectTextNodes(source).map((node) => node.data).join("");
  if (text.length < 2) return [source.cloneNode(true) as Element];
  const pieces: Element[] = [];
  let start = 0;
  let limit = firstHeight;

  while (start < text.length) {
    const remainder = cloneTextRange(source, start, text.length);
    if (!remainder) break;
    const fitsCurrentLimit = (candidate: Element) => pieces.length === 0 && firstPieceFits
      ? firstPieceFits(candidate.outerHTML)
      : measureHtml(measure, candidate.outerHTML) <= limit + 2;
    if (fitsCurrentLimit(remainder)) {
      pieces.push(remainder);
      break;
    }

    let low = start + 1;
    let high = text.length - 1;
    let best = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = cloneTextRange(source, start, middle);
      if (candidate && fitsCurrentLimit(candidate)) {
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
    const piece = cloneTextRange(source, start, cut) || cloneTextRange(source, start, best);
    if (!piece) break;
    pieces.push(piece);
    start = cut > start ? cut : best;
    limit = pageHeight;
  }
  if (pieces.length > 1) {
    pieces.forEach((piece, index) => {
      const position = index === 0 ? "start" : index === pieces.length - 1 ? "end" : "middle";
      piece.setAttribute("data-pagination-fragment", position);
    });
  }
  return pieces.length ? pieces : [source.cloneNode(true) as Element];
}

export function splitOversizedBlock(
  html: string,
  measure?: HTMLDivElement,
  maxHeight?: number,
  firstMaxHeight?: number,
  firstPieceFits?: (html: string) => boolean,
): string[] {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const element = parsed.querySelector("main")?.firstElementChild;
  if (!element) return [html];

  const splitElement = (source: Element): Element[] => {
    const isVerifiedComposite = source.classList.contains(RICH_LAYOUT_CLASS) && isRichLayoutGroup(source);
    if (source.classList.contains(RICH_LAYOUT_CLASS) && !isVerifiedComposite) source.classList.remove(RICH_LAYOUT_CLASS);
    if (source.matches(`${ATOMIC_SELECTOR},h1,h2,h3`) || isVerifiedComposite) return [source.cloneNode(true) as Element];

    if (source.matches("img,hr") || !GROUP_TAGS.has(source.tagName) && source.querySelector(VISUAL_CONTENT_SELECTOR)) {
      return [source.cloneNode(true) as Element];
    }

    if (source.tagName === "TABLE" && measure && maxHeight) {
      return splitTableToPages(source, parsed, measure, maxHeight).map((piece) => (
        new DOMParser().parseFromString(`<main>${piece}</main>`, "text/html").querySelector("main")!.firstElementChild!
      ));
    }

    const nodes = [...source.childNodes].filter(meaningfulNode);
    if (!nodes.length) return [];
    if (GROUP_TAGS.has(source.tagName) && nodes.length > 1) {
      return nodes.map((node) => {
        const shell = source.cloneNode(false) as Element;
        shell.append(node.cloneNode(true));
        return shell;
      });
    }
    if (GROUP_TAGS.has(source.tagName) && nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE) {
      const inner = nodes[0] as Element;
      const isAtomicInner = inner.matches(`${ATOMIC_SELECTOR},h1,h2,h3,img,hr`)
        || inner.classList.contains(RICH_LAYOUT_CLASS) && isRichLayoutGroup(inner);
      if (isAtomicInner) return [source.cloneNode(true) as Element];
      const innerPieces = splitElement(inner);
      if (innerPieces.length > 1) return innerPieces.map((piece) => {
        const shell = source.cloneNode(false) as Element;
        shell.append(piece);
        return shell;
      });
    }

    if (measure && maxHeight) {
      return splitTextPreservingDom(
        source,
        measure,
        maxHeight,
        Math.max(1, firstMaxHeight ?? maxHeight),
        firstPieceFits,
      );
    }
    return [source.cloneNode(true) as Element];
  };

  return splitElement(element).map((piece) => piece.outerHTML);
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
