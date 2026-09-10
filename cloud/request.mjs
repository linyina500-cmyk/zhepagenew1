export const MAX_REQUEST_BYTES = 94 * 1024 * 1024;

export async function readJson(request, limit = MAX_REQUEST_BYTES) {
  const tooLarge = () => Object.assign(new Error("请求素材过大"), { statusCode: 413, publicMessage: "请求素材过大" });
  if (Number(request.headers["content-length"] || 0) > limit) throw tooLarge();
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求内容不是有效 JSON"), { statusCode: 400, publicMessage: "请求内容不是有效 JSON" }); }
}
