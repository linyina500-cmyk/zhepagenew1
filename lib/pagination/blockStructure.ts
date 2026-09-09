import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { meaningfulContentNode as meaningfulNode } from "../richText/contentNodes";

export const ATOMIC_SELECTOR = ".lead-magnet-card,.risk-note,.first-page-lede,.manual-empty-line";
const STRUCTURAL_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE"]);
export const GROUP_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE", "BLOCKQUOTE", "UL", "OL"]);

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

export function preserveWrapperShell(element: Element) {
  return Boolean(element.getAttribute("style")?.trim() || element.getAttribute("class")?.trim());
}

export type FragmentEdges = { start: boolean; end: boolean };

export function wrapperFragment(source: Element, child: Node, edges: FragmentEdges) {
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
