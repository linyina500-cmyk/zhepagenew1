import { withTimeout } from "../async/withTimeout";

// Matching these forbidden XML controls is the purpose of this expression.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** SVG uses XML rules, even though the live editor accepts HTML clipboard data. */
export function removeInvalidExportXml(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ALL);
  const comments: Node[] = [];
  let current: Node | null = root;
  while (current) {
    if (current.nodeType === Node.COMMENT_NODE) comments.push(current);
    else if (current.nodeType === Node.TEXT_NODE) current.nodeValue = (current.nodeValue || "").replace(INVALID_XML_CHARACTERS, "");
    else if (current instanceof Element) {
      for (const attribute of [...current.attributes]) {
        const cleaned = attribute.value.replace(INVALID_XML_CHARACTERS, "");
        if (attribute.value !== cleaned) current.setAttribute(attribute.name, cleaned);
      }
    }
    current = walker.nextNode();
  }
  for (const comment of comments) comment.parentNode?.removeChild(comment);
}

async function requireDecodedImage(image: HTMLImageElement, index: number) {
  try {
    await withTimeout(image.decode(), 20000, `第 ${index + 1} 张配图读取超时，请等待图片显示完整后重试`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("读取超时")) throw error;
    throw new Error(`第 ${index + 1} 张配图无法读取，请重新粘贴或上传该图片后重试`);
  }
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) throw new Error(`第 ${index + 1} 张配图尚未显示完整，请稍后重试`);
}

function localImagePixels(image: HTMLImageElement, index: number, outputWidth: number, outputHeight: number) {
  const canvas = image.ownerDocument.createElement("canvas");
  // clientWidth/clientHeight ignore the preview transform. A cover image also
  // needs enough pixels in its cropped dimension; preserve its aspect ratio.
  const boxWidth = image.clientWidth || outputWidth;
  const boxHeight = image.clientHeight || outputHeight;
  const fit = getComputedStyle(image).objectFit;
  const fittedScale = fit === "contain" || fit === "scale-down"
    ? Math.min(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight)
    : fit === "none" ? 1 : Math.max(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight);
  const scale = Math.min(1, fittedScale * 2, Math.sqrt(16_000_000 / (image.naturalWidth * image.naturalHeight)));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法准备配图，请关闭其他占用内存的页面后重试");
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const source = canvas.toDataURL("image/png");
    if (!source.startsWith("data:image/png;base64,")) throw new Error("Empty canvas");
    return source;
  } catch {
    throw new Error(`第 ${index + 1} 张配图无法用于下载，请将原图保存到设备，再通过“＋图片”上传`);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Capture decoded preview pixels locally; never refetch an already visible image. */
export async function preparePosterSnapshot(node: HTMLElement, format: { width: number; height: number }, assertCurrent: () => void) {
  const frame = node.ownerDocument.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.inert = true;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${format.width}px;pointer-events:none;z-index:-1;`;
  const grid = node.closest<HTMLElement>(".poster-grid");
  const gridClone = grid ? grid.cloneNode(false) as HTMLElement : node.ownerDocument.createElement("div");
  const inherited = getComputedStyle(grid || node);
  for (let index = 0; index < inherited.length; index++) {
    const property = inherited[index];
    if (property.startsWith("--")) gridClone.style.setProperty(property, inherited.getPropertyValue(property));
  }
  gridClone.style.setProperty("--preview-scale", "1");
  for (const property of ["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align"]) gridClone.style.setProperty(property, inherited.getPropertyValue(property));
  const wrap = node.parentElement?.classList.contains("poster-wrap") ? node.parentElement.cloneNode(false) as HTMLElement : node.ownerDocument.createElement("div");
  // A template is inert: unlike cloning live <img> nodes, parsing into it does
  // not start another request before the local pixel sources are assigned.
  const template = node.ownerDocument.createElement("template");
  template.innerHTML = node.outerHTML;
  const snapshot = template.content.firstElementChild as HTMLElement;
  snapshot.style.transform = "none";
  const sources = [...node.querySelectorAll<HTMLImageElement>("img")];
  const targets = [...snapshot.querySelectorAll<HTMLImageElement>("img")];
  try {
    if (sources.length !== targets.length) throw new Error("配图快照不完整，请刷新页面后重试");
    for (let index = 0; index < sources.length; index++) {
      assertCurrent();
      await requireDecodedImage(sources[index], index);
      assertCurrent();
      const target = targets[index];
      target.removeAttribute("srcset");
      target.removeAttribute("sizes");
      target.removeAttribute("crossorigin");
      target.loading = "eager";
      // WebKit may otherwise defer large-image painting inside the exported
      // SVG even when the original preview image has already decoded.
      target.setAttribute("decoding", "sync");
      target.src = localImagePixels(sources[index], index, format.width, format.height);
    }
    removeInvalidExportXml(snapshot);
    assertCurrent();
    wrap.append(snapshot);
    gridClone.append(wrap);
    frame.append(gridClone);
    (grid?.parentElement || node.ownerDocument.body).append(frame);
    for (let index = 0; index < targets.length; index++) await requireDecodedImage(targets[index], index);
    assertCurrent();
    return { node: snapshot, dispose: () => frame.remove() };
  } catch (error) { frame.remove(); throw error; }
}
