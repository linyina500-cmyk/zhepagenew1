// Match html-to-image's font discovery so cached CSS covers every font that
// the current page embeds, including fonts selected by individual components.
export function usedFontFamilies(node: HTMLElement): string[] {
  const fonts = new Set<string>();
  function visit(element: HTMLElement) {
    const family = element.style.fontFamily || getComputedStyle(element).fontFamily;
    for (const font of family.split(",")) fonts.add(font.trim().replace(/["']/g, ""));
    for (const child of Array.from(element.children)) {
      if (child instanceof HTMLElement) visit(child);
    }
  }
  visit(node);
  return [...fonts].sort();
}
