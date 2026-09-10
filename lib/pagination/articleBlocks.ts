import { RICH_LAYOUT_CLASS, isRichLayoutGroup } from "../richText/normalizeRichHtml";
import { meaningfulContentNode as meaningfulNode, normalizeContentSpacing } from "../richText/contentNodes";
import { ATOMIC_SELECTOR, hasVisualContainerStyle, preserveWrapperShell, wrapperFragment } from "./blockStructure";
import { TABLE_REPEAT_ATTRIBUTE, TABLE_SOURCE_ATTRIBUTE } from "./splitTable";

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
  normalizeContentSpacing(root);
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
