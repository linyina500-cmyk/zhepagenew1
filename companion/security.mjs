import { timingSafeEqual } from "node:crypto";

export const MAX_REQUEST_BYTES = 86 * 1024 * 1024;
export const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:4173", "http://127.0.0.1:4173"];

export function requireLocalOrigin(origin) {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error("开发版助手只允许完整的本机 HTTP 来源，例如 http://127.0.0.1:5173");
  return origin;
}

export function authorizeRequest(request, { port, token, allowedOrigins }) {
  if (request.headers.host !== `127.0.0.1:${port}`) return { status: 403, error: "拒绝非本机目标" };
  if (!allowedOrigins.includes(request.headers.origin)) return { status: 403, error: "当前网页未获本机助手授权" };
  if (request.method === "OPTIONS") {
    const headers = String(request.headers["access-control-request-headers"] || "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
    if (!["GET", "POST"].includes(request.headers["access-control-request-method"]) || headers.some((header) => !["authorization", "content-type"].includes(header))) return { status: 403, error: "请求不受支持" };
    return null;
  }
  const actual = Buffer.from(String(request.headers.authorization || ""));
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { status: 401, error: "配对码无效，请使用本次助手启动时显示的配对码" };
  if (request.method === "POST" && request.headers["content-type"]?.split(";")[0].trim() !== "application/json") return { status: 415, error: "只接受 JSON 请求" };
  return null;
}

export async function readJson(request, limit = MAX_REQUEST_BYTES) {
  if (Number(request.headers["content-length"] || 0) > limit) throw Object.assign(new Error("请求素材过大"), { statusCode: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求素材过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求内容不是有效 JSON"); }
}
