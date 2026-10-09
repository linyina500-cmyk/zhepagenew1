// DOM evidence shared in behavior with the verified local driver. Functions
// passed to chrome.scripting are deliberately self-contained. No page cookies,
// hidden application state, storage or network endpoints are read.
export const SELECTORS = Object.freeze({
  title: 'input[placeholder*="标题"], [contenteditable="true"][placeholder*="标题"]',
  body: '.tiptap.ProseMirror[contenteditable="true"]',
  images: ".img-preview-area .pr",
  input: 'input[type="file"][multiple][accept*="image"], input[type="file"][multiple][accept*=".png"], input[type="file"][multiple][accept*=".jpg"]',
});

const DRAFT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_KEY = /^pixels:[1-9]\d*x[1-9]\d*:[a-f0-9]{64}$/;
export function validDraftRef(ref, imageCount) {
  return Boolean(ref && ref.kind === "local" && typeof ref.id === "string" && DRAFT_ID.test(ref.id)
    && Array.isArray(ref.images) && ref.images.length === imageCount
    && ref.images.every((key) => typeof key === "string" && IMAGE_KEY.test(key)));
}

// Observed through the creator homepage's visible DOM on 2026-09-22.
// The editor header exposes a nickname/logout menu, not a profile-ID link.
export function readAccountEvidence() {
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const cards = [...document.querySelectorAll(".home-card-wrapper .personal .base .text")].filter(visible);
  if (cards.length !== 1) return null;
  const card = cards[0];
  const names = [...card.querySelectorAll(".account-name")].filter(visible);
  const identifiers = [...card.querySelectorAll(".others.description-text > div")].filter(visible)
    .map((element) => /^小红书账号\s*[:：]\s*([A-Za-z0-9_-]{1,64})$/u.exec((element.innerText ?? element.textContent ?? "").trim()))
    .filter(Boolean);
  if (names.length !== 1 || identifiers.length !== 1) return null;
  const name = (names[0].innerText ?? names[0].textContent ?? "").trim();
  if (!name || name.length > 100 || /[\r\n\0]/u.test(name)) return null;
  return { identifier: identifiers[0][1], name };
}

export function readLoginEvidence() {
  const text = document.body?.innerText?.trim() ?? "";
  if (/请稍候|加载中|登录中/u.test(text)) return { loginVisible: false };
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const phoneForm = [...document.querySelectorAll("input")].some((input) => visible(input)
    && (input.type === "tel" || /手机号|手机号码|验证码/u.test(input.getAttribute("placeholder") ?? "")));
  const qrCode = /扫码/u.test(text) && [...document.querySelectorAll("canvas, img")].some((element) => {
    const rect = element.getBoundingClientRect();
    return visible(element) && rect.width >= 100 && rect.height >= 100
      && (element.tagName === "CANVAS" || /qr|二维码/iu.test(`${element.className} ${element.getAttribute("alt") ?? ""}`));
  });
  return { loginVisible: /登录/u.test(text) && (phoneForm || qrCode) };
}

// Kept self-contained so the same DOM reading can be tested without an account.
export function readPageEvidence({ selectors }) {
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const normalize = (text) => text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const fieldText = (element) => {
    if (!element) return null;
    if ("value" in element) return normalize(element.value);
    const paragraphs = [...element.childNodes];
    if (paragraphs.every((node) => node.nodeType === 1 && node.tagName === "P")) {
      const inline = (node) => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1 || node.getAttribute("contenteditable") === "false") return null;
        if (node.tagName === "BR") return node.classList.contains("ProseMirror-trailingBreak") || (node.parentElement?.tagName === "P" && node.parentElement.childNodes.length === 1) ? "" : "\n";
        if (!["P", "SPAN", "STRONG", "B", "EM", "I", "U", "S", "STRIKE", "A", "CODE", "MARK"].includes(node.tagName)) return null;
        const parts = [...node.childNodes].map(inline);
        return parts.includes(null) ? null : parts.join("");
      };
      const lines = paragraphs.map(inline);
      return lines.includes(null) ? null : normalize(lines.join("\n"));
    }
    return normalize(element.innerText ?? element.textContent ?? "");
  };
  const titles = all(selectors.title), bodies = all(selectors.body);
  const candidates = all(selectors.images);
  const cards = candidates.filter((card) => !candidates.some((other) => other !== card && other.contains(card)));
  const images = cards.map((card) => {
    const image = card.querySelector("img");
    const key = null; // Assigned only after decoded image pixels have been hashed.
    return { key, source: image?.currentSrc || image?.getAttribute("src") || "", loaded: Boolean(image?.complete && image.naturalWidth > 0),
      ready: Boolean(image?.complete && image.naturalWidth > 0 && card.querySelector(".image-editor-control .edit-btn")),
      failed: [...card.querySelectorAll(".mask.failed")].some(visible),
      processing: [...card.querySelectorAll(".mask.prerender, .processing-container, .mask.uploading, .progress-container")].some(visible) };
  });
  const drafts = all('.draft-item[data-draft-type="image"][data-draft-id]').flatMap((card) => {
    const id = card.getAttribute("data-draft-id");
    const titles = [...card.querySelectorAll(".draft-title-text")].filter(visible);
    return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && titles.length === 1
      ? [{ id, text: (titles[0].innerText ?? titles[0].textContent ?? "").trim() }] : [];
  });
  return { title: titles.length === 1 ? fieldText(titles[0]) : null, body: bodies.length === 1 ? fieldText(bodies[0]) : null,
    images,
    drafts,
    blocked: all(".d-dialog, .el-dialog, .d-modal").length > 0 };
}

