import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { meaningfulContentNode as meaningfulNode, VISUAL_CONTENT_SELECTOR } from "../richText/contentNodes";
import { ATOMIC_SELECTOR, GROUP_TAGS, wrapperFragment, type FragmentEdges } from "./blockStructure";
import { splitTableToPages } from "./splitTable";
import { splitTextPreservingDom } from "./splitText";

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
