import { measureHtml } from "./measureBlock";
import { VISUAL_CONTENT_SELECTOR } from "../richText/contentNodes";
import type { FragmentEdges } from "./blockStructure";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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

function semanticCut(text: string, start: number, maximum: number, boundaries: Set<number>) {
  const minimum = Math.max(start + 12, maximum - Math.min(24, Math.floor((maximum - start) * 0.15)));
  for (let index = maximum; index >= minimum; index -= 1) {
    if (boundaries.has(index) && /[。！？；.!?;：:\n]/.test(text[index - 1] || "")) return index;
  }
  for (let index = maximum; index >= minimum; index -= 1) {
    if (boundaries.has(index) && /[,，、\s]/.test(text[index - 1] || "")) return index;
  }
  return maximum;
}

export function splitTextPreservingDom(
  source: Element,
  measure: HTMLDivElement,
  pageHeight: number,
  firstHeight: number,
  firstPieceFits?: (html: string) => boolean,
  wrap: (element: Element, edges: FragmentEdges) => Element = (element) => element,
) {
  const text = collectTextNodes(source).map((node) => node.data).join("");
  if (text.length < 2) return [source.cloneNode(true) as Element];
  // Probe visible character boundaries, never individual UTF-16 code units.
  // This preserves surrogate pairs, combining marks, flags and joined emoji.
  const boundaries = [...graphemeSegmenter.segment(text)].map(({ index }) => index);
  boundaries.push(text.length);
  const boundarySet = new Set(boundaries);
  const pieces: Element[] = [];
  let start = 0;
  let startIndex = 0;
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

    let low = startIndex + 1;
    let high = boundaries.length - 2;
    let best = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = boundaries[middle];
      const candidate = cloneFragment(start, end);
      if (candidate && fitsCurrentLimit(candidate, end)) {
        best = end;
        low = middle + 1;
      } else high = middle - 1;
    }

    if (best <= start) {
      if (!pieces.length) return [source.cloneNode(true) as Element];
      pieces.push(remainder);
      break;
    }
    const cut = semanticCut(text, start, best, boundarySet);
    const piece = cloneFragment(start, cut) || cloneFragment(start, best);
    if (!piece) break;
    pieces.push(piece);
    start = cut > start ? cut : best;
    while (boundaries[startIndex] < start) startIndex += 1;
    limit = pageHeight;
  }
  return pieces.length ? pieces : [source.cloneNode(true) as Element];
}
