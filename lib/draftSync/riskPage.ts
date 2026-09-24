import { PLATFORM_IMAGE_SIZES } from "./adaptImages";
import type { DraftImage, DraftPlatform } from "./types";

export type RiskNote = { enabled: boolean; title: string; text: string };
export type RiskAppearance = { paperColor: string; textColor: string; accentColor: string; fontFamily: string; footerText: string };

function waitFor<T>(work: () => Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); callback();
    };
    const abort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }).then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

// Keep every grapheme and every explicit blank line. Wrapping inserts only
// visual line breaks; it does not trim, replace, or parse the user's text.
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  return text.split(/\r\n|\r|\n/u).flatMap((paragraph) => {
    const lines: string[] = []; let line = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      if (context.measureText(segment).width > width) throw new Error("风险提示中有无法完整显示的字符，请调整内容后重试。");
      if (line && context.measureText(line + segment).width > width) { lines.push(line); line = segment; }
      else line += segment;
    }
    lines.push(line); return lines;
  });
}

export async function renderRiskPage(note: RiskNote, appearance: RiskAppearance, platform: DraftPlatform, signal?: AbortSignal): Promise<DraftImage | null> {
  if (!note.enabled) return null;
  signal?.throwIfAborted();
  const size = PLATFORM_IMAGE_SIZES[platform];
  if (!size) throw new Error("请选择风险提示对应的平台。");
  if (!note.text.trim()) throw new Error("请填写这个平台的风险提示内容。");
  if (note.text.length > 6000 || note.title.length > 200 || appearance.footerText.length > 200) throw new Error("风险提示内容过长，请精简后再生成图片；正文最多 6000 字，标题和页脚最多 200 字。");
  if (document.fonts) await waitFor(() => document.fonts.ready, signal, "风险提示字体准备超时，请重试。");
  signal?.throwIfAborted();
  const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成风险提示图片，请使用 Chrome 重试。");
    const padding = 96, width = size.width - padding * 2, top = 120;
    const family = appearance.fontFamily || "sans-serif";
    context.textAlign = "left"; context.textBaseline = "top";
    context.font = `400 22px ${family}`;
    const footer = appearance.footerText ? wrap(context, appearance.footerText, width) : [];
    const footerTop = size.height - padding - footer.length * 32;
    const bottom = footer.length ? footerTop - 48 : size.height - padding;
    let layout: { title: string[]; body: string[]; bodySize: number; titleSize: number; titleLine: number; bodyLine: number; bodyTop: number } | undefined;
    for (let bodySize = 36; bodySize >= 24; bodySize -= 2) {
      const titleSize = Math.round(bodySize * 1.45), titleLine = Math.ceil(titleSize * 1.3), bodyLine = Math.ceil(bodySize * 1.65);
      context.font = `700 ${titleSize}px ${family}`;
      const title = note.title ? wrap(context, note.title, width) : [];
      context.font = `400 ${bodySize}px ${family}`;
      const body = wrap(context, note.text, width);
      const bodyTop = top + (title.length ? title.length * titleLine + 40 : 0);
      if (bodyTop + body.length * bodyLine <= bottom) { layout = { title, body, bodySize, titleSize, titleLine, bodyLine, bodyTop }; break; }
    }
    if (!layout) throw new Error("风险提示过长，无法在一张图片中完整显示。请精简内容后重试，不会截断文字。");
    signal?.throwIfAborted();
    context.fillStyle = appearance.paperColor; context.fillRect(0, 0, size.width, size.height);
    context.fillStyle = appearance.accentColor; context.fillRect(padding, 80, 64, 6);
    context.fillStyle = appearance.textColor;
    context.font = `700 ${layout.titleSize}px ${family}`;
    layout.title.forEach((line, index) => context.fillText(line, padding, top + index * layout.titleLine));
    context.font = `400 ${layout.bodySize}px ${family}`;
    layout.body.forEach((line, index) => context.fillText(line, padding, layout.bodyTop + index * layout.bodyLine));
    context.font = `400 22px ${family}`;
    footer.forEach((line, index) => context.fillText(line, padding, footerTop + index * 32));
    const blob = await waitFor(() => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (!value?.size || value.type !== "image/png") reject(new Error("风险提示图片生成失败，请重试。"));
        else resolve(value);
      }, "image/png");
    }), signal, "风险提示图片生成超时，请重试。");
    signal?.throwIfAborted();
    return { id: `risk-${platform}`, name: `折页-${platform === "wechat" ? "公众号" : "小红书"}-风险提示.png`, blob, ...size };
  } finally { canvas.width = 0; canvas.height = 0; }
}
