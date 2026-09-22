import { JOB_ID, MAX_REQUEST_BYTES, RequestError, readSubmission } from "./jobs.mjs";

// The shared HTTP server authenticates before calling this handler and formats
// controlled RequestError failures. This handler exposes draft operations only.
export function createXhsHandler({ service }) {
  let readingUpload = false;
  return async (request, send) => {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/api/xiaohongshu/")) return false;
    if (url.search) throw new RequestError("接口不接收网址查询参数");
    if (request.method === "GET" && url.pathname === "/api/xiaohongshu/account") {
      send(200, { account: await service.checkConnection() }); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/xiaohongshu/login") {
      await service.openLogin(); send(200, { opened: true }); return true;
    }
    const match = /^\/api\/xiaohongshu\/jobs\/([^/]+)(\/verify|\/acknowledge)?$/.exec(url.pathname);
    if (match && JOB_ID.test(match[1])) {
      if (request.method === "GET" && !match[2]) { send(200, { job: await service.get(match[1]) }); return true; }
      if (request.method === "POST" && match[2] === "/verify") { send(200, { job: await service.verify(match[1]) }); return true; }
      if (request.method === "POST" && match[2] === "/acknowledge") {
        if (!(request.headers["content-type"] || "").startsWith("application/json")) throw new RequestError("请发送人工核对确认");
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) throw new RequestError("确认信息超过大小限制", 413);
          chunks.push(chunk);
        }
        let confirmation;
        try { confirmation = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new RequestError("人工核对确认格式不正确"); }
        if (!confirmation || Array.isArray(confirmation) || confirmation.confirm !== true || Object.keys(confirmation).length !== 1) throw new RequestError("请先确认已在专用浏览器核对并结束本次任务");
        send(200, { job: await service.acknowledge(match[1]) }); return true;
      }
    }
    if (request.method !== "POST" || url.pathname !== "/api/xiaohongshu/jobs") throw new RequestError("没有此小红书草稿操作", 404);
    if (readingUpload) throw new RequestError("正在接收上一组图片，请稍后读取同步状态", 409);
    const type = request.headers["content-type"] || "";
    if (!type.startsWith("multipart/form-data;")) throw new RequestError("请发送完整图片与配文");
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
      send(202, { job: await service.submit(await readSubmission(form)) });
      return true;
    } finally { readingUpload = false; }
  };
}
