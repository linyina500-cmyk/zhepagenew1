import { createServer } from "node:http";
import { LOCAL_APP_ORIGIN, localAccess } from "./local-access.mjs";

export const PAIRING_APP_ORIGIN = LOCAL_APP_ORIGIN;
export const PAIRING_PORT = 8789;

// Pairing is requested explicitly from the trusted HTTPS app. Both the Origin
// and JSON preflight are checked before any credential may leave loopback.
export function createPairingServer({ deviceId, syncToken }) {
  if (typeof deviceId !== "string" || !/^[a-f0-9]{32}$/.test(deviceId)
    || typeof syncToken !== "string" || syncToken.length < 32 || syncToken.length > 256 || /\s/u.test(syncToken)) throw new Error("本机配对配置无效");
  return createServer({ requestTimeout: 5_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(value)); request.resume();
    };
    if (request.method === "GET" && request.url === "/health") {
      if (localAccess(request, response)) send(200, { service: "zhepage-local-pairing", ready: true });
      return;
    }
    if (request.url !== "/pair") { send(404, { error: "没有此连接操作" }); return; }
    if (!localAccess(request, response, { pairing: true })) return;
    if (request.method !== "POST") { send(405, { error: "请点击连接这台电脑" }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")
      || Number(request.headers["content-length"]) > 256) { send(400, { error: "连接信息格式不正确" }); return; }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 256) { send(413, { error: "连接信息过长" }); return; }
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1
        || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) { send(400, { error: "连接信息格式不正确" }); return; }
      send(200, { nonce: value.nonce, deviceId, connectionToken: syncToken });
    } catch { if (!response.headersSent) send(400, { error: "连接信息未完整接收，请重试" }); }
  });
}

export function closeLocalServers(...servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve()); server.closeIdleConnections();
  })));
}

// Readiness is atomic: a failure on either port closes both listeners before
// reporting failure, so the launcher never claims a partial service is ready.
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
