import type { DraftContent, DraftImage, DraftIssue, DraftPlatform, ImageMetadata } from "./types";

// These are conservative limits of this tool. Platform responses remain authoritative.
export const DRAFT_LIMITS = {
  xiaohongshu: { label: "小红书", title: 20, body: 1000, topics: 10, images: 18, ratio: 3 / 4, sizeLabel: "3:4（1080 × 1440）" },
  wechat: { label: "公众号贴图", title: 20, body: 1000, topics: 10, images: 20, ratio: 4 / 5, sizeLabel: "4:5（1080 × 1350）" },
} as const;
export const MAX_IMAGE_BYTES = 10_000_000;
export const MAX_TOTAL_IMAGE_BYTES = 60 * 1024 * 1024;
export const countCharacters = (value: string) => Array.from(value).length;
// Topics start at a whitespace boundary; closed topics may touch (#one##two#).
// Requiring content immediately after # excludes ordinary Markdown headings.
export function countHashtags(value: string): number {
  const groups = value.match(/(?:^|\s)(?:#[^\s#]+#?)+/gu) ?? [];
  return groups.reduce((count, group) => count + (group.match(/#[^\s#]+#?/gu)?.length ?? 0), 0);
}
export const imageMetadata = (image: DraftImage): ImageMetadata => ({
  id: image.id, name: image.name, width: image.width, height: image.height, size: image.blob.size, mime: image.blob.type,
});

export function validateDraft(platform: DraftPlatform, content: DraftContent, images: ImageMetadata[]): DraftIssue[] {
  const limit = DRAFT_LIMITS[platform];
  const issues: DraftIssue[] = [];
  if (!content.title.trim()) issues.push({ severity: "error", code: "title-empty", message: "请填写同步标题" });
  if (countCharacters(content.title) > limit.title) issues.push({ severity: "error", code: "title-long", message: `本工具的${limit.label}标题最多 ${limit.title} 个字符，请缩短后同步` });
  if (countCharacters(content.body) > limit.body) issues.push({ severity: "error", code: "body-long", message: `本工具的${limit.label}文案最多 ${limit.body} 字，请缩短后同步` });
  if (countHashtags(content.body) > limit.topics) issues.push({ severity: "error", code: "topics-long", message: `${limit.label}文案最多 ${limit.topics} 个话题，请减少 #话题 后同步` });
  if (!images.length || images.length > limit.images) issues.push({ severity: "error", code: "image-count", message: `${limit.label}本次同步需要 1–${limit.images} 张图片，当前 ${images.length} 张` });
  if (images.reduce((sum, image) => sum + image.size, 0) > MAX_TOTAL_IMAGE_BYTES) issues.push({ severity: "error", code: "total-size", message: "本次图片总大小超过 60 MB，请减少图片或压缩后再同步" });
  for (const image of images) {
    const imageId = image.id;
    if (!["image/png", "image/jpeg"].includes(image.mime)) issues.push({ severity: "error", code: "image-type", imageId, message: `${image.name}：仅支持 PNG 或 JPEG` });
    if (!Number.isSafeInteger(image.size) || image.size <= 0 || image.size > MAX_IMAGE_BYTES) issues.push({ severity: "error", code: "image-size", imageId, message: `${image.name}：单张图片需要大于 0 且不超过 10 MB` });
    if (![image.width, image.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 20000)) {
      issues.push({ severity: "error", code: "image-dimensions", imageId, message: `${image.name}：无法识别有效图片尺寸` });
      continue;
    }
    if (Math.abs(image.width / image.height - limit.ratio) > 0.015) issues.push({
      severity: "warning", code: "image-ratio", imageId,
      message: `${image.name} 为 ${image.width} × ${image.height}；本站${limit.label}模板建议 ${limit.sizeLabel}。可返回调整，或确认沿用当前比例。这是排版建议，不是平台强制尺寸。`,
    });
    if (Math.min(image.width, image.height) < 720) issues.push({ severity: "warning", code: "image-resolution", imageId, message: `${image.name} 短边不足 720 像素，文字可能不够清晰` });
  }
  if (images.some((image) => images[0] && Math.abs(image.width / image.height - images[0].width / images[0].height) > 0.015)) issues.push({ severity: "warning", code: "mixed-ratios", message: "图片比例不一致，平台展示时可能裁切。首图将作为封面，请核对顺序与主体位置。" });
  return issues;
}

export async function readDraftImage(file: File): Promise<DraftImage> {
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error("请使用不超过 10 MB 的 PNG 或 JPEG 图片");
  const url = URL.createObjectURL(file);
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${file.name} 图片读取超时，请重新选择`)), 15000);
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`${file.name} 无法打开，请重新选择图片`));
      image.src = url;
    });
    if (!dimensions.width || !dimensions.height || Math.max(dimensions.width, dimensions.height) > 20000) throw new Error(`${file.name} 图片尺寸无效或过大`);
    return { id: crypto.randomUUID(), name: file.name, blob: file, ...dimensions };
  } finally {
    clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
