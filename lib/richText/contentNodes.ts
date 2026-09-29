export const VISUAL_CONTENT_SELECTOR = "img,table,hr";
export const EXPLICIT_SPACING_SELECTOR = ".manual-page-break,.manual-empty-line,br:not(.ProseMirror-trailingBreak)";

/** Empty editor paragraphs are authored space. The extra caret-support BR in
 * ProseMirror's live DOM is not part of the document and adds no extra line. */
export function normalizeContentSpacing(root: ParentNode) {
  root.querySelectorAll("br.ProseMirror-trailingBreak").forEach((lineBreak) => lineBreak.remove());
  root.querySelectorAll("p").forEach((paragraph) => {
    if (paragraph.classList.contains("manual-empty-line")
      && (paragraph.textContent?.trim() || paragraph.querySelector(VISUAL_CONTENT_SELECTOR))) {
      paragraph.classList.remove("manual-empty-line");
      if (!paragraph.className) paragraph.removeAttribute("class");
    }
    if (paragraph.textContent?.trim() || paragraph.matches(EXPLICIT_SPACING_SELECTOR)
      || paragraph.querySelector(`${VISUAL_CONTENT_SELECTOR},${EXPLICIT_SPACING_SELECTOR}`)
      || paragraph.hasAttribute("data-pagination-fragment")) return;
    // Whitespace-only marks carry no text, but their paragraph still occupies
    // one line. Reuse the same rendering contract as the explicit blank button.
    paragraph.replaceChildren();
    paragraph.classList.add("manual-empty-line");
  });
}

/** Shared by import normalization and pagination: empty formatting may be
 * cleaned up, but the user's images and explicit spacing are content. */
export function meaningfulContentNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return Boolean(element.textContent?.trim())
    || element.matches(`${VISUAL_CONTENT_SELECTOR},${EXPLICIT_SPACING_SELECTOR}`)
    || Boolean(element.querySelector(`${VISUAL_CONTENT_SELECTOR},${EXPLICIT_SPACING_SELECTOR}`))
    // A generated fragment can contain just the space separating two words.
    || element.hasAttribute("data-pagination-fragment") && Boolean(element.textContent);
}
