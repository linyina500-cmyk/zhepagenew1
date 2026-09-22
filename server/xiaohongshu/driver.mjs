import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

const ORIGIN = "https://creator.xiaohongshu.com";
const EDITOR_URL = `${ORIGIN}/publish/publish?from=menu_left&target=image`;
// These editor selectors were observed by the previous browser adapter.
// Account links and draft links still require live acceptance testing. Missing
// stable identity deliberately stops automation rather than guessing by title.
export const SELECTORS = Object.freeze({
  title: 'input[placeholder*="标题"], [contenteditable="true"][placeholder*="标题"]',
  body: '.tiptap.ProseMirror[contenteditable="true"]',
  images: ".img-preview-area .pr",
  input: 'input[type="file"][multiple][accept*="image"], input[type="file"][multiple][accept*=".png"], input[type="file"][multiple][accept*=".jpg"]',
});

export class XhsDriverError extends Error {
  constructor(message) { super(message); this.name = "XhsDriverError"; }
}

export function validDraftRef(ref, imageCount) {
  if (!ref || typeof ref.id !== "string" || !ref.id || ref.id.length > 512 || !Array.isArray(ref.images)
    || ref.images.length !== imageCount || ref.images.some((key) => typeof key !== "string" || !key)) return false;
  try {
    if (ref.images.some((key) => { const url = new URL(key); return url.protocol !== "https:" || url.username || url.password; })) return false;
    const url = new URL(ref.url);
    return url.origin === ORIGIN && !url.username && !url.password && url.pathname === "/publish/publish"
      && url.searchParams.get("target") === "image"
      && ["draft_id", "draftId", "note_id", "noteId"].some((key) => url.searchParams.get(key) === ref.id);
  } catch { return false; }
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
        if (node.tagName === "BR") return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
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
    const source = image?.currentSrc || image?.getAttribute("src") || "";
    let key = null;
    try {
      const url = new URL(source);
      // Blob previews prove local decoding only. A remote URL is retained in
      // full: transformed URLs that change are not silently equated.
      if (url.protocol === "https:") key = url.href;
    } catch { /* No stable remote identity yet. */ }
    return { key, loaded: Boolean(image?.complete && image.naturalWidth > 0),
      ready: Boolean(image?.complete && image.naturalWidth > 0 && card.querySelector(".image-editor-control .edit-btn")),
      failed: [...card.querySelectorAll(".mask.failed")].some(visible),
      processing: [...card.querySelectorAll(".mask.prerender, .processing-container, .mask.uploading, .progress-container")].some(visible) };
  });
  const accounts = all('header a[href*="/user/profile/"], [role="banner"] a[href*="/user/profile/"]').flatMap((anchor) => {
    try {
      const url = new URL(anchor.href);
      const match = /^\/user\/profile\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
      const name = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "").trim();
      return url.hostname === "www.xiaohongshu.com" && match && name ? [{ uid: match[1].toLowerCase(), name }] : [];
    } catch { return []; }
  });
  const distinctAccounts = [...new Map(accounts.map((account) => [account.uid, account])).values()];
  const drafts = all("a[href]").flatMap((anchor) => {
    try {
      const url = new URL(anchor.href);
      const id = ["draft_id", "draftId", "note_id", "noteId"].map((key) => url.searchParams.get(key)).find(Boolean);
      return url.origin === "https://creator.xiaohongshu.com" && url.pathname === "/publish/publish"
        && url.searchParams.get("target") === "image" && id
        ? [{ id, url: url.href, text: (anchor.innerText || anchor.textContent || "").trim() }] : [];
    } catch { return []; }
  });
  return { title: titles.length === 1 ? fieldText(titles[0]) : null, body: bodies.length === 1 ? fieldText(bodies[0]) : null,
    images, account: distinctAccounts.length === 1 ? distinctAccounts[0] : null,
    drafts: [...new Map(drafts.map((draft) => [draft.id, draft])).values()],
    blocked: all(".d-dialog, .el-dialog, .d-modal").length > 0 };
}

export function compareDraftEvidence(evidence, { title, body, draftRef }) {
  return evidence.title === title && evidence.body === body && !evidence.blocked
    && evidence.images.length === draftRef.images.length
    && evidence.images.every((image, index) => image.loaded && !image.failed && !image.processing && image.key === draftRef.images[index]);
}

