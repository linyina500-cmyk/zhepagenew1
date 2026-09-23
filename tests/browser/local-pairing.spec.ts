import { expect, test, type BrowserContext } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { createPairingServer, closeLocalServers, PAIRING_APP_ORIGIN } from "../../server/wechat/pairing.mjs";

// Entirely synthetic browser contexts: the apparent HTTPS origins below are
// fulfilled in memory. Only this test's ephemeral loopback server reaches a socket.
const connectionToken = "isolated-browser-pairing-fixture-token-".repeat(2);
const deviceId = "d".repeat(32), nonce = "e".repeat(64);
const foreignOrigin = "https://foreign-pairing.invalid";

async function fixture(context: BrowserContext, appOrigin: string) {
  const server = createPairingServer({ deviceId, syncToken: connectionToken });
  const requests: { origin?: string; method?: string }[] = [];
  const unexpected: string[] = [];
  server.on("request", (request) => {
    if (request.url === "/pair") requests.push({ origin: request.headers.origin, method: request.method });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${appOrigin}/__pairing-test`;
  await context.route("**/*", async (route) => {
    const target = route.request().url();
    if (target === url) {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Isolated pairing fixture</title>
        <button id="connect" type="button">连接测试助手</button><p id="ready">未收到</p><output id="received">[]</output>
        <script>
          const localOrigin = ${JSON.stringify(localOrigin)}, nonce = ${JSON.stringify(nonce)};
          let popup; const received = [];
          document.getElementById("connect").addEventListener("click", () => { popup = window.open(localOrigin + "/connect", "", "popup,width=480,height=340"); });
          window.addEventListener("message", (event) => {
            if (event.source !== popup || event.origin !== localOrigin) return;
            if (event.data?.type === "zhepage-local-ready") {
              document.getElementById("ready").textContent = "已收到";
              const request = { type: "zhepage-local-connect", nonce };
              popup.postMessage(request, localOrigin); popup.postMessage(request, localOrigin);
            }
            if (event.data?.type === "zhepage-local-connected") {
              received.push(event.data); document.getElementById("received").textContent = JSON.stringify(received);
            }
          });
        </script></html>` });
    } else if (target === `${localOrigin}/connect` || target === `${localOrigin}/pair`) {
      await route.continue();
    } else if (target === `${appOrigin}/favicon.ico` || target === `${localOrigin}/favicon.ico`) {
      await route.fulfill({ status: 204, body: "" });
    } else {
      unexpected.push(target); await route.abort("blockedbyclient");
    }
  });
  return { url, localOrigin, requests, unexpected, close: () => closeLocalServers(server) };
}

test("real loopback popup keeps opener and pairs once through a browser same-origin POST", async ({ context, page }) => {
  const f = await fixture(context, PAIRING_APP_ORIGIN);
  try {
    await page.goto(f.url);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "连接测试助手" }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole("status")).toHaveText("已连接，可以关闭此窗口。");
    expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
    await expect(page.locator("#received")).toHaveText(JSON.stringify([{ type: "zhepage-local-connected", nonce, deviceId, connectionToken }]));
    expect(f.requests).toEqual([{ origin: f.localOrigin, method: "POST" }]);
    expect(f.unexpected).toEqual([]);
    await popup.close();
  } finally { await f.close(); }
});

test("a foreign HTTPS opener receives readiness only and cannot request local credentials", async ({ context, page }) => {
  const f = await fixture(context, foreignOrigin);
  try {
    await page.goto(f.url);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "连接测试助手" }).click();
    const popup = await popupPromise;
    await expect(page.locator("#ready")).toHaveText("已收到");
    // Give both posted requests an event-loop turn; no credential request may run.
    await popup.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
    await expect(popup.getByRole("status")).toHaveText("正在等待折页连接…");
    await expect(page.locator("#received")).toHaveText("[]");
    expect(f.requests).toEqual([]); expect(f.unexpected).toEqual([]);
    await popup.close();
  } finally { await f.close(); }
});