export function compareDraftEvidence(evidence, { title, body, draftRef }) {
  return evidence.title === title && evidence.body === body && !evidence.blocked
    && evidence.images.length === draftRef.images.length
    && evidence.images.every((image, index) => image.loaded && !image.failed && !image.processing && image.key === draftRef.images[index]);
}

// The native save button is inside a closed shadow root. Its own _onSave
// dispatches only the `save` event; _onPublish is a separate handler.
// Verified against project-publish-components.c6f26def.js on 2026-09-27.
export function saveNativeDraft() {
  const hosts = [...document.querySelectorAll("xhs-publish-btn")].filter((element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  });
  if (hosts.length !== 1) return "missing";
  const host = hosts[0];
  if (host.getAttribute("is-save-draft") !== "true" || host.getAttribute("save-text") !== "暂存离开"
    || typeof host._onSave !== "function") return "unsupported";
  if (host.getAttribute("save-disabled") !== "false") return "disabled";
  host._onSave();
  return "invoked";
}

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

// These are the only DOM mutation operations available to the extension.
// There is intentionally no publish command or generic selector/click command.
export function draftPageCommand({ action, selectors, image, title, body, draftId, expectedCount }) {
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const text = (element) => (element.innerText ?? element.textContent ?? "").trim();
  const matches = (pattern) => [...document.querySelectorAll("button, a, span, div")]
    .filter((element) => visible(element) && pattern.test(text(element)))
    .filter((element, _index, elements) => !elements.some((other) => other !== element && element.contains(other)));
  const url = new URL(location.href);
  if (url.origin !== "https://creator.xiaohongshu.com" || url.pathname !== "/publish/publish" || url.searchParams.get("target") !== "image") return { ok: false, reason: "wrong_page" };
  const entry = matches(/^草稿箱\s*[（(]\d+[）)]$/u);
  const tabs = matches(/^图文笔记\s*[（(]\d+[）)]$/u);
  if (action === "list-state") return { ok: true, entryCount: entry.length, tabCount: tabs.length, count: tabs.length === 1 ? Number(/[（(](\d+)[）)]/u.exec(text(tabs[0]))?.[1]) : null };
  if (action === "open-drafts" || action === "image-tab") {
    const targets = action === "open-drafts" ? entry : tabs;
    if (targets.length !== 1) return { ok: false, reason: "ambiguous" };
    targets[0].click(); return { ok: true };
  }
  if (action === "edit-draft") {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(draftId)) return { ok: false, reason: "invalid_draft" };
    const cards = all('.draft-item[data-draft-type="image"][data-draft-id]')
      .filter((element) => element.getAttribute("data-draft-id") === draftId);
    const edit = cards.length === 1 ? [...cards[0].querySelectorAll(".btn")].filter((element) => visible(element) && text(element) === "编辑") : [];
    if (edit.length !== 1) return { ok: false, reason: "ambiguous" };
    edit[0].click(); return { ok: true };
  }
  if (all(".d-dialog, .el-dialog, .d-modal").length) return { ok: false, reason: "blocked" };
  if (action === "upload") {
    const inputs = [...document.querySelectorAll(selectors.input)];
    const candidates = all(selectors.images);
    const cards = candidates.filter((card) => !candidates.some((other) => other !== card && other.contains(card)));
    if (inputs.length !== 1 || cards.length !== expectedCount || !image || !["image/png", "image/jpeg"].includes(image.mime)
      || typeof image.base64 !== "string" || image.base64.length > 14_000_000) return { ok: false, reason: "upload_changed" };
    const raw = atob(image.base64), bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], image.name, { type: image.mime }));
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if (action === "fill") {
    const titles = all(selectors.title), bodies = all(selectors.body);
    if (titles.length !== 1 || bodies.length !== 1 || typeof title !== "string" || typeof body !== "string") return { ok: false, reason: "ambiguous" };
    if (("value" in titles[0] ? titles[0].value : titles[0].textContent).trim() || bodies[0].textContent.trim()) return { ok: false, reason: "existing_text" };
    const fillEditable = (element, value) => {
      element.focus();
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      // Let the native editing/input event update ProseMirror's own document.
      // Direct innerHTML assignment would only change the displayed DOM.
      if (value) return document.execCommand("insertText", false, value);
      return document.execCommand("delete", false);
    };
    if (titles[0] instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return { ok: false, reason: "unsupported" };
      titles[0].focus(); setter.call(titles[0], title);
      titles[0].dispatchEvent(new Event("input", { bubbles: true }));
      titles[0].dispatchEvent(new Event("change", { bubbles: true }));
    } else if (!fillEditable(titles[0], title)) return { ok: false, reason: "unsupported" };
    if (body && !fillEditable(bodies[0], body)) return { ok: false, reason: "unsupported" };
    return { ok: true };
  }
  return { ok: false, reason: "unsupported" };
}
