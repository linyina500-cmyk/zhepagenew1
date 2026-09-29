import type { DraftImage } from "./types";

export type RiskNote = { enabled: boolean; title: string; text: string };
const SVG_NS = "http://www.w3.org/2000/svg", HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_TEMPLATE_BYTES = 80 * 1024 * 1024;
const invalid = () => new Error("末页模板不完整或包含外部资源，请返回编辑器重新生成图片。");
const allowedTags = new Set("article section div main aside header footer nav address p span h1 h2 h3 h4 h5 h6 strong b em i u s strike del ins mark small sub sup br hr wbr blockquote pre code ul ol li dl dt dd figure figcaption table caption colgroup col thead tbody tfoot tr th td img a style ruby rt rp".split(" "));
const embedded = /^(?:data:image\/(?:png|jpeg|gif|webp|avif)|data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|font-truetype|vnd\.ms-fontobject|octet-stream)));base64,[a-z0-9+/=\r\n]+$/iu;

function waitFor<T>(work: () => Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback();
    };
    const abort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }).then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

function assertEmbeddedCss(css: string) {
  // Decode CSS escapes before inspecting resource tokens. The isolated frame's
  // CSP is a second boundary: no network resource is allowed during measurement.
  const decoded = css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/giu, (_, hex: string, character: string) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : character);
  if (/@import|@namespace|expression\s*\(|-moz-binding|javascript\s*:|\b(?:image|image-set|cross-fade|paint)\s*\(/iu.test(decoded)) throw invalid();
  const remaining = decoded.replace(/url\(\s*(["']?)(.*?)\1\s*\)/giu, (_, _quote: string, value: string) => {
    if (!embedded.test(value.trim())) throw invalid();
    return "";
  });
  if (/url\s*\(/iu.test(remaining)) throw invalid();
}

/** Validate while detached, before either the HTML or its styles can load. */
export function parseRiskTemplate(svg: string, width: number, height: number) {
  if (typeof svg !== "string" || !svg || svg.length > MAX_TEMPLATE_BYTES || /<!DOCTYPE|<!ENTITY/iu.test(svg)) throw invalid();
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 20_000)) throw invalid();
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml"), root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.namespaceURI !== SVG_NS || root.localName !== "svg"
    || root.getAttribute("width") !== String(width) || root.getAttribute("height") !== String(height)
    || root.getAttribute("viewBox") !== `0 0 ${width} ${height}` || root.children.length !== 1) throw invalid();
  const foreign = root.children[0];
  if (foreign.namespaceURI !== SVG_NS || foreign.localName !== "foreignObject" || foreign.children.length !== 1
    || foreign.getAttribute("width") !== "100%" || foreign.getAttribute("height") !== "100%"
    || foreign.getAttribute("x") !== "0" || foreign.getAttribute("y") !== "0") throw invalid();
  for (const element of [root, foreign]) {
    const allowed = element === root ? ["xmlns", "width", "height", "viewBox"] : ["width", "height", "x", "y", "externalResourcesRequired"];
    if ([...element.attributes].some((attribute) => !allowed.includes(attribute.name))) throw invalid();
  }
  const poster = foreign.children[0] as HTMLElement;
  if (poster.localName !== "article" || !poster.classList.contains("poster-page")) throw invalid();
  const elements = [poster, ...poster.querySelectorAll<HTMLElement>("*")];
  if (elements.length > 10_000) throw invalid();
  for (const element of elements) {
    if (element.namespaceURI !== HTML_NS || !allowedTags.has(element.localName)) throw invalid();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["srcdoc", "srcset", "action", "formaction", "ping", "poster", "background", "is"].includes(name)) throw invalid();
      if (["src", "href", "xlink:href"].includes(name) && !(element.localName === "img" && name === "src" && /^data:image\//iu.test(attribute.value) && embedded.test(attribute.value))) throw invalid();
      if (name === "style") assertEmbeddedCss(attribute.value);
    }
    if (element.localName === "style") assertEmbeddedCss(element.textContent || "");
  }
  const viewport = poster.querySelector<HTMLElement>(":scope > .article-viewport"), flow = viewport?.querySelector<HTMLElement>(":scope > .article-flow");
  if (!viewport || !flow || flow.querySelectorAll(".risk-note").length !== 1) throw invalid();
  return { doc, root, foreign, poster, viewport, flow };
}

/** Called only on an export snapshot; the live preview and base PNG stay intact. */
export function prepareEditableRiskSnapshot(poster: HTMLElement) {
  const flow = poster.querySelector<HTMLElement>(":scope > .article-viewport > .article-flow");
  if (!flow || flow.querySelectorAll(".risk-note").length > 1) throw invalid();
  if (!flow.querySelector(".risk-note")) {
    const aside = poster.ownerDocument.createElement("aside"); aside.className = "risk-note";
    const title = poster.ownerDocument.createElement("strong"), paragraph = poster.ownerDocument.createElement("p");
    title.textContent = "风险提示"; paragraph.textContent = "提示内容";
    aside.append(title, paragraph); flow.append(aside);
  }
}

export function riskTemplateFromDataUrl(url: string, width: number, height: number) {
  const prefix = "data:image/svg+xml;charset=utf-8,";
  if (!url.startsWith(prefix)) throw invalid();
  let svg: string;
  try { svg = decodeURIComponent(url.slice(prefix.length)); } catch { throw invalid(); }
  parseRiskTemplate(svg, width, height);
  return { svg };
}

function unfreezeRiskBlock(element: HTMLElement) {
  for (const [property, value] of Object.entries({ height: "auto", "min-height": "0", "max-height": "none", "block-size": "auto", "min-block-size": "0", "max-block-size": "none", overflow: "visible", display: "block", visibility: "visible", opacity: "1", position: "static", "white-space": "pre-wrap", "overflow-wrap": "anywhere", "word-break": "normal", "-webkit-line-clamp": "none" })) element.style.setProperty(property, value, "important");
  element.removeAttribute("hidden");
}

function replaceRisk(flow: HTMLElement, note: RiskNote) {
  const aside = flow.querySelector<HTMLElement>(".risk-note")!;
  // html-to-image freezes computed heights, including an optional placeholder.
  // Release the flow for both replacement and removal so it measures its body.
  flow.style.setProperty("height", "auto", "important");
  flow.style.setProperty("block-size", "auto", "important");
  flow.style.setProperty("max-height", "none", "important");
  if (!note.enabled) { aside.remove(); return; }
  const title = aside.querySelector<HTMLElement>(":scope > strong"), paragraph = aside.querySelector<HTMLElement>(":scope > p");
  if (!title || !paragraph) throw invalid();
  title.textContent = note.title; paragraph.textContent = note.text;
  for (const element of [aside, title, paragraph]) unfreezeRiskBlock(element);
}

export function assertRiskFits(poster: HTMLElement) {
  const viewport = poster.querySelector<HTMLElement>(":scope > .article-viewport"), flow = viewport?.querySelector<HTMLElement>(":scope > .article-flow");
  if (!viewport || !flow) throw invalid();
  const area = viewport.getBoundingClientRect(), body = flow.getBoundingClientRect();
  const risk = flow.querySelector<HTMLElement>(".risk-note"), riskBox = risk?.getBoundingClientRect();
  if (area.width <= 0 || area.height <= 0) throw new Error("末页排版尚未准备好，请重新生成图片。");
  if (Math.max(body.bottom, body.top + flow.scrollHeight) > area.bottom + 2 || flow.scrollWidth > area.width + 2
    || (riskBox && (riskBox.bottom > area.bottom + 2 || riskBox.right > area.right + 2 || riskBox.left < area.left - 2))) {
    throw new Error("风险提示超出当前末页空间，请缩短内容或返回编辑器调整排版；不会增加图片或截断文字。");
  }
}

/** Re-render the original last page, never append a separate disclaimer card. */
export async function renderRiskPage(note: RiskNote, source: DraftImage, signal?: AbortSignal): Promise<DraftImage> {
  signal?.throwIfAborted();
  if (typeof note.enabled !== "boolean" || typeof note.title !== "string" || typeof note.text !== "string") throw new Error("请检查风险提示内容后重试。");
  if (note.enabled && !note.text.trim()) throw new Error("请填写这个平台的风险提示内容。");
  if (note.enabled && (note.text.length > 6000 || note.title.length > 200)) throw new Error("风险提示内容过长；正文最多 6000 字，标题最多 200 字。");
  if (!source.riskTemplate) throw new Error("这张图片没有可编辑的风险提示，请返回编辑器重新生成。");
  const { root, foreign, poster, flow } = parseRiskTemplate(source.riskTemplate.svg, source.width, source.height);
  replaceRisk(flow, note);
  const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-same-origin"); frame.setAttribute("aria-hidden", "true"); frame.inert = true;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${source.width}px;height:${source.height}px;border:0;pointer-events:none;`;
  let image: HTMLImageElement | undefined, canvas: HTMLCanvasElement | undefined;
  try {
    await waitFor(() => new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve(); frame.onerror = () => reject(new Error("末页排版准备失败，请重试。"));
      frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'"><style>html,body{margin:0;padding:0;width:${source.width}px;height:${source.height}px;overflow:hidden}</style></head><body>${new XMLSerializer().serializeToString(poster)}</body></html>`;
      document.body.append(frame);
    }), signal, "末页排版准备超时，请重试。");
    const frameDoc = frame.contentDocument, livePoster = frameDoc?.body.firstElementChild as HTMLElement | null;
    if (!frameDoc || !livePoster) throw invalid();
    if (frameDoc.fonts) await waitFor(() => frameDoc.fonts.ready, signal, "末页字体准备超时，请重试。");
    await waitFor(() => Promise.all([...livePoster.querySelectorAll("img")].map((item) => item.decode())), signal, "末页图片准备超时，请重试。");
    signal?.throwIfAborted(); assertRiskFits(livePoster);
    const rendered = root.ownerDocument.importNode(livePoster, true);
    // HTML parsing turns an xmlns declaration into a plain attribute. Let the
    // XML serializer supply it from namespaceURI instead of emitting it twice.
    for (const element of [rendered, ...rendered.querySelectorAll("*")]) element.removeAttribute("xmlns");
    foreign.replaceChildren(rendered);
    const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
    image = new Image(); const picture = image;
    await waitFor(() => new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve(); picture.onerror = () => reject(new Error("末页图片生成失败，请重试。")); picture.src = encoded;
    }), signal, "末页图片生成超时，请重试。");
    signal?.throwIfAborted();
    if (picture.naturalWidth !== source.width || picture.naturalHeight !== source.height) throw new Error("末页图片尺寸未能确认，请重新生成。");
    canvas = document.createElement("canvas"); canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成末页图片，请使用 Chrome 重试。");
    context.drawImage(picture, 0, 0, source.width, source.height);
    const output = canvas;
    const blob = await waitFor(() => new Promise<Blob>((resolve, reject) => output.toBlob((value) => {
      if (!value?.size || value.type !== "image/png") reject(new Error("末页图片生成失败，请重试。")); else resolve(value);
    }, "image/png")), signal, "末页图片生成超时，请重试。");
    signal?.throwIfAborted();
    return { ...source, blob };
  } finally {
    frame.onload = null; frame.onerror = null; frame.remove();
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute("src"); }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
