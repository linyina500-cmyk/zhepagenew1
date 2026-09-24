import type { DraftImage, DraftPlatform } from "./types";

export const PLATFORM_IMAGE_SIZES = {
  xiaohongshu: { width: 1080, height: 1440 },
  wechat: { width: 1080, height: 1350 },
} as const;

export function fitImageRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("图片尺寸无效，请重新选择图片");
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

class ImageAdaptError extends Error {}
const STEP_TIMEOUT_MS = 15_000;

function bounded<T>(work: () => Promise<T>, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(() => finish(() => reject(new ImageAdaptError(timeoutMessage))), STEP_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }).then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

async function checkFileType(blob: Blob, signal?: AbortSignal) {
  if (!blob.size || !["image/png", "image/jpeg"].includes(blob.type)) throw new ImageAdaptError("请使用有效的 PNG 或 JPEG 图片");
  const header = new Uint8Array(await bounded(() => blob.slice(0, 8).arrayBuffer(), signal, "图片读取超时，请重试"));
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  if ((blob.type === "image/png" && !png) || (blob.type === "image/jpeg" && !jpeg)) throw new ImageAdaptError("图片格式与内容不一致，请重新选择图片");
}

function imageName(name: string, mime: string) {
  const stem = name.replace(/\.[^./\\]+$/, "") || "图片";
  return mime === "image/png" ? `${stem}.png` : /\.jpe?g$/i.test(name) ? name : `${stem}.jpg`;
}

async function adaptImage(source: DraftImage, target: { width: number; height: number }, signal?: AbortSignal): Promise<DraftImage> {
  let url: string | undefined;
  let decoded: HTMLImageElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    await checkFileType(source.blob, signal);
    signal?.throwIfAborted();
    url = URL.createObjectURL(source.blob);
    decoded = new Image();
    const image = decoded;
    const sourceUrl = url;
    await bounded(() => new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ImageAdaptError("无法打开图片，请重新选择图片"));
      image.src = sourceUrl;
    }), signal, "图片读取超时，请重试");
    signal?.throwIfAborted();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 20_000)) {
      throw new ImageAdaptError("图片尺寸无效或过大，请重新选择图片");
    }
    // Validate the decoded dimensions even when saved metadata already matches.
    if (width === target.width && height === target.height) {
      return { id: source.id, name: imageName(source.name, source.blob.type), blob: source.blob, width, height };
    }
    canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) throw new ImageAdaptError("当前浏览器无法处理图片，请刷新后重试");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const rect = fitImageRect(width, height, target.width, target.height);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    const outputCanvas = canvas;
    const blob = await bounded(() => new Promise<Blob>((resolve, reject) => {
      outputCanvas.toBlob((value) => {
        if (!value || !value.size || value.type !== "image/png") reject(new ImageAdaptError("图片生成失败，请重试"));
        else resolve(value);
      }, "image/png");
    }), signal, "图片生成超时，请重试");
    signal?.throwIfAborted();
    return { id: source.id, name: imageName(source.name, "image/png"), blob, ...target };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`${source.name}：${error instanceof ImageAdaptError ? error.message : "图片处理失败，请重新选择图片后重试"}`);
  } finally {
    if (decoded) { decoded.onload = null; decoded.onerror = null; decoded.removeAttribute("src"); }
    if (url) URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function adaptDraftImages(images: readonly DraftImage[], platform: DraftPlatform, signal?: AbortSignal): Promise<DraftImage[]> {
  signal?.throwIfAborted();
  const target = PLATFORM_IMAGE_SIZES[platform];
  if (!target) throw new Error("请选择要同步的平台");
  const results: DraftImage[] = [];
  // Keep only one decoded image and canvas alive at a time. Originals are never changed.
  for (const image of images) {
    signal?.throwIfAborted();
    results.push(await adaptImage(image, target, signal));
  }
  signal?.throwIfAborted();
  return results;
}
