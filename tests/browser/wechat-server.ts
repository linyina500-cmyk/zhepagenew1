import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Receive uploads over HTTP: WebKit's intercepted request metadata can omit
// multipart file bytes. Proxy the built app so its API request remains same-origin.
export async function startWechatTestServer(
  previewOrigin: string,
  handleApi: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  let failure: unknown;
  const server = createServer((incoming, outgoing) => {
    const fail = (error: unknown) => {
      failure = error;
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "Test server failed to process the request" }));
    };
    if (incoming.url?.startsWith("/api/wechat/")) {
      void handleApi(incoming, outgoing).catch(fail);
      return;
    }
    const target = new URL(incoming.url || "/", previewOrigin);
    const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", fail);
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    failure: () => failure,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
