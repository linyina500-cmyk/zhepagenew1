const API_ORIGIN = "http://127.0.0.1:8788";

// Only this device receives account credentials and images. The address is
// fixed in code, never supplied by a page, account, redirect or saved draft.
export const localSyncFetch: typeof fetch = (input, init) => {
  if (typeof input !== "string" || !/^\/api\/(?:wechat|xiaohongshu)\/[a-zA-Z0-9/_%-]+$/.test(input)) {
    throw new Error("本机同步地址无效，请重新连接这台电脑。");
  }
  const options: RequestInit & { targetAddressSpace: string } = {
    ...init, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", targetAddressSpace: "loopback",
  };
  return fetch(`${API_ORIGIN}${input}`, options);
};
