import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { createPairingServer, closeLocalServers, PAIRING_APP_ORIGIN } from "../../server/wechat/pairing.mjs";

// Real HTTP receives multipart bytes (including WebKit uploads). The browser
// loads the built app under its trusted synthetic HTTPS origin and sends direct
// cross-origin requests to ephemeral loopback ports, never to a live helper.
export async function startWechatTestServer(
  previewOrigin: string,
  handleApi: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  credentials: { deviceId: string; connectionToken: string },
) {
  let failure: unknown;
  const server = createServer((incoming, outgoing) => {
    const fail = (error: unknown) => {
      failure = error;
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Test server failed to process the request" }));
    };
    if (incoming.headers.host !== `127.0.0.1:${incoming.socket.localPort}` || incoming.headers.origin !== PAIRING_APP_ORIGIN) {
      fail(new Error("Fixture requires the exact trusted origin and numeric loopback Host")); return;
    }
    outgoing.setHeader("Access-Control-Allow-Origin", PAIRING_APP_ORIGIN);
    outgoing.setHeader("Vary", "Origin");
    if (incoming.method === "OPTIONS") {
      outgoing.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "authorization, content-type" });
      outgoing.end(); return;
    }
    if (/^\/api\/(wechat|xiaohongshu)\//.test(incoming.url || "")) { void handleApi(incoming, outgoing).catch(fail); return; }
    fail(new Error("No website or remote forwarding is available on the local API fixture"));
  });
  const pairing = createPairingServer({ deviceId: credentials.deviceId, syncToken: credentials.connectionToken });
  for (const listener of [server, pairing]) await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pairingOrigin = `http://127.0.0.1:${(pairing.address() as AddressInfo).port}`;
  return {
    origin: PAIRING_APP_ORIGIN,
    async mount(page: Page) {
      if (page.context().browser()?.browserType().name() === "chromium") await page.context().grantPermissions(["local-network-access"], { origin: PAIRING_APP_ORIGIN });
      await page.route(`${PAIRING_APP_ORIGIN}/**`, async (route) => {
        const requested = new URL(route.request().url());
        if (requested.pathname.startsWith("/api/")) { failure = new Error("Platform requests must remain on this device"); await route.abort(); return; }
        const response = await route.fetch({ url: new URL(requested.pathname + requested.search, previewOrigin).href });
        await route.fulfill({ response });
      });
      await page.route("http://127.0.0.1:8788/**", (route) => route.continue({ url: new URL(new URL(route.request().url()).pathname, apiOrigin).href }));
      await page.route("http://127.0.0.1:8789/**", (route) => route.continue({ url: new URL(new URL(route.request().url()).pathname, pairingOrigin).href }));
    },
    failure: () => failure,
    close: () => closeLocalServers(server, pairing),
  };
}
