export const RICH_LAYOUT_CLASS = "imported-composite-visual";
export const INLINE_RUN_CLASS = "imported-inline-run";

export const RICH_TEXT_LIMITS = {
  htmlLength: 1_000_000,
  textLength: 30_000,
  elementCount: 2_500,
  depth: 64,
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
  const style = element.getAttribute("style") || "";
  const horizontalLayout = own.layout && !/flex-direction\s*:\s*column/i.test(style);
  const paragraphs = [...element.querySelectorAll("p")].filter((paragraph) => (
    !paragraph.closest("table,li,blockquote,figcaption") && Boolean(paragraph.textContent?.trim())
  ));
  const longParagraphs = paragraphs.filter((paragraph) => (paragraph.textContent?.trim().length || 0) >= 80);
  // Backgrounds and borders also commonly surround an entire AI-formatted
  // article. Keep its prose splittable, while retaining compact visual cards.
  if (element.tagName === "ARTICLE" || element.querySelector("h1") || longParagraphs.length >= 2) return false;
  if (!horizontalLayout && element.querySelectorAll("h2,h3,h4,h5,h6").length >= 2) return false;
  if (paragraphs.length >= 4 && paragraphs.some((paragraph) => (paragraph.textContent?.trim().length || 0) >= 32)) return false;

  const childSignals = children.map(visualSignals);
  const paintedChildren = childSignals.filter((signal) => (
    signal.background || signal.border || signal.gradient || signal.layout || signal.radius || signal.shadow
  )).length;
  const hasTableComposition = Boolean(element.querySelector("table")) && paragraphs.length <= 1 && children.length >= 2;
  const hasCallToAction = textLength <= 400 && Boolean(element.querySelector("a,button,img"));

  if (horizontalLayout && children.length >= 2) return true;
  if ((own.border || own.shadow) && children.length >= 2) return true;
  if (own.gradient && children.length >= 2) return true;
  if (hasTableComposition) return true;
  if (own.background && own.padding && hasCallToAction) return true;
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
  let elementCount = 0;
  let depth = 0;
  const stack = [...root.children].map((element) => ({ element, depth: 1 }));
  while (stack.length) {
    const current = stack.pop()!;
    elementCount += 1;
    depth = Math.max(depth, current.depth);
    for (const element of current.element.children) stack.push({ element, depth: current.depth + 1 });
  }
  return {
    textLength: Array.from(root.textContent || "").length,
    elementCount,
    depth,
  };
}

export function richTextHtmlLimitMessage(html: string) {
  return html.length > RICH_TEXT_LIMITS.htmlLength ? "HTML 源码超过 100 万字符，请拆分文章后再导入" : "";
}

export function richTextLimitMessage(html: string, root: ParentNode) {
  const htmlMessage = richTextHtmlLimitMessage(html);
  if (htmlMessage) return htmlMessage;
  const stats = richTextStats(root);
  if (stats.textLength > RICH_TEXT_LIMITS.textLength) return "正文超过 3 万字，请拆分文章后再导入";
  if (stats.elementCount > RICH_TEXT_LIMITS.elementCount) return "富文本节点超过 2500 个，请简化装饰或拆分文章后再导入";
  if (stats.depth > RICH_TEXT_LIMITS.depth) return "富文本嵌套超过 64 层，请简化装饰或改用纯文本粘贴";
  return "";
}
