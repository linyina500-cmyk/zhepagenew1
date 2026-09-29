// Keep this function self-contained: Playwright serializes it into the page.
// Only already-decoded, visible images are read. No network or storage access.
export async function readImageFingerprints({ selectors }) {
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const candidates = [...document.querySelectorAll(selectors.images)].filter(visible);
  const cards = candidates.filter((card) => !candidates.some((other) => other !== card && other.contains(card)));
  // Reject the whole read instead of silently truncating an unexpected list.
  if (cards.length > 18) return null;
  const fingerprints = [];
  async function fingerprint(card) {
    const image = card.querySelector("img");
    const source = image?.currentSrc || image?.getAttribute("src") || "";
    const width = image?.naturalWidth, height = image?.naturalHeight;
    if (!image?.complete || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 20_000_000) return null;
    let canvas;
    try {
      canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      if (pixels.length !== width * height * 4) return null;
      const bytes = new Uint8Array(8 + pixels.length), dimensions = new DataView(bytes.buffer);
      dimensions.setUint32(0, width); dimensions.setUint32(4, height);
      bytes.set(pixels, 8);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      if (!image.isConnected || !image.complete || image.naturalWidth !== width || image.naturalHeight !== height
        || (image.currentSrc || image.getAttribute("src") || "") !== source
        || card.querySelector("img") !== image || !visible(card)) return null;
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
      return `pixels:${width}x${height}:${hash}`;
    } catch {
      // Tainted canvases and decode failures cannot prove image identity.
      return null;
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  // Do not allocate all canvases or RGBA buffers concurrently.
  for (const card of cards) fingerprints.push(await fingerprint(card));
  const current = [...document.querySelectorAll(selectors.images)].filter(visible);
  const currentCards = current.filter((card) => !current.some((other) => other !== card && other.contains(card)));
  if (currentCards.length !== cards.length || currentCards.some((card, index) => card !== cards[index])) return null;
  return fingerprints;
}
