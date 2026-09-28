import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { DRAFT_EXTENSION_ID, EXTENSION_PROTOCOL } from "../../lib/localSync/transport";

const APP_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
type ExtensionBody = { kind: "json"; value: unknown } | { kind: "form"; entries: { key: string; value?: string; file?: { name: string; type: string; data: string } }[] };
type ExtensionMessage = { protocol: number; type: string; nonce?: string; path?: string; method?: string; token?: string; body?: ExtensionBody };

// Only the test runner talks to this ephemeral HTTP fixture. The product page
// uses its real extension transport and serializes every original image byte;
// the message adapter reconstructs multipart data for existing API assertions.
export async function startWechatTestServer(
  previewOrigin: string,
  handleApi: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  credentials: { deviceId: string; connectionToken: string },
) {
  let failure: unknown, stopped = false;
  const server = createServer((incoming, outgoing) => {
    const fail = (error: unknown) => {
      failure = error;
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Test server failed to process the request" }));
    };
    if (incoming.headers.host !== `127.0.0.1:${incoming.socket.localPort}` || incoming.headers.origin !== APP_ORIGIN) {
      fail(new Error("Fixture requires its exact test origin and loopback Host")); return;
    }
    if (/^\/api\/(wechat|xiaohongshu)\//.test(incoming.url || "")) { void handleApi(incoming, outgoing).catch(fail); return; }
    fail(new Error("No website or remote forwarding is available on the test API"));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin: APP_ORIGIN,
    async mount(page: Page) {
      await page.route(`${APP_ORIGIN}/**`, async (route) => {
        const requested = new URL(route.request().url());
        if (requested.pathname.startsWith("/api/")) { failure = new Error("Platform requests must use extension messaging"); await route.abort(); return; }
        const response = await route.fetch({ url: new URL(requested.pathname + requested.search, previewOrigin).href, headers: { ...route.request().headers(), host: new URL(previewOrigin).host } });
        await route.fulfill({ response });
      });
      page.on("request", (request) => {
        if (/^http:\/\/(?:127\.0\.0\.1|localhost):878[89]\//.test(request.url())) failure = new Error("Product attempted a legacy local-helper request");
      });
      await page.exposeBinding("__zhepageTestExtensionMessage", async ({ frame }, id: string, message: ExtensionMessage) => {
        if (stopped) return { unavailable: true };
        try {
          if (new URL(frame.url()).origin !== APP_ORIGIN || id !== DRAFT_EXTENSION_ID || message.protocol !== EXTENSION_PROTOCOL) throw new Error("Unexpected extension message identity");
          if (message.type === "pair") return { response: { ...credentials, nonce: message.nonce } };
          if (message.type !== "request" || typeof message.path !== "string" || !/^\/api\/(?:wechat|xiaohongshu)\/[a-zA-Z0-9/_%-]+$/.test(message.path)) throw new Error("Unexpected extension request path");
          const headers: Record<string, string> = { Origin: APP_ORIGIN, Authorization: `Bearer ${message.token}` };
          let body: string | FormData | undefined;
          if (message.body?.kind === "json") { headers["Content-Type"] = "application/json"; body = JSON.stringify(message.body.value); }
          if (message.body?.kind === "form") {
            const form = new FormData();
            for (const entry of message.body.entries) {
              if (entry.file) form.append(entry.key, new Blob([Buffer.from(entry.file.data, "base64")], { type: entry.file.type }), entry.file.name);
              else if (typeof entry.value === "string") form.append(entry.key, entry.value);
              else throw new Error("Malformed extension form entry");
            }
            body = form;
          }
          const response = await fetch(new URL(message.path, apiOrigin), { method: message.method, headers, body, redirect: "error" });
          return { response: { status: response.status, body: await response.json() } };
        } catch (error) { failure = error; return { response: { status: 500, body: { error: "Extension fixture failed" } } }; }
      });
      await page.addInitScript(() => {
        type Runtime = { lastError?: { message: string }; sendMessage(id: string, message: unknown, callback: (response: unknown) => void): void };
        const scope = window as typeof window & { chrome?: { runtime?: Runtime }; __zhepageTestExtensionMessage: (id: string, message: unknown) => Promise<{ unavailable?: boolean; response?: unknown }> };
        const runtime: Runtime = {
          sendMessage(id, message, callback) {
            void scope.__zhepageTestExtensionMessage(id, message).then((result) => {
              if (result.unavailable) runtime.lastError = { message: "No receiving extension" };
              callback(result.response); delete runtime.lastError;
            }, () => {
              runtime.lastError = { message: "Extension fixture disconnected" };
              callback(undefined); delete runtime.lastError;
            });
          },
        };
        if (!scope.chrome) Object.defineProperty(scope, "chrome", { value: {}, configurable: true });
        Object.defineProperty(scope.chrome!, "runtime", { value: runtime, configurable: true });
      });
    },
    failure: () => failure,
    async close() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
