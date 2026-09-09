import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "../lib/draftSync/validation.ts";

function dimensions(bytes, mime) {
  if (mime === "image/png") {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG 文件头无效");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime !== "image/jpeg" || bytes[0] !== 255 || bytes[1] !== 216) throw new Error("JPEG 文件头无效");
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 255) throw new Error("JPEG 数据无效");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("JPEG 数据不完整");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new Error("JPEG 尺寸无效");
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new Error("无法识别 JPEG 尺寸");
}

export function decodeImages(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("图片数量无效");
  let total = 0;
  return input.map((image, index) => {
    if (!image || typeof image.base64 !== "string" || image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || image.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(image.base64)) throw new Error("图片编码无效或文件过大");
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.toString("base64") !== image.base64) throw new Error("图片编码不规范");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 10 MB");
    total += bytes.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("图片总大小不能超过 60 MB");
    const measured = dimensions(bytes, image.mime);
    if (measured.width !== image.width || measured.height !== image.height || !measured.width || !measured.height || Math.max(measured.width, measured.height) > 20000) throw new Error("图片实际尺寸与提交信息不一致");
    const name = typeof image.name === "string" ? image.name.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 160) : `image-${index + 1}.${image.mime === "image/png" ? "png" : "jpg"}`;
    return { name, mime: image.mime, bytes, ...measured };
  });
}
