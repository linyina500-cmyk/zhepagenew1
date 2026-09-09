import { INLINE_RUN_CLASS, RICH_LAYOUT_CLASS, normalizeRichHtmlDocument, richTextHtmlLimitMessage, richTextLimitMessage } from "./normalizeRichHtml";

const MAX_ARTICLE_DOCUMENT_BYTES = 6 * 1024 * 1024;

const SAFE_ELEMENTS = "script,style,link,meta,base,iframe,object,embed,form,input,button,textarea,select,video,audio,canvas,svg";
function safeUrl(raw: string, baseUrl = window.location.href) {
  try {
    const url = new URL(raw, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function safeImageUrl(raw: string, baseUrl: string) {
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(raw)) return raw;
  const resolved = safeUrl(raw, baseUrl);
  if (!resolved) return "";
  const url = new URL(resolved);
  // The rich-text dialog can receive images that were already imported by
  // this app. Preserve its own proxy URL instead of proxying the proxy again.
  if (url.origin === window.location.origin && url.pathname === "/api/image" && url.searchParams.has("url")) {
    return `${url.pathname}${url.search}`;
  }
  const source = safeUrl(raw.replace(/^http:\/\//i, "https://"), baseUrl);
  return `/api/image?url=${encodeURIComponent(source)}`;
}

function scaleInlineTypography(style: string) {
  const clean = style
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*['"]?javascript:[^)]*\)/gi, "")
    .replace(/position\s*:\s*(fixed|sticky)\s*;?/gi, "")
    .replace(/z-index\s*:[^;]+;?/gi, "")
    .replace(/transform\s*:[^;]+;?/gi, "")
    // Imported WeChat spans frequently carry a fixed line-height intended for
    // the article page. It becomes far too tight after poster font scaling and
    // also prevents the user's line-height control from taking effect.
    .replace(/line-height\s*:[^;]+;?/gi, "");
  return clean.replace(/font-size\s*:\s*([\d.]+)px/gi, (_, size) => {
    const value = Number(size);
    if (!Number.isFinite(value)) return _;
    return `font-size:calc(${Math.max(26, Math.min(52, value * 2.05))}px * var(--type-scale))`;
  });
}

function sanitizeHtml(rawHtml: string, preserveStyles: boolean, baseUrl = window.location.href) {
  const sourceLimit = richTextHtmlLimitMessage(rawHtml);
  if (sourceLimit) throw new Error(sourceLimit);
  const documentNode = new DOMParser().parseFromString(rawHtml, "text/html");
  const inputLimit = richTextLimitMessage(rawHtml, documentNode.body);
  if (inputLimit) throw new Error(inputLimit);
  documentNode.querySelectorAll(SAFE_ELEMENTS).forEach((element) => element.remove());
  documentNode.querySelectorAll("*").forEach((element) => {
    const originalStyle = element.getAttribute("style") || "";
    const isNumberBadge = /^\d{1,3}$/.test(element.textContent?.trim() || "")
      && /border-radius\s*:\s*50%/i.test(originalStyle)
      && /background(?:-color)?\s*:/i.test(originalStyle);
    const lazyImageSource = element instanceof HTMLImageElement
      ? element.getAttribute("src") || element.getAttribute("data-src") || ""
      : "";
    const internalClasses = [...element.classList].filter((className) => [
      "image-caption", "manual-empty-line", "manual-page-break", "lead-card-placeholder", RICH_LAYOUT_CLASS, INLINE_RUN_CLASS,
    ].includes(className));
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["srcdoc", "id", "class"].includes(name) || name.startsWith("data-") || name.startsWith("aria-")) {
        element.removeAttribute(attribute.name);
      }
    });
    internalClasses.forEach((className) => element.classList.add(className));

    if (!preserveStyles) element.removeAttribute("style");
    else if (element.hasAttribute("style")) element.setAttribute("style", scaleInlineTypography(element.getAttribute("style") || ""));
    if (isNumberBadge) element.classList.add("imported-number-badge");

    if (element instanceof HTMLAnchorElement) {
      // Poster exports are static images, so imported links retain their text styling
      // but are intentionally made non-interactive.
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.removeAttribute("rel");
    }

    if (element instanceof HTMLImageElement) {
      const resolved = safeImageUrl(lazyImageSource, baseUrl);
      if (resolved) element.src = resolved;
      else element.remove();
      element.removeAttribute("srcset");
      element.removeAttribute("width");
      element.removeAttribute("height");
      element.alt ||= "文章配图";
    }
  });
  documentNode.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    if (!heading.textContent?.trim() && !heading.querySelector("img")) heading.remove();
  });
  normalizeRichHtmlDocument(documentNode);
  const limitMessage = richTextLimitMessage(documentNode.body.innerHTML, documentNode.body);
  if (limitMessage) throw new Error(limitMessage);
  return documentNode.body.innerHTML.trim();
}

