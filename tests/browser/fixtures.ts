import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// This is the user's regression article, not an expected value produced by
// the application's normalizer, beautifier, or pagination implementation.
export const originalArticle = readFileSync(new URL("../fixtures/a-share-pressure-article.txt", import.meta.url), "utf8");
const sourceLines = originalArticle.replace(/\r/g, "").split("\n");
export const articleTitle = sourceLines[0];
export const articleBody = sourceLines.slice(1).join("\n");
if (sourceLines.filter((line) => line === "\u00a0").length !== 5) {
  throw new Error("The regression article must retain its five NBSP-only paragraphs.");
}

export function compactText(text: string) {
  return text.replace(/\s+/gu, "");
}

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const originalArticleHtml = sourceLines.filter((line) => line !== "").map((line, index) => {
  if (index === 0) return `<h1>${escapeHtml(line)}</h1>`;
  if (line === "\u00a0") return "<p>&nbsp;</p>";
  const text = escapeHtml(line);
  return line === "怎么一夜之间，画风突然变了？" ? `<p><strong>${text}</strong></p>` : `<p>${text}</p>`;
}).join("");

export const shortTitle = "浏览器回归验证";
export const shortBody = "正文开头保留。图片前后的内容都需要完整保存。正文结尾保留。";
export const shortArticleHtml = `<h1>${shortTitle}</h1><p>正文开头保留。</p><p>图片前后的内容都需要完整保存。</p><p>正文结尾保留。</p>`;

function pngChunk(type: string, data: Buffer) {
  const nameAndData = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of nameAndData) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, nameAndData, checksum]);
}

// Tiny, valid, opaque PNGs avoid remote assets, image tooling, and binary files.
export function makePng(red = 30, green = 110, blue = 220) {
  const width = 32;
  const height = 12;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * (1 + width * 4) + 1 + column * 4;
      pixels.set([red, green, blue, 255], offset);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
