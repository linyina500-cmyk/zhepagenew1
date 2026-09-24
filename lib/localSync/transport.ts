const API_ORIGIN = "http://127.0.0.1:8788";

export class LocalSyncBrowserError extends Error {
  constructor() {
    super("请使用这台 Mac 上的 Chrome 浏览器连接本机助手，当前浏览器不支持此连接。");
    this.name = "LocalSyncBrowserError";
  }
}

export function assertLocalSyncBrowser(): void {
  if (typeof navigator === "undefined") return;
  const agent = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const webkit = /AppleWebKit/i.test(agent) && !/Chrome|Chromium|Edg|Firefox/i.test(agent);
  if (ios || webkit) throw new LocalSyncBrowserError();
}

// Only this device receives account credentials and images. The address is
// fixed in code, never supplied by a page, account, redirect or saved draft.
export const localSyncFetch: typeof fetch = (input, init) => {
  assertLocalSyncBrowser();
  if (typeof input !== "string" || !/^\/api\/(?:wechat|xiaohongshu)\/[a-zA-Z0-9/_%-]+$/.test(input)) {
    throw new Error("本机同步地址无效，请重新连接这台电脑。");
  }
  const options: RequestInit & { targetAddressSpace: string } = {
    ...init, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", targetAddressSpace: "loopback",
  };
  return fetch(`${API_ORIGIN}${input}`, options);
};
