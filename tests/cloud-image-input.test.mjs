import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { decodeImages } from "../cloud/imageInput.mjs";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const jpeg = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgAkgf/9k=", "base64");
const image = { name: "poster.png", mime: "image/png", base64: png.toString("base64"), width: 1, height: 1 };

test("image boundary uses the file bytes and rejects remote URLs, MIME mismatches and oversized metadata", () => {
  assert.equal(decodeImages([image])[0].bytes.equals(png), true);
  for (const change of [{ base64: "https://evil.example/image.png" }, { mime: "image/jpeg" }, { width: 1080 }, { height: 0 }, { base64: "abcd====" }, { base64: "" }]) assert.throws(() => decodeImages([{ ...image, ...change }]));
  assert.throws(() => decodeImages(Array.from({ length: 21 }, () => image)));
  assert.equal(decodeImages([{ ...image, name: "../../private/image.png" }])[0].name.includes("/"), false);
  // A complete PNG with a large ancillary chunk exercises multi-megabyte
  // base64 validation without relying on a repeated regex or corrupt padding.
  const chunk = Buffer.alloc(5_000_012, "x");
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("tEXtnote\0", 4, "latin1");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  assert.equal(decodeImages([{ ...image, base64: large.toString("base64") }])[0].bytes.length, large.length);
  assert.equal(decodeImages([{ ...image, mime: "image/jpeg", base64: jpeg.toString("base64") }])[0].bytes.equals(jpeg), true);
});
