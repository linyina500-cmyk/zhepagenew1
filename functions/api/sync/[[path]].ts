type SyncEnvironment = { SYNC_SERVICE_URL?: string; SYNC_GATEWAY_SECRET?: string };
type SyncContext = { request: Request; env: SyncEnvironment };

const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// The browser uses one origin for the editor, HttpOnly session and API. The
// separately deployed fixed-egress service accepts only this secret gateway.
export async function onRequest({ request, env }: SyncContext): Promise<Response> {
  if (!env.SYNC_SERVICE_URL || !env.SYNC_GATEWAY_SECRET || env.SYNC_GATEWAY_SECRET.length < 32) return json("网页同步服务尚未部署，请联系站点管理员完成配置", 503);
  const incoming = new URL(request.url);
  let service: URL;
  try {
    service = new URL(env.SYNC_SERVICE_URL);
    if (service.protocol !== "https:" || service.username || service.password || service.pathname !== "/" || service.search || service.hash) throw new Error();
  } catch { return json("网页同步服务地址配置无效，请联系站点管理员", 503); }
  if (!["GET", "POST"].includes(request.method)) return json("此请求方法不受支持", 405);
  if (!incoming.pathname.startsWith("/api/sync/") || incoming.search) return json("同步路径无效", 400);
  if (request.method === "POST" && request.headers.get("Origin") !== incoming.origin) return json("网页来源未获授权", 403);
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return json("不接受跨站同步请求", 403);
  const headers = new Headers();
  for (const name of ["Content-Type", "Cookie", "X-CSRF-Token", "Origin"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Sync-Gateway", env.SYNC_GATEWAY_SECRET);
  // Cloudflare overwrites this incoming header with the actual client IP.
  headers.set("X-Sync-Client-IP", request.headers.get("CF-Connecting-IP") || "unknown");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 100000);
  try {
    request.signal.throwIfAborted();
    const response = await fetch(new URL(incoming.pathname, service), {
      method: request.method, headers, ...(request.method === "POST" ? { body: request.body } : {}),
      redirect: "manual", signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) return json("同步服务返回了不受支持的跳转", 502);
    const responseHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    const cookie = response.headers.get("Set-Cookie");
    if (cookie) responseHeaders.set("Set-Cookie", cookie);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch { return json("网页同步连接暂时中断。已提交的草稿请先到平台核对，避免重复发送。", 502); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
