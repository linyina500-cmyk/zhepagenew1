import { Buffer } from "node:buffer";

// The temporary QR-login session lifecycle is informed by xiaohongshu-mcp
// (Apache-2.0); no source code from that project is copied here:
// https://github.com/xpzouying/xiaohongshu-mcp/blob/332d196854a9eac0d2b8c2c0e3d0cc43139d724c/service.go#L136-L202
const ALLOWED_ORIGINS = new Set(["https://creator.xiaohongshu.com", "https://www.xiaohongshu.com"]);
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class CloudBrowserCleanupError extends Error {
  constructor() { super("云端浏览器未能完成清理"); this.name = "CloudBrowserCleanupError"; }
}

function allowedPageUrl(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ALLOWED_ORIGINS.has(url.origin);
  } catch { return false; }
}

function checkedSnapshot(value) {
  const invalid = () => new Error("云端账号授权资料无效，请重新连接账号");
  if (!isObject(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) throw invalid();
  for (const cookie of value.cookies) {
    if (!isObject(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" || !/^\.?(?:[a-z0-9-]+\.)*xiaohongshu\.com$/i.test(cookie.domain) ||
      typeof cookie.path !== "string" || !cookie.path.startsWith("/") || !Number.isFinite(cookie.expires) ||
      typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean" ||
      !["Strict", "Lax", "None"].includes(cookie.sameSite)) throw invalid();
  }
  for (const origin of value.origins) {
    if (!isObject(origin) || !ALLOWED_ORIGINS.has(origin.origin) || !Array.isArray(origin.localStorage) ||
      origin.localStorage.some((item) => !isObject(item) || typeof item.name !== "string" || typeof item.value !== "string")) throw invalid();
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw invalid(); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("云端账号授权资料超过 5 MiB，无法保存在当前浏览器中");
  }
  return JSON.parse(serialized);
}

/** launchOptions is trusted server configuration, never HTTP request input. */
export async function createCloudBrowser({ storageState, playwright, launchOptions = {} } = {}) {
  const initialState = storageState === undefined ? undefined : checkedSnapshot(storageState);
  if (!isObject(launchOptions) || "userDataDir" in launchOptions ||
    (launchOptions.args !== undefined && (!Array.isArray(launchOptions.args) || launchOptions.args.some((arg) =>
      typeof arg !== "string" || /^--(?:remote-debugging|user-data-dir)(?:[-=]|$)/.test(arg))))) {
    throw new Error("云端浏览器启动配置无效");
  }
  const { chromium } = playwright ?? await import("@playwright/test");
  const browser = await chromium.launch({ ...launchOptions, headless: true, chromiumSandbox: true });
  let context;
  let closePromise;
  let closed = false;
  const close = () => {
    if (!closePromise) {
      closed = true;
      closePromise = (async () => {
        try { await context?.close(); } catch { /* Closing the whole browser below also closes its contexts. */ }
        try { await browser.close(); } catch { throw new CloudBrowserCleanupError(); }
      })();
    }
    return closePromise;
  };
  try {
    context = await browser.newContext({ storageState: initialState, acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !allowedPageUrl(request.url())) await route.abort("blockedbyclient");
      else await route.continue();
    });
  } catch (error) {
    // Propagate a cleanup failure even when initialization did not return a
    // runtime object. The service must stop if this browser may still be alive.
    await close();
    throw error;
  }
  return {
    context,
    snapshot: async () => {
      if (closed) throw new Error("云端浏览器会话已结束，请重新连接账号");
      const state = await context.storageState({ indexedDB: true, opfs: true });
      if (closed) throw new Error("云端浏览器会话已结束，请重新连接账号");
      return checkedSnapshot(state);
    },
    screenshot: async () => {
      if (closed) return undefined;
      const page = context.pages().filter((candidate) => !candidate.isClosed()).at(-1);
      if (!page || !allowedPageUrl(page.url())) return undefined;
      const originalUrl = page.url();
      let navigated = false;
      const onNavigation = (frame) => { if (frame === page.mainFrame()) navigated = true; };
      page.on("framenavigated", onNavigation);
      try {
        const bytes = await page.screenshot({ type: "jpeg", quality: 70 });
        if (closed || page.isClosed() || navigated || page.url() !== originalUrl || !allowedPageUrl(page.url())) return undefined;
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
      } catch { return undefined; }
      finally { page.off("framenavigated", onNavigation); }
    },
    close,
  };
}
