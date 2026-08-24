export const RICH_LAYOUT_CLASS = "imported-composite-visual";
export const INLINE_RUN_CLASS = "imported-inline-run";

export const RICH_TEXT_LIMITS = {
  htmlLength: 1_000_000,
  textLength: 30_000,
  elementCount: 2_500,
} as const;

const STRUCTURAL_SELECTOR = "section,div,article,aside";
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER",
  "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "IMG", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "TABLE", "UL",
]);

function meaningfulNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return Boolean(node.textContent?.trim());
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return Boolean(element.textContent?.trim()) || element.matches("img,table,hr") || Boolean(element.querySelector("img,table,hr"));
}

function styleValue(style: string, property: string) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() || "";
}

function hasPaint(style: string, property: string) {
  const value = styleValue(style, property);
  return Boolean(value) && !/^(?:none|transparent|initial|inherit|unset|0(?:px)?)$/i.test(value);
}

function visualSignals(element: Element) {
  const style = element.getAttribute("style") || "";
  return {
    background: hasPaint(style, "background(?:-color)?"),
    border: hasPaint(style, "border(?:-(?:top|right|bottom|left))?"),
    gradient: /background(?:-image)?\s*:\s*(?:linear|radial)-gradient/i.test(style),
    layout: /display\s*:\s*(?:flex|inline-flex|grid|inline-grid)|grid-template|columns?\s*:/i.test(style),
    padding: hasPaint(style, "padding(?:-(?:top|right|bottom|left))?"),
    radius: hasPaint(style, "border-radius"),
    shadow: hasPaint(style, "box-shadow"),
  };
}

/**
 * Detects a designed rich-text group such as a KPI row, bordered company card
 * or CTA panel. Ordinary article wrappers are deliberately excluded so normal
 * paragraphs remain splittable.
 */
export function isRichLayoutGroup(element: Element) {
  if (!element.matches(STRUCTURAL_SELECTOR)) return false;
  const children = [...element.children].filter(meaningfulNode);
  const textLength = Array.from(element.textContent?.trim() || "").length;
  if (children.length < 2 || children.length > 24 || textLength > 1_800) return false;

  const own = visualSignals(element);
  const childSignals = children.map(visualSignals);
  const paintedChildren = childSignals.filter((signal) => (
    signal.background || signal.border || signal.gradient || signal.layout || signal.radius || signal.shadow
  )).length;
  const hasTableComposition = Boolean(element.querySelector("table")) && children.length >= 2;

  if (own.layout && children.length >= 2) return true;
  if ((own.border || own.shadow) && children.length >= 2) return true;
  if (own.gradient && children.length >= 2) return true;
  if (hasTableComposition) return true;
  if (own.background && own.padding && children.length >= 2) return true;
  return own.padding && paintedChildren >= 2;
}

function normalizeTables(root: ParentNode, documentNode: Document) {
  root.querySelectorAll("table").forEach((table) => {
    const directRows = [...table.children].filter((child) => child.tagName === "TR");
    if (directRows.length) {
      const body = documentNode.createElement("tbody");
      directRows.forEach((row) => body.append(row));
      table.append(body);
    }
    table.querySelectorAll("tr").forEach((row) => {
      [...row.children].filter((child) => child.matches("td,th")).forEach((cell) => {
        if (!cell.childNodes.length) cell.append(documentNode.createElement("p"));
        [...cell.childNodes].forEach((node) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return;
          const paragraph = documentNode.createElement("p");
          paragraph.textContent = node.textContent;
          node.replaceWith(paragraph);
        });
      });
    });
  });
}

function wrapDirectInlineRuns(root: ParentNode, documentNode: Document) {
  [...root.querySelectorAll(STRUCTURAL_SELECTOR)].reverse().forEach((container) => {
    let run: Node[] = [];
    const flush = () => {
      if (!run.some(meaningfulNode)) {
        run.forEach((node) => node.parentNode?.removeChild(node));
        run = [];
        return;
      }
      const paragraph = documentNode.createElement("p");
      paragraph.className = INLINE_RUN_CLASS;
      paragraph.setAttribute("style", "margin:0;padding:0;font:inherit;color:inherit;line-height:inherit");
      run[0].parentNode?.insertBefore(paragraph, run[0]);
      run.forEach((node) => paragraph.append(node));
      run = [];
    };

    [...container.childNodes].forEach((node) => {
      const isBlock = node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName);
      if (isBlock) flush();
      else run.push(node);
    });
    flush();
  });
}

export function markRichLayoutGroups(root: ParentNode) {
  root.querySelectorAll(`.${RICH_LAYOUT_CLASS}`).forEach((element) => element.classList.remove(RICH_LAYOUT_CLASS));
  root.querySelectorAll(STRUCTURAL_SELECTOR).forEach((element) => {
    if (isRichLayoutGroup(element)) element.classList.add(RICH_LAYOUT_CLASS);
  });
}

export function normalizeRichHtmlDocument(documentNode: Document) {
  normalizeTables(documentNode.body, documentNode);
  wrapDirectInlineRuns(documentNode.body, documentNode);
  markRichLayoutGroups(documentNode.body);
  return documentNode;
}

export function richTextStats(root: ParentNode) {
  return {
    textLength: Array.from(root.textContent || "").length,
    elementCount: root.querySelectorAll("*").length,
  };
}

export function richTextLimitMessage(html: string, root: ParentNode) {
  const stats = richTextStats(root);
  if (html.length > RICH_TEXT_LIMITS.htmlLength) return "HTML 源码超过 100 万字符，请拆分文章后再导入";
  if (stats.textLength > RICH_TEXT_LIMITS.textLength) return "正文超过 3 万字，请拆分文章后再导入";
  if (stats.elementCount > RICH_TEXT_LIMITS.elementCount) return "富文本节点超过 2500 个，请简化装饰或拆分文章后再导入";
  return "";
}
