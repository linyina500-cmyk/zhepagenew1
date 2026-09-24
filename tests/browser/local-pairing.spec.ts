import { expect, test, type BrowserContext } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createPairingServer, closeLocalServers, PAIRING_APP_ORIGIN } from "../../server/wechat/pairing.mjs";
import { createWechatServer } from "../../server/wechat/http.mjs";

// No real account, helper port or website is used. HTTPS documents are synthetic;
// pairing and API replies come from the actual servers on ephemeral loopback ports.
const connectionToken = "isolated-browser-pairing-fixture-token-".repeat(2);
const deviceId = "d".repeat(32), nonce = "e".repeat(64);
const foreignOrigin = "https://foreign-pairing.invalid";
async function listen(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return (server.address() as AddressInfo).port;
}

async function fixture(context: BrowserContext, appOrigin: string) {
  const accounts = { deviceId, busy: () => false, list: () => [] };
  const requests: { service: string; origin?: string; method?: string; path?: string; authorized: boolean }[] = [];
  const unexpected: string[] = [];
  let pairing: Server, api: Server, pairingPort = 0, apiPort = 0;
  async function start() {
    pairing = createPairingServer({ deviceId, syncToken: connectionToken });
    api = createWechatServer({ accounts, syncToken: connectionToken, handleXhs: undefined });
    for (const [service, server] of [["pairing", pairing], ["api", api]] as const) server.on("request", (request) => {
      requests.push({ service, origin: request.headers.origin, method: request.method, path: request.url, authorized: Boolean(request.headers.authorization) });
    });
    pairingPort = await listen(pairing, pairingPort); apiPort = await listen(api, apiPort);
  }
  await start();
  const pairingOrigin = `http://127.0.0.1:${pairingPort}`, apiOrigin = `http://127.0.0.1:${apiPort}`;
  const url = `${appOrigin}/__pairing-test`;
  if (context.browser()?.browserType().name() === "chromium") await context.grantPermissions(["local-network-access"], { origin: appOrigin });
  context.on("request", (request) => {
    const target = request.url();
    if (target !== url && target !== `${appOrigin}/favicon.ico` && !target.startsWith(`${pairingOrigin}/`) && !target.startsWith(`${apiOrigin}/`)) unexpected.push(target);
  });
  await context.route(`${appOrigin}/**`, async (route) => {
    const target = route.request().url();
    if (target === url) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Isolated direct pairing fixture</title><link rel="icon" href="data:,">
        <button id="connect" type="button">连接测试助手</button><button id="check" type="button">检查已保存连接</button><p id="status">未连接</p><output id="received"></output>
        <script>
          const pairingOrigin = ${JSON.stringify(pairingOrigin)}, apiOrigin = ${JSON.stringify(apiOrigin)}, nonce = ${JSON.stringify(nonce)};
          let binding;
          async function check() {
            const response = await fetch(apiOrigin + "/api/wechat/connection", { credentials: "omit", cache: "no-store", redirect: "error", headers: { Authorization: "Bearer " + binding.connectionToken } });
            if (!response.ok) throw new Error("connection unavailable");
            const value = await response.json();
            if (value.deviceId !== binding.deviceId) throw new Error("device changed");
            document.getElementById("status").textContent = "已连接";
          }
          document.getElementById("connect").addEventListener("click", async () => {
            try {
              const response = await fetch(pairingOrigin + "/pair", { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });
              if (!response.ok) throw new Error("pairing failed");
              const value = await response.json();
              if (value.nonce !== nonce) throw new Error("nonce changed");
              binding = value;
              await check(); document.getElementById("received").textContent = JSON.stringify(value);
            } catch { document.getElementById("status").textContent = "助手尚未连接，请在本机打开后重试。"; }
          });
          document.getElementById("check").addEventListener("click", async () => {
            try { await check(); } catch { document.getElementById("status").textContent = "助手尚未连接，请在本机打开后重试。"; }
          });
        </script></html>` });
    } else if (target === `${appOrigin}/favicon.ico`) {
      await route.fulfill({ status: 204, body: "" });
    } else { unexpected.push(target); await route.abort("blockedbyclient"); }
  });
  return { url, pairingOrigin, apiOrigin, requests, unexpected, restart: start, close: () => closeLocalServers(pairing, api) };
}

test("trusted HTTPS origin pairs and authenticates through real cross-origin loopback responses without a popup", async ({ context, page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit blocks HTTPS to HTTP loopback; the boundary is asserted in its dedicated test.");
  const f = await fixture(context, PAIRING_APP_ORIGIN);
  try {
    await page.goto(f.url);
    // Disable interception completely: even an unmatched browser route can
    // suppress automatic CORS preflights in Chromium.
    await context.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "连接测试助手" }).click();
    await expect(page.locator("#status")).toHaveText("已连接");
    const received = JSON.parse(await page.locator("#received").textContent() || "null");
    expect(received).toEqual({ nonce, deviceId, connectionToken });
    expect(context.pages()).toHaveLength(1);
    expect(f.requests.filter((request) => request.method !== "OPTIONS")).toEqual([
      { service: "pairing", origin: PAIRING_APP_ORIGIN, method: "POST", path: "/pair", authorized: false },
      { service: "api", origin: PAIRING_APP_ORIGIN, method: "GET", path: "/api/wechat/connection", authorized: true },
    ]);
    expect(f.requests.some(({ service, method }) => service === "pairing" && method === "OPTIONS")).toBe(true);
    expect(f.requests.some(({ service, method }) => service === "api" && method === "OPTIONS")).toBe(true);
    expect(f.unexpected).toEqual([]);
    const invalidCredential = await page.evaluate(async (origin) => {
      const response = await fetch(origin + "/api/wechat/connection", { headers: { Authorization: "Bearer deliberately-wrong-token" }, credentials: "omit" });
      return { status: response.status, body: await response.text() };
    }, f.apiOrigin);
    expect(invalidCredential.status).toBe(401); expect(invalidCredential.body).not.toContain(connectionToken);
  } finally { await f.close(); }
});

test("foreign HTTPS origin cannot read pairing credentials or an authenticated local API", async ({ context, page }) => {
  const f = await fixture(context, foreignOrigin);
  try {
    await page.goto(f.url);
    // Disable interception completely: even an unmatched browser route can
    // suppress automatic CORS preflights in Chromium.
    await context.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "连接测试助手" }).click();
    await expect(page.locator("#status")).toContainText("助手尚未连接");
    await expect(page.locator("#received")).toBeEmpty();
    const denied = await page.evaluate(async ({ origin, token }) => {
      try { await fetch(origin + "/api/wechat/connection", { headers: { Authorization: "Bearer " + token }, credentials: "omit" }); return false; }
      catch { return true; }
    }, { origin: f.apiOrigin, token: connectionToken });
    expect(denied).toBe(true);
    expect(f.requests.every(({ method }) => method === "OPTIONS")).toBe(true);
    expect(context.pages()).toHaveLength(1); expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});

test("a stopped helper stays an inline failure and restarting the same local service reuses its saved connection", async ({ context, page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit blocks HTTPS to HTTP loopback; the boundary is asserted in its dedicated test.");
  const f = await fixture(context, PAIRING_APP_ORIGIN);
  try {
    await page.goto(f.url);
    // Disable interception completely: even an unmatched browser route can
    // suppress automatic CORS preflights in Chromium.
    await context.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "连接测试助手" }).click();
    await expect(page.locator("#status")).toHaveText("已连接");
    await f.close();
    await page.getByRole("button", { name: "检查已保存连接" }).click();
    await expect(page.locator("#status")).toContainText("助手尚未连接");
    expect(page.url()).toBe(f.url); expect(context.pages()).toHaveLength(1);
    const pairRequests = f.requests.filter(({ service, method }) => service === "pairing" && method === "POST").length;
    await f.restart();
    await page.getByRole("button", { name: "检查已保存连接" }).click();
    await expect(page.locator("#status")).toHaveText("已连接");
    expect(f.requests.filter(({ service, method }) => service === "pairing" && method === "POST")).toHaveLength(pairRequests);
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});


test("WebKit blocks real HTTPS-to-loopback pairing before any credential-bearing response reaches the page", async ({ context, page, browserName }) => {
  test.skip(browserName !== "webkit", "This is WebKit's actual mixed-content boundary; no browser security setting is disabled.");
  const f = await fixture(context, PAIRING_APP_ORIGIN);
  const blockedMessages: string[] = [];
  page.on("console", (message) => { if (message.text().includes("insecure content")) blockedMessages.push(message.text()); });
  try {
    await page.goto(f.url);
    await context.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "连接测试助手" }).click();
    await expect(page.locator("#status")).toContainText("助手尚未连接");
    await expect(page.locator("#received")).toBeEmpty();
    expect(blockedMessages.some((message) => message.includes(f.pairingOrigin))).toBe(true);
    expect(f.requests).toEqual([]);
    expect(context.pages()).toHaveLength(1);
    expect(page.url()).toBe(f.url);
    expect(f.unexpected).toEqual([]);
  } finally { await f.close(); }
});
