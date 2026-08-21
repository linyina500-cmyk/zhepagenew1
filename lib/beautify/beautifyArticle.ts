const NUMBERED_HEADING = /^(?:第[一二三四五六七八九十百\d]+[章节部分]?|[一二三四五六七八九十]+[、.．]|0?\d{1,2}[、.．\s])/;
const SECTION_HEADING = /^(?:实话|真相|观点|理由|问题|提醒|要点|关键)[一二三四五六七八九十\d]+[:：、]/;
const CONCLUSION_HEADING = /^(?:写在最后|写到最后|最后说几句|结语|结论|总结|风险提示)$/;
const KEY_POINT_PREFIX = /^(?:翻译一下|一句话总结|换句话说|核心是|关键是|需要注意的是|更重要的是)[:：]/;
const STRUCTURED_PREFIX = /^(?:第一|第二|第三|第四|第五|先看[AB]面|再看[AB]面)[，。:：]/i;
const GENERIC_HEADING_EXCLUSION = /^(?:求点赞|求转发|求推荐|求评论|免责声明|版权与免责声明)/;

export type AutoTypesetResult = {
  html: string;
  changes: number;
  promotedHeadings: number;
  formattedParagraphs: number;
  removedEmptyParagraphs: number;
};

function mergeStyle(element: HTMLElement, declarations: Record<string, string>) {
  Object.entries(declarations).forEach(([property, value]) => {
    if (!element.style.getPropertyValue(property)) element.style.setProperty(property, value);
  });
}

function addClass(element: HTMLElement, className: string) {
  if (element.classList.contains(className)) return 0;
  element.classList.add(className);
  return 1;
}

function setAttribute(element: HTMLElement, name: string, value: string) {
  if (element.getAttribute(name) === value) return 0;
  element.setAttribute(name, value);
  return 1;
}

function promoteParagraph(parsed: Document, paragraph: HTMLParagraphElement, tagName: "h2" | "h3") {
  const heading = parsed.createElement(tagName);
  [...paragraph.attributes].forEach((attribute) => heading.setAttribute(attribute.name, attribute.value));
  while (paragraph.firstChild) heading.append(paragraph.firstChild);
  paragraph.replaceWith(heading);
  return heading;
}

function emphasisRatio(paragraph: HTMLParagraphElement, textLength: number) {
  const emphasizedLength = [...paragraph.querySelectorAll("strong,b,mark")]
    .reduce((total, emphasis) => total + (emphasis.textContent?.trim().length || 0), 0);
  return emphasizedLength / Math.max(1, textLength);
}

