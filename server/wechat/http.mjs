import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_REQUEST_BYTES, JOB_ID, RequestError, readSubmission } from "./jobs.mjs";

function authorized(value, secret) {
  const digest = (text) => createHash("sha256").update(text).digest();
  return typeof value === "string" && value.length <= 512 && timingSafeEqual(digest(value), digest(`Bearer ${secret}`));
}

export function createWechatServer({ jobs, syncToken }) {
  if (typeof syncToken !== "string" || syncToken.length < 32 || syncToken.length > 256 || /\s/u.test(syncToken)) throw new Error("WECHAT_SYNC_TOKEN 需要为 32–256 位无空格的随机口令");
  let readingUpload = false;
  return createServer({ requestTimeout: 120_000, headersTimeout: 15_000 }, async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(value));
    };
    try {
      if (!authorized(request.headers.authorization, syncToken)) { send(401, { error: "公众号连接口令不正确，请检查后重试" }); request.resume(); return; }
      const url = new URL(request.url, "http://localhost");
      if (url.search) throw new RequestError("接口不接收网址查询参数");
      if (request.method === "GET" && url.pathname === "/api/wechat/account") {
        send(200, { account: await jobs.checkConnection() }); return;
      }
      const match = /^\/api\/wechat\/jobs\/([^/]+)(\/verify)?$/.exec(url.pathname);
      if (match && JOB_ID.test(match[1])) {
        if (!match[2] && request.method === "GET") { send(200, { job: await jobs.get(match[1]) }); return; }
        if (match[2] && request.method === "POST") { send(200, { job: await jobs.verify(match[1]) }); return; }
      }
      if (request.method !== "POST" || url.pathname !== "/api/wechat/jobs") throw new RequestError("没有此草稿操作", 404);
      if (readingUpload) throw new RequestError("正在接收上一组图片，请稍后读取同步状态", 409);
      const type = request.headers["content-type"] || "";
      if (!type.startsWith("multipart/form-data;")) throw new RequestError("请发送完整的图片与配文");
      if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) throw new RequestError("本次上传超过大小限制", 413);
      readingUpload = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_REQUEST_BYTES) throw new RequestError("本次上传超过大小限制", 413);
          chunks.push(chunk);
        }
        let form;
        try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": type } }).formData(); }
        catch { throw new RequestError("图片数据不完整，请重新确认内容"); }
        const input = await readSubmission(form);
        send(202, { job: await jobs.submit(input) });
      } finally { readingUpload = false; }
    } catch (error) {
      // Never serialize upstream fetch errors, credentials, headers, or URLs.
      const status = error instanceof RequestError ? error.status : 502;
      const message = error instanceof RequestError || error.name === "WechatApiError" ? error.message : "公众号同步暂未完成，请读取状态并核对草稿箱";
      if (!response.headersSent) send(status, { error: message });
    }
  });
}