export function createXhsBrowserDriver({ profileDir, chromium, timeoutMs = 60_000 }) {
  if (typeof profileDir !== "string" || !profileDir || (chromium && typeof chromium.launchPersistentContext !== "function")) throw new TypeError("小红书浏览器服务配置不完整");
  let context, page;
  let preparedJobId = null, saveAttempted = false;
  async function ensurePage() {
    if (!context) {
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      const browserType = chromium ?? (await import("playwright")).chromium;
      context = await browserType.launchPersistentContext(profileDir, { channel: "chrome", headless: false, viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(10_000);
    }
    if (!page) {
      const pages = context.pages();
      // A second creator editor may contain user work. Never select arbitrarily.
      if (pages.filter((candidate) => candidate.url().startsWith(ORIGIN)).length > 1) throw new XhsDriverError("专用浏览器中有多个小红书页面，请保留一个后再连接");
      page = pages.find((candidate) => candidate.url().startsWith(ORIGIN)) ?? pages[0] ?? await context.newPage();
      if (!page.url().startsWith(ORIGIN)) await page.goto(EDITOR_URL);
    }
    if (!page || page.isClosed()) throw new XhsDriverError("小红书专用浏览器已关闭，请重启本机同步服务");
    return page;
  }
  const evidence = () => page.evaluate(readPageEvidence, { selectors: SELECTORS });
  async function accountState() {
    await ensurePage();
    const currentUrl = new URL(page.url());
    if (currentUrl.origin !== ORIGIN) return { status: "needs_attention", message: "请将专用浏览器切回小红书创作服务平台" };
    if (currentUrl.pathname.startsWith("/login")) return { status: "login_required", message: "请在打开的小红书专用浏览器中扫码登录" };
    const current = await evidence();
    if (!current.account) return { status: "needs_attention", message: "尚未从页面确认稳定的账号标识，请在专用浏览器核对登录；当前不会上传图片" };
    return { status: "connected", account: { id: createHash("sha256").update(current.account.uid).digest("hex").slice(0, 20), name: current.account.name } };
  }
  async function requireAccount(account) {
    const state = await accountState();
    if (state.status !== "connected" || state.account.id !== account.id) throw new XhsDriverError("小红书登录账号尚未确认或发生变化，请重新连接核对");
  }
  async function unique(locator, message) {
    const shown = locator.filter({ visible: true });
    if (await shown.count() !== 1) throw new XhsDriverError(message);
    return shown;
  }
  async function draftList() {
    const entry = await unique(page.getByText(/^草稿箱(?:\s*[（(]\d+[）)])?$/), "未找到唯一草稿箱入口，请在专用浏览器核对");
    const match = /[（(](\d+)[）)]/.exec(await entry.innerText());
    if (!match) throw new XhsDriverError("草稿箱总数尚未确认，不能判断本次是否新增草稿");
    const expectedCount = Number(match[1]);
    await entry.click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const drafts = (await evidence()).drafts;
      if (drafts.length === expectedCount) return drafts;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new XhsDriverError("草稿箱条目尚未完整读取，不能据此确认新增草稿");
  }
  async function waitImages(count) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const currentUrl = new URL(page.url());
      if (currentUrl.origin !== ORIGIN || currentUrl.pathname !== "/publish/publish" || currentUrl.searchParams.get("target") !== "image") throw new XhsDriverError("页面已离开小红书图文编辑器，请核对当前浏览器");
      const state = await evidence();
      if (state.images.some((image) => image.failed)) throw new XhsDriverError("小红书报告图片上传失败，请核对专用浏览器，不要重复创建");
      if (state.images.length > count) throw new XhsDriverError("编辑器图片数量发生变化，已停止上传");
      if (!state.blocked && state.images.length === count && state.images.every((image) => image.ready && !image.processing)) return state;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new XhsDriverError("小红书图片处理结果尚未确认，请核对专用浏览器");
  }
  return {
    checkConnection: accountState,
    async openLogin() { await ensurePage(); await page.bringToFront(); return accountState(); },
    async prepare({ jobId, account, title, body, images, onProgress }) {
      await requireAccount(account);
      if (!jobId || preparedJobId === jobId) throw new XhsDriverError("同一组编辑内容不能重复导入");
      let state = await evidence();
      if (state.images.length || state.title?.trim() || state.body?.trim()) throw new XhsDriverError("专用浏览器编辑器中已有内容，已保留原内容");
      const before = await draftList();
      await page.goto(EDITOR_URL);
      await requireAccount(account);
      state = await evidence();
      if (state.images.length || state.title?.trim() || state.body?.trim() || state.blocked) throw new XhsDriverError("请先处理小红书编辑器中的现有内容或提示");
      preparedJobId = jobId;
      saveAttempted = false;
      const imageKeys = [];
      const sameKnownImages = (current) => imageKeys.every((key, index) => key === null || current.images[index]?.key === key);
      for (let index = 0; index < images.length; index++) {
        state = await evidence();
        if (state.images.length !== index || !sameKnownImages(state)) throw new XhsDriverError("上传过程中图片或顺序发生变化，已停止");
        const input = page.locator(SELECTORS.input);
        if (await input.count() !== 1) throw new XhsDriverError("无法唯一确认原生图片上传入口");
        await input.setInputFiles(images[index].path);
        state = await waitImages(index + 1);
        if (!sameKnownImages(state)) throw new XhsDriverError("上传过程中已确认的图片顺序发生变化");
        // Record each newly appended image at its own upload boundary. A blob
        // preview remains unverifiable; a later URL must not retrospectively
        // establish which original file occupied that position.
        imageKeys.push(state.images[index].key);
        if (state.title?.trim() || state.body?.trim()) throw new XhsDriverError("上传期间文案发生变化，请核对浏览器");
        await onProgress(index + 1);
      }
      const titleField = await unique(page.locator(SELECTORS.title), "标题编辑区尚未确认");
      const bodyField = await unique(page.locator(SELECTORS.body), "配文编辑区尚未确认");
      await titleField.fill(title);
      await bodyField.fill(body);
      state = await waitImages(images.length);
      if (state.title !== title || state.body !== body || !sameKnownImages(state)) throw new XhsDriverError("填写后的标题、配文或图片顺序未能核对一致");
      return { jobId, account, title, body, beforeIds: before.map((draft) => draft.id), images: imageKeys };
    },
    async saveDraft({ prepared }) {
      if (preparedJobId !== prepared.jobId || saveAttempted) throw new XhsDriverError("本组内容已尝试保存，不能重复保存");
      await requireAccount(prepared.account);
      const state = await waitImages(prepared.images.length);
      if (state.title !== prepared.title || state.body !== prepared.body || state.images.some((image, index) => prepared.images[index] !== null && image.key !== prepared.images[index])) throw new XhsDriverError("保存前内容发生变化，请人工核对");
      const button = await unique(page.locator('button, [role="button"], a').filter({ hasText: /^(暂存离开|存草稿)$/ }), "未找到唯一可用的暂存草稿按钮");
      if (!await button.isEnabled()) throw new XhsDriverError("暂存草稿按钮尚不可用");
      saveAttempted = true;
      // Exactly one click. Even a timeout may mean the platform accepted it.
      await button.click();
      const drafts = await draftList();
      const created = drafts.filter((draft) => !prepared.beforeIds.includes(draft.id) && draft.text === prepared.title);
      if (created.length !== 1) return { message: "已触发暂存，但未确认唯一可回读的草稿编号，请在专用浏览器核对" };
      return { draftId: created[0].id, draftRef: { id: created[0].id, url: created[0].url, images: prepared.images } };
    },
    async verifyDraft({ draftRef, account, title, body, images }) {
      if (!validDraftRef(draftRef, images.length)) return { verified: false, message: "草稿缺少稳定的图片或条目标识，不能自动确认" };
      await requireAccount(account);
      const original = page.url();
      const before = await evidence();
      if (before.images.length || before.title?.trim() || before.body?.trim()) return { verified: false, message: "专用浏览器中已有编辑内容，请先核对并退出编辑；当前不会离开或覆盖该页面" };
      await page.goto(draftRef.url);
      await requireAccount(account);
      const state = await waitImages(images.length);
      const verified = compareDraftEvidence(state, { title, body, draftRef });
      if (verified && original !== draftRef.url) await page.goto(original);
      return { verified, message: verified ? "已重新打开同一草稿，标题、配文和全部图片显示及顺序通过核对" : "重新打开的草稿内容或图片未通过核对，请在专用浏览器检查" };
    },
    async close() { if (context) await context.close(); context = undefined; page = undefined; },
  };
}