export function beautifyArticle(html: string): AutoTypesetResult {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  let changes = 0;
  let promotedHeadings = 0;
  let formattedParagraphs = 0;
  let removedEmptyParagraphs = 0;

  parsed.body.querySelectorAll<HTMLParagraphElement>("p").forEach((paragraph) => {
    const text = paragraph.textContent?.trim() || "";
    const hasMedia = Boolean(paragraph.querySelector("img,video,iframe,table"));
    if (!text && !hasMedia && !paragraph.classList.contains("manual-empty-line")) {
      paragraph.remove();
      changes += 1;
      removedEmptyParagraphs += 1;
      return;
    }
    if (text.length > 52) return;
    const isConclusion = CONCLUSION_HEADING.test(text);
    const isEmphasizedHeading = text.length >= 8
      && text.length <= 36
      && emphasisRatio(paragraph, text.length) >= 0.88
      && !/[。！？!?]$/.test(text)
      && !GENERIC_HEADING_EXCLUSION.test(text);
    if (!isConclusion && !NUMBERED_HEADING.test(text) && !SECTION_HEADING.test(text) && !isEmphasizedHeading) return;
    const heading = promoteParagraph(parsed, paragraph, isConclusion ? "h2" : "h3");
    heading.classList.add("auto-beautified-heading", isConclusion ? "auto-conclusion-heading" : "auto-inferred-heading");
    changes += 1;
    promotedHeadings += 1;
  });

  let sectionIndex = 0;
  parsed.body.querySelectorAll<HTMLElement>("h1,h2,h3").forEach((heading) => {
    const text = heading.textContent?.trim() || "";
    changes += addClass(heading, "auto-beautified-heading");
    if (CONCLUSION_HEADING.test(text)) {
      changes += addClass(heading, "auto-conclusion-heading");
      heading.removeAttribute("data-auto-index");
      return;
    }
    if (heading.classList.contains("auto-inferred-heading") || NUMBERED_HEADING.test(text) || SECTION_HEADING.test(text)) {
      changes += addClass(heading, "auto-inferred-heading");
      sectionIndex += 1;
      changes += setAttribute(heading, "data-auto-index", String(sectionIndex).padStart(2, "0"));
    }
  });

  const firstTopLevelParagraph = [...parsed.body.children]
    .find((element) => element.tagName === "P" && element.textContent?.trim()) as HTMLParagraphElement | undefined;
  if (firstTopLevelParagraph) {
    const added = addClass(firstTopLevelParagraph, "auto-lead-paragraph");
    changes += added;
    formattedParagraphs += added;
  }

  parsed.body.querySelectorAll<HTMLParagraphElement>("p").forEach((paragraph) => {
    const text = paragraph.textContent?.trim() || "";
    if (!text || paragraph === firstTopLevelParagraph || paragraph.classList.contains("image-caption")) return;
    const ratio = emphasisRatio(paragraph, text.length);
    const numericSignals = text.match(/(?:\d[\d,.]*%?|\d+(?:\.\d+)?(?:万|亿|元|倍|股|户))/g)?.length || 0;
    let added = 0;
    if (text.length >= 32 && text.length <= 190 && numericSignals >= 2 && ratio >= 0.38) {
      added += addClass(paragraph, "auto-data-callout");
      changes += setAttribute(paragraph, "data-auto-label", "关键数据");
    } else if (text.length >= 18 && text.length <= 170 && (KEY_POINT_PREFIX.test(text) || ratio >= 0.62)) {
      added += addClass(paragraph, "auto-key-point");
    } else if (text.length <= 190 && STRUCTURED_PREFIX.test(text)) {
      added += addClass(paragraph, "auto-structured-paragraph");
    }
    changes += added;
    formattedParagraphs += added;

    if (/^图[:：]/.test(text) && text.length <= 140) {
      const captionAdded = addClass(paragraph, "auto-image-caption");
      changes += captionAdded;
      formattedParagraphs += captionAdded;
    }
  });

  parsed.body.querySelectorAll<HTMLElement>(".auto-conclusion-heading").forEach((heading) => {
    const follower = heading.nextElementSibling;
    if (!(follower instanceof HTMLParagraphElement)) return;
    const added = addClass(follower, "auto-closing-lead");
    changes += added;
    formattedParagraphs += added;
  });

  parsed.body.querySelectorAll<HTMLElement>("blockquote").forEach((quote) => {
    changes += addClass(quote, "auto-beautified-callout");
  });
  parsed.body.querySelectorAll<HTMLElement>("ul,ol").forEach((list) => {
    changes += addClass(list, "auto-beautified-list");
  });
  parsed.body.querySelectorAll<HTMLElement>("strong,b,mark").forEach((emphasis) => {
    if (/\d/.test(emphasis.textContent || "")) changes += addClass(emphasis, "auto-data-emphasis");
  });
  parsed.body.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    changes += addClass(image, "auto-beautified-image");
    mergeStyle(image, {
      display: "block",
      "max-width": "100%",
      height: "auto",
      "margin-left": "auto",
      "margin-right": "auto",
    });
  });
  parsed.body.querySelectorAll<HTMLElement>("table").forEach((table) => {
    changes += addClass(table, "auto-beautified-table");
    table.querySelectorAll<HTMLElement>("th,td").forEach((cell) => {
      const value = cell.textContent?.trim() || "";
      if (/^[¥￥$]?[-+]?\d[\d,.%万亿元亿倍s-]*$/.test(value)) changes += addClass(cell, "auto-numeric-cell");
    });
  });

  return { html: parsed.body.innerHTML, changes, promotedHeadings, formattedParagraphs, removedEmptyParagraphs };
}
