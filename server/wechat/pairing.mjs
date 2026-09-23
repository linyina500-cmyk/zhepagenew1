import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const PAIRING_APP_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
export const PAIRING_PORT = 8789;

// Only the opener's verified origin receives the credentials. The static page
// contains neither credentials nor an app-controlled return URL.
const script = `(() => {
  const appOrigin = ${JSON.stringify(PAIRING_APP_ORIGIN)};
  const status = document.getElementById("status");
  const opener = window.opener;
  if (!opener) { status.textContent = "请回到折页，点击连接这台电脑。"; return; }
  let attempted = false;
  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (attempted || event.source !== opener || event.origin !== appOrigin || !data ||
      data.type !== "zhepage-local-connect" || typeof data.nonce !== "string" || !/^[a-f0-9]{64}$/.test(data.nonce)) return;
    attempted = true;
    status.textContent = "正在连接这台电脑…";
    try {
      const response = await fetch("/pair", { method: "POST", credentials: "omit", cache: "no-store", redirect: "error" });
      if (!response.ok) throw new Error("pairing failed");
      const connection = await response.json();
      if (typeof connection.deviceId !== "string" || typeof connection.connectionToken !== "string") throw new Error("invalid connection");
      opener.postMessage({ type: "zhepage-local-connected", nonce: data.nonce,
        deviceId: connection.deviceId, connectionToken: connection.connectionToken }, appOrigin);
      status.textContent = "已连接，可以关闭此窗口。";
    } catch { status.textContent = "连接未完成，请回到折页重试。"; }
  });
  opener.postMessage({ type: "zhepage-local-ready" }, "*");
})();`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>连接折页</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f7;color:#20232b;font:16px/1.7 system-ui,sans-serif}main{max-width:26rem;padding:2rem}h1{font-size:26px;margin:0 0 1rem}p{color:#687080}</style><main><h1>连接这台电脑</h1><p id="status" role="status">正在等待折页连接…</p></main><script>${script}</script></html>`;
const csp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

export function createPairingServer({ deviceId, syncToken }) {
  if (typeof deviceId !== "string" || !/^[a-f0-9]{32}$/.test(deviceId)
    || typeof syncToken !== "string" || syncToken.length < 32 || syncToken.length > 256 || /\s/u.test(syncToken)) throw new Error("本机配对配置无效");
  return createServer({ requestTimeout: 5_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, (request, response) => {
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": csp };
    const send = (status, body, contentType = "text/plain; charset=utf-8") => {
      response.writeHead(status, { ...headers, "Content-Type": contentType }); response.end(body); request.resume();
    };
    const host = `127.0.0.1:${request.socket.localPort}`;
    if (request.headers.host !== host) { send(403, "仅支持本机连接"); return; }
    if (request.method === "GET" && request.url === "/connect") { send(200, html, "text/html; charset=utf-8"); return; }
    if (request.method !== "POST" || request.url !== "/pair") { send(404, "没有此连接操作"); return; }
    if (request.headers.origin !== `http://${host}` || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
      send(403, "请从本机连接窗口操作"); return;
    }
    if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) { send(400, "连接操作不接收上传内容"); return; }
    send(200, JSON.stringify({ deviceId, connectionToken: syncToken }), "application/json; charset=utf-8");
  });
}

export function closeLocalServers(...servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve()); server.closeIdleConnections();
  })));
}

// Readiness is atomic: a failure on either port closes both listeners before
// reporting failure, so the launcher never tunnels a partially started service.
export async function listenLocalServers({ server, pairingServer, port, host = "127.0.0.1", pairingPort = PAIRING_PORT }) {
  const listen = (target, targetPort, targetHost) => new Promise((resolve, reject) => {
    const failed = (error) => { target.off("listening", ready); reject(error); };
    const ready = () => { target.off("error", failed); resolve(); };
    target.once("error", failed); target.once("listening", ready); target.listen(targetPort, targetHost);
  });
  const result = await Promise.allSettled([listen(server, port, host), listen(pairingServer, pairingPort, "127.0.0.1")]);
  const failure = result.find((item) => item.status === "rejected");
  if (failure) { await closeLocalServers(server, pairingServer); throw failure.reason; }
}
