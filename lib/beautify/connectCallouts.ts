const JOINED_BEFORE = "auto-callout-joined-before";
const JOINED_AFTER = "auto-callout-joined-after";
const CALLOUT_SELECTOR = "p.auto-key-point,p.auto-data-callout";
const SHELL_TAGS = new Set(["SECTION", "DIV", "ARTICLE", "MAIN", "ASIDE", "BLOCKQUOTE"]);
const MEDIA_SELECTOR = "img,picture,video,audio,svg,canvas,iframe,object,embed,table,hr";
const ISOLATED_SELECTOR = ".manual-page-break,.manual-empty-line,.lead-magnet-card,.risk-note,.first-page-lede,.imported-composite-visual,.scaled-composite-visual";

type CalloutKind = "key" | "data";
type Adjacency = { previous: HTMLElement | null; kind: CalloutKind | null };

function calloutKind(element: HTMLElement): CalloutKind | null {
  if (element.tagName !== "P" || element.matches(ISOLATED_SELECTOR)
    || element.querySelector(`${MEDIA_SELECTOR},.manual-page-break`)) return null;
  const key = element.classList.contains("auto-key-point");
  const data = element.classList.contains("auto-data-callout");
  return key === data ? null : key ? "key" : "data";
}

function meaningfulChildren(element: HTMLElement) {
  return [...element.childNodes].filter((node) => (
    node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
  ));
}

function isContinuationShell(element: HTMLElement) {
  if (!SHELL_TAGS.has(element.tagName) || element.matches(ISOLATED_SELECTOR)) return false;
  if (!/^(start|middle|end)$/.test(element.getAttribute("data-pagination-wrapper") || "")) return false;
  if (/display\s*:\s*(?:inline-)?(?:flex|grid)|grid-template|columns?\s*:|position\s*:\s*(?:absolute|fixed)/i.test(element.getAttribute("style") || "")) return false;
  const children = meaningfulChildren(element);
  return children.length === 1 && children[0].nodeType === Node.ELEMENT_NODE;
}

/** Recompute the visible edges in one page or measurement, independent of old markers. */
export function connectAdjacentCallouts(root: HTMLElement): number {
  const before = new Set<HTMLElement>();
  const after = new Set<HTMLElement>();
  const clear = (state: Adjacency) => {
    state.previous = null;
    state.kind = null;
  };
  const visitChildren = (parent: HTMLElement, state: Adjacency) => {
    for (const node of meaningfulChildren(parent)) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        clear(state);
        continue;
      }
      const element = node as HTMLElement;
      const kind = calloutKind(element);
      if (kind) {
        if (state.previous && state.kind === kind) {
          after.add(state.previous);
          before.add(element);
        }
        state.previous = element;
        state.kind = kind;
        continue;
      }
      if (isContinuationShell(element)) {
        const position = element.getAttribute("data-pagination-wrapper");
        if (position === "start") clear(state);
        visitChildren(element, state);
        if (position === "end") clear(state);
        continue;
      }
      // An ordinary container owns its own sibling sequence. Only the single
      // child shells produced by pagination can carry adjacency across siblings.
      clear(state);
      visitChildren(element, { previous: null, kind: null });
    }
  };
  visitChildren(root, { previous: null, kind: null });

  let changes = 0;
  root.querySelectorAll<HTMLElement>(`${CALLOUT_SELECTOR},.${JOINED_BEFORE},.${JOINED_AFTER}`).forEach((element) => {
    for (const [className, expected] of [[JOINED_BEFORE, before.has(element)], [JOINED_AFTER, after.has(element)]] as const) {
      if (element.classList.contains(className) === expected) continue;
      element.classList.toggle(className, expected);
      changes += 1;
    }
  });
  return changes;
}

export function connectCalloutsInHtml(html: string): string {
  if (!/auto-(?:key-point|data-callout|callout-joined-(?:before|after))/.test(html)) return html;
  const root = new DOMParser().parseFromString("<body></body>", "text/html").body;
  root.innerHTML = html;
  return connectAdjacentCallouts(root) ? root.innerHTML : html;
}
