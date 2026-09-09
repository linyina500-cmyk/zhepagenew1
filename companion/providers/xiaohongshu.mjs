// Selectors and the draft-only web-component action are adapted from OpenCLI.
// Modified 2026-09-09. See ../THIRD_PARTY_NOTICES.md for attribution and license.
import { Buffer } from "node:buffer";
import { validateDraft } from "../../lib/draftSync/validation.ts";

const ORIGIN = "https://creator.xiaohongshu.com";
const HOME_URL = `${ORIGIN}/new/home`;
const COMPOSER_URL = `${ORIGIN}/publish/publish?from=menu_left&target=image`;
const IDENTITY_PATH = "/api/galaxy/user/info";
const SELECTORS = {
  title: [
    '[contenteditable="true"][placeholder*="标题"]',
    '[contenteditable="true"][placeholder*="赞"]',
    'input[placeholder*="标题"]',
    'input[placeholder*="title" i]',
    '[contenteditable="true"][class*="title"]',
    '.title-input input',
    '.note-title input',
  ],
  body: [
    '[contenteditable="true"][class*="content"]',
    '[contenteditable="true"][class*="editor"]',
    '[contenteditable="true"][placeholder*="描述"]',
    '[contenteditable="true"][placeholder*="正文"]',
    '[contenteditable="true"][placeholder*="内容"]',
    '.note-content [contenteditable="true"]',
    '.editor-content [contenteditable="true"]',
  ],
  images: '.img-preview-area .pr',
  input: 'input[type="file"][accept*="image"], input[type="file"][accept*=".jpg"], input[type="file"][accept*=".jpeg"], input[type="file"][accept*=".png"]',
  progress: '[class*="upload"][class*="progress"], [class*="uploading"], [class*="loading"][class*="image"]',
};

function identityFrom(payload) {
  if (!payload || payload.success === false || (typeof payload.code === "number" && payload.code !== 0)) return null;
  const { userId, userName } = payload.data || {};
  if (typeof userId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) return null;
  if (typeof userName !== "string" || !userName.trim() || userName.length > 200) return null;
  return { remoteId: userId, displayName: userName.trim() };
}

async function readIdentity(page) {
  // This endpoint identifies the current creator session. The www profile page
  // may be another user or a different login; it must never identify this account.
  const payload = await page.evaluate(async ({ origin, path }) => {
    if (location.origin !== origin) return null;
    try {
      const response = await fetch(path, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(10000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }, { origin: ORIGIN, path: IDENTITY_PATH });
  return identityFrom(payload);
}

function result(page, status, message) {
  // Do not expose query parameters, browser errors, cookies, or response bodies.
  let url = HOME_URL;
  try {
    const current = new URL(page.url());
    if (current.origin === ORIGIN) url = `${current.origin}${current.pathname}`;
  } catch { /* The tab may have been closed by the user. */ }
  return { status, message, url };
}

export async function loginXiaohongshu({ context }) {
  const page = await context.newPage();
  let received;
  let resume;
  let timer;
  const onResponse = async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== ORIGIN || url.pathname !== IDENTITY_PATH || !response.ok()) return;
      const identity = identityFrom(await response.json());
      if (identity) { received = identity; resume?.(identity); }
    } catch { /* Login responses without a verified account are ignored. */ }
  };
  page.on("response", onResponse);
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront();
    // Completing login can navigate while evaluate is waiting for fetch. Keep
    // listening on this same tab when its initial execution context disappears.
    const identity = await readIdentity(page).catch(() => null);
    if (identity) return identity;
    if (received) return received;
    return await new Promise((resolve, reject) => {
      resume = resolve;
      timer = setTimeout(() => reject(new Error("请在打开的创作中心完成登录后重新连接账号")), 120000);
    });
  } finally {
    page.off("response", onResponse);
    clearTimeout(timer);
  }
}