export function extractArticle(source: string, preserveStyles: boolean, sourceUrl = window.location.href) {
  // The import endpoint allows a 6 MiB web document. WeChat's scripts alone
  // can exceed the editor's HTML limit, so bound the document separately and
  // apply the rich-text limits only to the extracted article body.
  if (source.length > MAX_ARTICLE_DOCUMENT_BYTES || new TextEncoder().encode(source).byteLength > MAX_ARTICLE_DOCUMENT_BYTES) {
    throw new Error("网页源码超过 6 MiB，请粘贴文章正文后导入");
  }
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const articleUrl = safeUrl(sourceUrl) || window.location.href;
  const baseUrl = safeUrl(parsed.querySelector("base[href]")?.getAttribute("href") || articleUrl, articleUrl) || articleUrl;
  const title =
    parsed.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    parsed.querySelector("h1")?.textContent?.trim() ||
    parsed.title ||
    "未命名文章";
  const subtitle =
    parsed.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
    parsed.querySelector('meta[name="description"]')?.getAttribute("content") ||
    "把长内容变成更容易读完的一组贴图";
  parsed.querySelectorAll(`${SAFE_ELEMENTS},mp-common-profile,.mp_profile_iframe_wrp,noscript`).forEach((element) => element.remove());
  const article =
    parsed.querySelector("#js_content") ||
    parsed.querySelector(".rich_media_content") ||
    parsed.querySelector("article") ||
    parsed.querySelector("main") ||
    parsed.body;
  return {
    title: title.replace(/\s+/g, " ").trim(),
    subtitle: subtitle.replace(/\s+/g, " ").trim().slice(0, 100),
    html: sanitizeHtml(article.innerHTML, preserveStyles, baseUrl),
  };
}

export function extractRichTextFragment(source: string, preserveStyles: boolean, inferTitle: boolean) {
  const sanitized = sanitizeHtml(source, preserveStyles);
  if (!inferTitle) return { title: "", html: sanitized, inferredTitle: false };

  const parsed = new DOMParser().parseFromString(sanitized, "text/html");
  const blocks = [...parsed.body.children].filter((element) => element.textContent?.trim() || element.querySelector("img,table"));
  const firstBlock = blocks[0] as HTMLElement | undefined;
  const firstText = firstBlock?.textContent?.replace(/\s+/g, " ").trim() || "";
  const remainingTextLength = blocks.slice(1).reduce((total, element) => total + (element.textContent?.trim().length || 0), 0);
  const explicitHeading = firstBlock?.tagName === "H1";
  const plainTextTitle = firstBlock?.tagName === "P"
    && Array.from(firstText).length >= 4
    && Array.from(firstText).length <= 72
    && blocks.length >= 3
    && remainingTextLength >= 36
    && !/[。；;]$/.test(firstText);

  if (!explicitHeading && !plainTextTitle) return { title: "", html: sanitized, inferredTitle: false };
  firstBlock?.remove();
  return {
    title: firstText,
    html: parsed.body.innerHTML.trim(),
    inferredTitle: true,
  };
}
