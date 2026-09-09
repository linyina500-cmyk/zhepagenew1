export const VISUAL_CONTENT_SELECTOR = "img,table,hr";
export const EXPLICIT_SPACING_SELECTOR = ".manual-page-break,.manual-empty-line";

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
