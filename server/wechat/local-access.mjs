export const LOCAL_APP_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";

// A numeric loopback Host prevents DNS rebinding. Browser callers must also
// come from the exact trusted app; command-line diagnostics still need Bearer
// authentication at the API layer. No cookies or wildcard CORS are accepted.
export function localAccess(request, response, { pairing = false } = {}) {
  const deny = () => {
    response.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "请从折页网页连接本机助手。" }));
    request.resume();
    return false;
  };
  if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) return deny();
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== LOCAL_APP_ORIGIN) return deny();
  if (pairing && origin !== LOCAL_APP_ORIGIN) return deny();
  if (origin === LOCAL_APP_ORIGIN) {
    response.setHeader("Access-Control-Allow-Origin", LOCAL_APP_ORIGIN);
    response.setHeader("Vary", "Origin");
  }
  if (request.method !== "OPTIONS") return true;
  const method = request.headers["access-control-request-method"];
  const requested = String(request.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = pairing ? ["content-type"] : ["authorization", "content-type"];
  if (origin !== LOCAL_APP_ORIGIN || !(pairing ? ["POST"] : ["GET", "POST"]).includes(method)
    || requested.some((header) => !allowed.includes(header))) return deny();
  response.writeHead(204, {
    "Access-Control-Allow-Methods": pairing ? "POST" : "GET, POST",
    "Access-Control-Allow-Headers": allowed.join(", "),
    "Cache-Control": "no-store",
  });
  response.end(); request.resume(); return false;
}