// This function runs inside the page. It reads only the composer surface and
// returns no user content except fields needed for the exact local comparison.
function composerState(config) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const value = (element) => element ? ("value" in element ? element.value : element.innerText ?? element.textContent ?? "") : "";
  const locate = (selectors, exclude) => {
    for (const selector of selectors) {
      const all = [...document.querySelectorAll(selector)];
      const candidates = all.filter((element) => visible(element) && element !== exclude);
      if (candidates.length > 1) return null;
      if (candidates.length === 1) return { element: candidates[0], selector, index: all.indexOf(candidates[0]) };
    }
    return null;
  };
  const title = locate(config.title);
  const body = locate(config.body, title?.element);
  const inputs = [...document.querySelectorAll(config.input)].filter((element) => !element.disabled);
  const selectedFiles = [...document.querySelectorAll('input[type="file"]')].some((element) => element.files?.length);
  const images = [...document.querySelectorAll(config.images)].filter(visible).length;
  const progress = [...document.querySelectorAll(config.progress)].some(visible);
  const dialog = [...document.querySelectorAll('[role="dialog"], .d-dialog, .el-dialog, .modal, .d-modal')].some(visible);
  const otherContent = [...document.querySelectorAll([...config.title, ...config.body].join(","))].some((element) => visible(element) && value(element).trim());
  const editingExisting = /(?:draft|note)_?id=/i.test(location.search);
  const state = {
    title: title && { selector: title.selector, index: title.index, value: value(title.element) },
    body: body && { selector: body.selector, index: body.index, value: value(body.element) },
    inputs: inputs.length, images, progress, dialog,
    existing: Boolean(otherContent || images || selectedFiles || editingExisting || dialog),
  };
  if (config.waitFor === "input") return state.existing || state.inputs === 1;
  if (config.waitFor === "upload") return images === config.expectedImages && !progress && !dialog && Boolean(title && body);
  return state;
}

async function inspect(page) { return page.evaluate(composerState, SELECTORS); }

async function fillField(page, field, text) {
  const locator = page.locator(field.selector).nth(field.index);
  await locator.fill(text, { timeout: 10000 });
  await locator.blur({ timeout: 10000 });
}

function normalized(value) { return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " "); }

function matchesContent(state, draft) {
  return !state.dialog && !state.progress && state.images === draft.images.length &&
    normalized(state.title?.value ?? "") === normalized(draft.title) &&
    normalized(state.body?.value ?? "") === normalized(draft.body);
}

async function invokeDraftOnce(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const disabled = (element) => element.disabled || element.getAttribute("aria-disabled") === "true";
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => visible(element) && (element.innerText || element.textContent || "").trim() === "暂存离开");
    if (buttons.length > 1 || (buttons.length === 1 && disabled(buttons[0]))) return false;
    if (buttons.length === 1) { buttons[0].click(); return true; }
    // The current creator component has a closed shadow root. Only the known
    // save method is callable here. A thrown call must never trigger a retry.
    const hosts = [...document.querySelectorAll("xhs-publish-btn")].filter(visible);
    if (hosts.length !== 1) return false;
    const host = hosts[0];
    if (disabled(host) || host.saveDisabled === true || host.getAttribute("save-disabled") === "true") return false;
    const label = host.getAttribute("save-text");
    if (label && label !== "暂存离开") return false;
    const method = ["_onSave", "_onSaveDraft", "_onDraft"].find((name) => typeof host[name] === "function");
    if (!method) return false;
    const pending = host[method]();
    // Only a trigger receipt is available. A pending platform promise must not
    // leave the local job permanently active, and a rejection never retries.
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
    return true;
  });
}

