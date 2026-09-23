import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { WechatApiError } from "../../lib/wechat/api.mjs";
import { ACCOUNT_ID } from "./accounts.mjs";
import { RequestError as XhsRequestError } from "../xiaohongshu/jobs.mjs";
import { MAX_REQUEST_BYTES, JOB_ID, RequestError, readSubmission } from "./jobs.mjs";

function authorized(value, secret) {
  const digest = (text) => createHash("sha256").update(text).digest();
  return typeof value === "string" && value.length <= 512 && timingSafeEqual(digest(value), digest(`Bearer ${secret}`));
}

async function readBytes(request, limit) {
  if (Number(request.headers["content-length"]) > limit) throw new RequestError("本次上传超过大小限制", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError("本次上传超过大小限制", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(request) {
  if (!(request.headers["content-type"] || "").startsWith("application/json")) throw new RequestError("请发送完整的连接或确认信息");
  const bytes = await readBytes(request, 8192);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new RequestError("连接或确认信息格式不正确"); }
}

export function createWechatServer({ accounts, syncToken, handleXhs, xhsBusy = () => false }) {
  if (typeof syncToken !== "string" || syncToken.length < 32 || syncToken.length > 256 || /\s/u.test(syncToken)) throw new Error("WECHAT_SYNC_TOKEN 需要为 32–256 位无空格的随机口令");
  let readingUpload = false;
  let xhsRequests = 0;
  const busy = () => readingUpload || xhsRequests > 0 || xhsBusy() || accounts.busy?.() || false;
  return createServer({ requestTimeout: 120_000, headersTimeout: 15_000 }, async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(value));
    };
    try {
      if (!authorized(request.headers.authorization, syncToken)) { send(401, { error: "公众号连接口令不正确，请检查后重试" }); request.resume(); return; }
      const url = new URL(request.url, "http://localhost");
      if (url.search) throw new RequestError("接口不接收网址查询参数");
      if (url.pathname.startsWith("/api/xiaohongshu/") && handleXhs) {
        xhsRequests++;
        try { if (await handleXhs(request, send)) return; }
        finally { xhsRequests--; }
      }
      if (request.method === "GET" && url.pathname === "/api/wechat/connection") {
        send(200, { deviceId: accounts.deviceId, busy: busy() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/wechat/accounts") {
        send(200, { accounts: accounts.list() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/wechat/accounts/connect") {
        send(200, { account: await accounts.connect(await readJson(request)) }); return;
      }
      const scoped = /^\/api\/wechat\/accounts\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!scoped || !ACCOUNT_ID.test(scoped[1])) throw new RequestError("没有此公众号操作", 404);
      const path = scoped[2];
      if (request.method === "POST" && path === "/disconnect") {
        if (busy()) throw new RequestError("本机仍在处理同步任务，请完成后再断开连接", 409);
        accounts.disconnect(scoped[1]); send(200, { disconnected: true }); return;
      }
      const { jobs, publications } = accounts.get(scoped[1]);
      const match = /^\/jobs\/([^/]+)(\/verify|\/publication(?:\/refresh)?)?$/.exec(path);
      if (match && JOB_ID.test(match[1])) {
        if (!match[2] && request.method === "GET") { send(200, { job: await jobs.get(match[1]) }); return; }
        if (match[2] === "/verify" && request.method === "POST") { send(200, { job: await jobs.verify(match[1]) }); return; }
        if (match[2] === "/publication" && request.method === "GET") {
          let publication;
          try { publication = await publications.get(match[1]); }
          catch (error) { if (error instanceof RequestError && error.status === 404) publication = null; else throw error; }
          send(200, { publication }); return;
        }
        if (match[2] === "/publication" && request.method === "POST") {
          const confirmation = await readJson(request);
          if (!confirmation || confirmation.confirm !== true || Object.keys(confirmation).length !== 1) throw new RequestError("请先确认目标公众号和内容，再立即发布");
          send(202, { publication: await publications.submit(match[1]) }); return;
        }
        if (match[2] === "/publication/refresh" && request.method === "POST") {
          send(200, { publication: await publications.refresh(match[1]) }); return;
        }
      }
      if (request.method !== "POST" || path !== "/jobs") throw new RequestError("没有此公众号操作", 404);
      if (readingUpload) throw new RequestError("正在接收上一组图片，请稍后读取同步状态", 409);
      const type = request.headers["content-type"] || "";
      if (!type.startsWith("multipart/form-data;")) throw new RequestError("请发送完整的图片与配文");
      if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) throw new RequestError("本次上传超过大小限制", 413);
      readingUpload = true;
      try {
        const bytes = await readBytes(request, MAX_REQUEST_BYTES);
        let form;
        try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
        catch { throw new RequestError("图片数据不完整，请重新确认内容"); }
        const input = await readSubmission(form);
        if (input.expectedAccountId !== scoped[1]) throw new RequestError("上传目标与所选公众号不一致", 409);
        send(202, { job: await jobs.submit(input) });
      } finally { readingUpload = false; }
    } catch (error) {
      // Never serialize upstream fetch errors, credentials, headers, or URLs.
      // A controlled WeChat failure is a dependency error, not an unreachable
      // origin: tunnel providers can replace 502 responses with their own HTML.
      const controlled = error instanceof RequestError || error instanceof XhsRequestError;
      const status = controlled ? error.status : error instanceof WechatApiError ? 424 : 502;
      const message = controlled || error instanceof WechatApiError ? error.message : "公众号同步暂未完成，请读取状态并核对草稿箱";
      if (!response.headersSent) send(status, { error: message });
    }
  });
}
