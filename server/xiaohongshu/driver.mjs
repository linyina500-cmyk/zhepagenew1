import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readImageFingerprints } from "./image-evidence.mjs";

const ORIGIN = "https://creator.xiaohongshu.com";
const LOGIN_URL = `${ORIGIN}/login`;
const EDITOR_URL = `${ORIGIN}/publish/publish?from=menu_left&target=image`;
const ACCOUNT_URL = `${ORIGIN}/new/home`;
// Native editor and draft-card selectors verified in the creator UI.
export const SELECTORS = Object.freeze({
  title: 'input[placeholder*="标题"], [contenteditable="true"][placeholder*="标题"]',
  body: '.tiptap.ProseMirror[contenteditable="true"]',
  images: ".img-preview-area .pr",
  input: 'input[type="file"][multiple][accept*="image"], input[type="file"][multiple][accept*=".png"], input[type="file"][multiple][accept*=".jpg"]',
});

export class XhsDriverError extends Error {
  constructor(message, { status = 409, code = "page_needs_attention" } = {}) { super(message); this.name = "XhsDriverError"; this.status = status; this.code = code; }
}

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

export function createXhsBrowserDriver({ profileDir, chromium, timeoutMs = 60_000 }) {
  if (typeof profileDir !== "string" || !profileDir || (chromium && typeof chromium.launchPersistentContext !== "function")) throw new TypeError("小红书浏览器服务配置不完整");
  let context, page;
  let preparedJobId = null, saveAttempted = false;
  async function ensurePage({ navigate = true } = {}) {
    if (!context) {
      try {
        await mkdir(profileDir, { recursive: true, mode: 0o700 });
        const browserType = chromium ?? (await import("playwright")).chromium;
        // Keep this dedicated session on one direct network path. System proxy
        // egress can reach a CDN edge that returns HTTP 400 for valid draft images.
        // This does not change system proxy settings, TLS checks, or the sandbox.
        context = await browserType.launchPersistentContext(profileDir, { channel: "chrome", headless: false, chromiumSandbox: true, args: ["--no-proxy-server"], handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false, viewport: { width: 1440, height: 1000 } });
      } catch {
        throw new XhsDriverError("小红书专用窗口未能启动，请确认已安装 Google Chrome，再重新打开折页同步助手。", { status: 503, code: "browser_open_failed" });
      }
      context.setDefaultTimeout(10_000);
      const launched = context;
      context.on("close", () => {
        if (context === launched) { context = undefined; page = undefined; }
      });
    }
    if (page?.isClosed()) page = undefined;
    if (!page) {
      const pages = context.pages();
      // A second creator editor may contain user work. Never select arbitrarily.
      if (pages.filter((candidate) => candidate.url().startsWith(ORIGIN)).length > 1) throw new XhsDriverError("专用浏览器中有多个小红书页面，请保留一个后再连接");
      page = pages.find((candidate) => candidate.url().startsWith(ORIGIN)) ?? pages[0] ?? await context.newPage();
      if (navigate && !page.url().startsWith(ORIGIN)) {
        try { await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 15_000) }); }
        catch {
          page = undefined;
          throw new XhsDriverError("小红书页面暂时打不开，请确认网络正常后重试。", { status: 503, code: "page_open_failed" });
        }
      }
    }
    if (!page || page.isClosed()) throw new XhsDriverError("小红书窗口已关闭，请点击登录重新打开");
    return page;
  }
  const evidence = async () => {
    const state = await page.evaluate(readPageEvidence, { selectors: SELECTORS });
    if (state.images.length && state.images.every((image) => image.loaded && !image.processing && !image.failed)) {
      const keys = await page.evaluate(readImageFingerprints, { selectors: SELECTORS });
      const after = await page.evaluate(readPageEvidence, { selectors: SELECTORS });
      if (JSON.stringify(after) !== JSON.stringify(state)) {
        after.images.forEach((image) => { image.key = null; image.processing = true; });
        return after;
      }
      if (Array.isArray(keys) && keys.length === state.images.length) {
        state.images.forEach((image, index) => { image.key = keys[index]; });
      }
    }
    return state;
  };
  const transientNavigation = (error) => error instanceof Error
    && /Execution context was destroyed|Cannot find context with (?:specified )?id|interrupted by another navigation|net::ERR_ABORTED/iu.test(error.message);
  async function accountState() {
    await ensurePage();
    const currentUrl = new URL(page.url());
    if (currentUrl.origin !== ORIGIN) return { status: "needs_attention", message: "请将专用浏览器切回小红书创作服务平台" };
    let accountPage;
    try {
      // Read the current shared session afresh. Never navigate an editor that
      // may contain work, and never reuse a previous successful account read.
      accountPage = await context.newPage();
      const budget = Math.min(timeoutMs, 30_000), deadline = Date.now() + budget;
      try { await accountPage.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: budget }); }
      catch (error) { if (!transientNavigation(error)) throw error; }
      while (Date.now() < deadline) {
        if (accountPage.isClosed()) break;
        const url = new URL(accountPage.url());
        if (url.origin !== ORIGIN) break;
        try {
          if (url.pathname.startsWith("/login")) {
            const login = await accountPage.evaluate(readLoginEvidence);
            if (accountPage.isClosed()) break;
            const after = new URL(accountPage.url());
            if (Date.now() < deadline && after.origin === ORIGIN && after.pathname.startsWith("/login") && login.loginVisible) {
              return { status: "login_required", message: "请在打开的小红书专用浏览器中扫码登录" };
            }
          } else if (url.pathname === "/new/home") {
            const account = await accountPage.evaluate(readAccountEvidence);
            if (accountPage.isClosed()) break;
            const after = new URL(accountPage.url());
            if (Date.now() < deadline && after.origin === ORIGIN && after.pathname === "/new/home" && account) {
              return { status: "connected", account: {
                id: createHash("sha256").update(`xiaohongshu-account:${account.identifier}`).digest("hex").slice(0, 20), name: account.name,
              } };
            }
          }
        } catch (error) {
          // SPA initialization can replace its execution context. Retry reads
          // within the original budget, without navigating or exposing errors.
          if (!transientNavigation(error)) throw error;
        }
        if (accountPage.isClosed() || new URL(accountPage.url()).origin !== ORIGIN) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
      }
    } catch {
      // Browser errors can contain URLs or page data; expose a fixed message.
    } finally {
      if (accountPage) await accountPage.close().catch(() => {});
    }
    return { status: "needs_attention", message: "尚未从首页账号卡确认小红书账号标识，请核对专用窗口；当前不会上传图片" };
  }
  async function requireAccount(account) {
    const state = await accountState();
    if (state.status !== "connected" || state.account.id !== account.id) throw new XhsDriverError("小红书登录账号尚未确认或发生变化，请重新连接核对");
  }
  async function unique(locator, message) {
    const shown = locator.filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await shown.count();
      if (count === 1) return shown;
      if (count > 1) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
    }
    throw new XhsDriverError(message);
  }
  async function navigateEditor() {
    try { await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 30_000) }); }
    catch { throw new XhsDriverError("图文编辑页未正常加载，请检查专用窗口后重试"); }
  }
  async function draftList({ newFor } = {}) {
    let tab = page.getByText(/^图文笔记\s*[（(]\d+[）)]$/).filter({ visible: true });
    if (!newFor && await tab.count() === 0) {
      const entry = await unique(page.getByText(/^草稿箱\s*[（(]\d+[）)]$/), "未找到唯一草稿箱入口，请在专用浏览器核对");
      await entry.click();
    }
    tab = await unique(tab, "图文草稿列表尚未加载，请稍后核对");
    await tab.click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = /[（(](\d+)[）)]/.exec(await tab.innerText());
      if (!match) throw new XhsDriverError("草稿箱总数尚未确认，不能判断本次是否新增草稿");
      const expectedCount = Number(match[1]);
      const drafts = (await evidence()).drafts;
      const fresh = newFor ? drafts.filter((draft) => !newFor.beforeIds.includes(draft.id) && draft.text === newFor.title.trim()) : [];
      if (drafts.length === expectedCount && new Set(drafts.map((draft) => draft.id)).size === expectedCount
        && (!newFor || fresh.length === 1)) return drafts;
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
    async openLogin() {
      await ensurePage({ navigate: false });
      try { await page.bringToFront(); }
      catch { throw new XhsDriverError("小红书专用窗口无法显示，请重新打开折页同步助手后重试。", { status: 503, code: "window_focus_failed" }); }
      // Login stays in this visible window. Do not open and close a temporary
      // account tab while the user is scanning a QR code.
      const state = await evidence();
      if (state.images.length || state.title?.trim() || state.body?.trim() || state.blocked) {
        return { status: "needs_attention", reason: "editor_in_use", message: "小红书窗口中有未完成的编辑，请先保存或退出，再登录。原内容已保留。" };
      }
      const budget = Math.min(timeoutMs, 30_000), deadline = Date.now() + budget;
      try {
        // Explicit retries always navigate, even when a failed navigation has
        // already changed the address to the editor but left a blank page.
        try { await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: budget }); }
        catch (error) { if (!transientNavigation(error)) throw error; }
        while (Date.now() < deadline) {
          if (page.isClosed()) break;
          const url = new URL(page.url());
          if (url.origin !== ORIGIN) break;
          try {
            if (url.pathname.startsWith("/login")) {
              const login = await page.evaluate(readLoginEvidence);
              if (page.isClosed()) break;
              const after = new URL(page.url());
              if (Date.now() < deadline && after.origin === ORIGIN && after.pathname.startsWith("/login") && login.loginVisible) {
                return { status: "login_required", message: "请在小红书窗口扫码登录，完成后点击“我已登录”。" };
              }
            } else if (url.pathname === "/new/home") {
              const account = await page.evaluate(readAccountEvidence);
              if (page.isClosed()) break;
              const after = new URL(page.url());
              if (Date.now() < deadline && after.origin === ORIGIN && after.pathname === "/new/home" && account) {
                return { status: "connected", account: {
                  id: createHash("sha256").update(`xiaohongshu-account:${account.identifier}`).digest("hex").slice(0, 20), name: account.name,
                } };
              }
            }
          } catch (error) {
            if (!transientNavigation(error)) throw error;
          }
          if (page.isClosed() || new URL(page.url()).origin !== ORIGIN) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
        }
      } catch { /* Return a controlled failure, never raw browser data. */ }
      return { status: "needs_attention", reason: "login_page_unavailable", message: "小红书登录页未正常加载。请检查专用窗口和网络，再点击“打开登录窗口”重试。" };
    },
    async prepare({ jobId, account, title, body, images, onProgress }) {
      await requireAccount(account);
      if (!jobId || preparedJobId === jobId) throw new XhsDriverError("同一组编辑内容不能重复导入");
      let state = await evidence();
      if (state.images.length || state.title?.trim() || state.body?.trim()) throw new XhsDriverError("专用浏览器编辑器中已有内容，已保留原内容");
      if (new URL(page.url()).pathname !== "/publish/publish") {
        await navigateEditor();
        state = await evidence();
        if (state.images.length || state.title?.trim() || state.body?.trim() || state.blocked) throw new XhsDriverError("编辑器恢复了已有内容，请先保存或退出。原内容已保留。");
      }
      const before = await draftList();
      await navigateEditor();
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
        // Bind each source at its own append boundary using decoded pixels.
        // A later blob address cannot retroactively establish image identity.
        if (!IMAGE_KEY.test(state.images[index].key ?? "")) throw new XhsDriverError("图片内容暂时无法核对，请检查专用窗口");
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
      saveAttempted = true;
      // Exactly one invocation. Even a timeout may mean the platform saved it.
      const save = await page.evaluate(saveNativeDraft);
      if (save === "disabled") throw new XhsDriverError("暂存草稿按钮尚不可用");
      if (save !== "invoked") throw new XhsDriverError("未找到唯一可用的暂存草稿按钮");
      const drafts = await draftList({ newFor: prepared });
      const created = drafts.filter((draft) => !prepared.beforeIds.includes(draft.id) && draft.text === prepared.title.trim());
      if (created.length !== 1) return { message: "已触发暂存，但未确认唯一可回读的草稿编号，请在专用浏览器核对" };
      return { draftId: created[0].id, draftRef: { kind: "local", id: created[0].id, images: prepared.images } };
    },
    async verifyDraft({ draftRef, account, title, body, images }) {
      if (!validDraftRef(draftRef, images.length)) return { verified: false, message: "草稿缺少稳定的图片或条目标识，不能自动确认" };
      await ensurePage();
      const before = await evidence();
      if (before.images.length || before.title?.trim() || before.body?.trim()) return { verified: false, message: "专用浏览器中已有编辑内容，请先核对并退出编辑；当前不会离开或覆盖该页面" };
      if (new URL(page.url()).pathname !== "/publish/publish") {
        await navigateEditor();
        const restored = await evidence();
        if (restored.images.length || restored.title?.trim() || restored.body?.trim()) return { verified: false, message: "编辑器恢复了已有内容，已保留，请先核对专用窗口" };
      }
      const drafts = await draftList();
      if (drafts.filter((draft) => draft.id === draftRef.id).length !== 1) return { verified: false, message: "未找到原草稿，请在专用浏览器核对" };
      const card = page.locator(`.draft-item[data-draft-type="image"][data-draft-id="${draftRef.id}"]`);
      const edit = await unique(card.locator(".btn").filter({ hasText: /^编辑$/ }), "未找到原草稿的编辑入口");
      await edit.click();
      await requireAccount(account);
      const deadline = Date.now() + timeoutMs;
      let verified = false, lastState;
      while (Date.now() < deadline) {
        const state = await evidence();
        lastState = state;
        if (compareDraftEvidence(state, { title, body, draftRef })) { verified = true; break; }
        if (state.images.some((image) => image.failed) || state.images.length > images.length) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!verified && lastState?.images.length === images.length && lastState.images.some((image) => !image.loaded)) {
        return { verified: false, reason: "images_unavailable", message: "草稿已保存，但小红书图片暂时无法显示，请在专用窗口检查。原图已保留，请勿重复同步。" };
      }
      if (verified) await navigateEditor();
      return { verified, message: verified ? "已重新打开同一草稿，标题、配文和全部图片显示及顺序通过核对" : "重新打开的草稿内容或图片未通过核对，请在专用浏览器检查" };
    },
    async close() { if (context) await context.close(); context = undefined; page = undefined; },
  };
}