export async function saveXiaohongshuDraft({ context, account, draft }) {
  let snapshot;
  try {
    if (typeof account?.remoteId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(account.remoteId)) throw new Error();
    if (typeof draft?.title !== "string" || typeof draft.body !== "string" || !Array.isArray(draft.images)) throw new Error();
    snapshot = {
      title: draft.title, body: draft.body,
      images: draft.images.map((image) => {
        if (!image || !Buffer.isBuffer(image.bytes) || typeof image.name !== "string") throw new Error();
        return { ...image, bytes: Buffer.from(image.bytes) };
      }),
    };
    const invalid = validateDraft("xiaohongshu", snapshot, snapshot.images.map((image) => ({ ...image, size: image.bytes.length })))
      .find((issue) => issue.severity === "error");
    if (invalid) return { status: "failed", message: invalid.message };
  } catch { return { status: "failed", message: "小红书账号或本地图片数据无效，请重新选择" }; }

  const remoteId = account.remoteId;
  const page = await context.newPage();
  let uploadStarted = false;
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront();
    const identity = await readIdentity(page);
    if (!identity) return result(page, "failed", "无法确认创作中心当前账号，请在打开的窗口完成登录后重试");
    if (identity.remoteId !== remoteId) return result(page, "failed", "创作中心当前账号与所选账号不一致，已停止同步");
    await page.goto(COMPOSER_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(composerState, { ...SELECTORS, waitFor: "input" }, { timeout: 20000 });
    let state = await inspect(page);
    if (state.existing) return result(page, "needs_confirmation", "创作中心出现已有内容或弹窗，已保留页面；请先检查该草稿后再继续");
    if (state.inputs !== 1) return result(page, "failed", "无法确定图文上传入口，请检查打开的创作中心页面");

    // Upload each image only after the previous preview has settled. This keeps
    // the requested order even when individual uploads finish at different times.
    for (let index = 0; index < snapshot.images.length; index += 1) {
      state = await inspect(page);
      if (state.inputs !== 1 || state.dialog || state.images !== index) return result(page, "needs_confirmation", "图片上传页面发生变化，请在创作中心核对，当前内容已保留");
      const identityBeforeUpload = await readIdentity(page);
      if (identityBeforeUpload?.remoteId !== remoteId) return result(page, uploadStarted ? "needs_confirmation" : "failed", "创作中心登录账号发生变化，已停止同步，请核对当前页面");
      state = await inspect(page);
      if (state.inputs !== 1 || state.dialog || state.progress || state.images !== index ||
          state.title?.value || state.body?.value || (index === 0 && state.existing)) {
        return result(page, "needs_confirmation", "创作中心恢复了其他内容或页面发生变化，已停止上传，请先核对当前草稿");
      }
      const image = snapshot.images[index];
      uploadStarted = true;
      // File inputs are commonly hidden. setInputFiles is the browser's native
      // upload route and accepts these buffers without writing temporary files.
      const inputs = page.locator(SELECTORS.input.split(",").map((selector) => `${selector.trim()}:not(:disabled)`).join(", "));
      await inputs.setInputFiles({ name: image.name, mimeType: image.mime, buffer: image.bytes }, { timeout: 30000 });
      await page.waitForFunction(composerState, { ...SELECTORS, waitFor: "upload", expectedImages: index + 1 }, { timeout: 60000 });
    }
    const identityBeforeFill = await readIdentity(page);
    if (identityBeforeFill?.remoteId !== remoteId) return result(page, "needs_confirmation", "填写前发现创作中心账号变化，已停止操作，请核对当前账号及图片");
    state = await inspect(page);
    if (!state.title || !state.body || state.title.value || state.body.value || state.dialog || state.progress || state.images !== snapshot.images.length) return result(page, "needs_confirmation", "图文编辑区域出现其他内容，请在创作中心核对，当前图片已保留");
    await fillField(page, state.title, snapshot.title);
    state = await inspect(page);
    if (!state.body || state.body.value || state.dialog || state.progress || state.images !== snapshot.images.length || normalized(state.title?.value ?? "") !== normalized(snapshot.title)) return result(page, "needs_confirmation", "填写时页面内容发生变化，已停止操作，请核对创作中心文案");
    await fillField(page, state.body, snapshot.body);
    const populated = await inspect(page);
    if (!matchesContent(populated, snapshot)) {
      return result(page, "needs_confirmation", "页面中的标题、文案或图片与本次素材未能完全核对，请手动检查后暂存");
    }
    const finalIdentity = await readIdentity(page);
    if (finalIdentity?.remoteId !== remoteId) return result(page, "needs_confirmation", "暂存前无法确认所选账号，已停止操作，请核对创作中心当前账号及内容");
    if (!matchesContent(await inspect(page), snapshot)) return result(page, "needs_confirmation", "暂存前页面内容发生变化，已停止操作，请核对当前标题、文案和图片");
    const invoked = await invokeDraftOnce(page);
    return result(page, "needs_confirmation", invoked
      ? "已触发“暂存离开”。平台未提供可验证的草稿回执，请到所选账号的草稿箱核对标题、文案和图片顺序"
      : "素材已填入创作中心，但未找到可确定的“暂存离开”操作，请检查页面并手动暂存");
  } catch {
    return result(page, uploadStarted ? "needs_confirmation" : "failed", uploadStarted
      ? "上传或暂存结果尚未确认。当前页面已保留，请到所选账号核对内容；确认未保存前不要重复同步"
      : "创作中心未就绪，请检查打开的窗口、登录状态和网络后重试");
  }
}
