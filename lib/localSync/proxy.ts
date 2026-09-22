type Context = { request: Request; env: { WECHAT_SYNC_URL?: string } };
const MAX_BYTES = 60 * 1024 * 1024 + 64 * 1024;
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Same-origin bridge: credentials pass over HTTPS without persistence or logs.
// The browser owns encrypted storage; the bound local service keeps them in RAM.
export async function onRequest({ request, env }: Context): Promise<Response> {
  const incoming = new URL(request.url);
  if (incoming.search) return json("接口不接收网址查询参数", 400);
  const wechatGet = /^\/api\/wechat\/(connection|accounts(?:\/[a-f0-9]{20}\/jobs\/[a-f0-9-]{36}(?:\/publication)?)?)$/i.test(incoming.pathname);
  const wechatPost = /^\/api\/wechat\/accounts\/(connect|[a-f0-9]{20}\/(disconnect|jobs(?:\/[a-f0-9-]{36}\/(verify|publication(?:\/refresh)?))?))$/i.test(incoming.pathname);
  const xhsGet = /^\/api\/xiaohongshu\/(account|jobs\/[a-f0-9-]{36})$/i.test(incoming.pathname);
  const xhsPost = /^\/api\/xiaohongshu\/(login|jobs(?:\/[a-f0-9-]{36}\/(?:verify|acknowledge))?)$/i.test(incoming.pathname);
  if (!((request.method === "GET" && (wechatGet || xhsGet)) || (request.method === "POST" && (wechatPost || xhsPost)))) return json("没有此同步操作", 404);
  let upstream: URL;
  try {
    upstream = new URL(env.WECHAT_SYNC_URL || "");
    if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error();
  } catch { return json("本机同步服务尚未配置，请先完成服务连接配置", 503); }
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer \S{32,256}$/.test(authorization)) return json("请填写本机连接口令", 401);
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) return json("本次上传超过大小限制", 413);
  const origin = request.headers.get("Origin");
  if (origin && origin !== incoming.origin) return json("请从折页网页发起同步", 403);
  upstream.pathname = incoming.pathname;
  const headers = new Headers({ Authorization: authorization });
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  let size = 0;
  const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) { controller.error(new Error("上传过大")); return; }
      controller.enqueue(chunk);
    },
  }));
  try {
    // workerd supports only manual/follow. Stop redirects explicitly so the
    // connection credential can never be forwarded to a Location destination.
    const response = await fetch(upstream, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(90_000) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return json("本机同步服务发生重定向，已停止转发。请检查服务地址并读取原同步记录，不要重复提交", 502);
    }
    if (!(response.headers.get("Content-Type") || "").includes("application/json")) return json("本机同步服务回应不完整，请读取同步状态后核对", 502);
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return json("本机同步服务暂未回应，请读取原同步记录并核对草稿箱，不要重复提交", 502); }
}
