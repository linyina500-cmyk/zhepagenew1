import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { createWechatApi } from "../../lib/wechat/api.mjs";
import { createJobService } from "./jobs.mjs";
import { createWechatServer } from "./http.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`请在服务端私密配置中设置 ${name}`);
  return value;
}

const appId = required("WECHAT_APP_ID");
const appSecret = required("WECHAT_APP_SECRET");
const syncToken = required("WECHAT_SYNC_TOKEN");
const accountName = required("WECHAT_ACCOUNT_NAME");
const dataDir = resolve(required("WECHAT_DATA_DIR"));
if (!(await stat(dataDir).catch(() => null))?.isDirectory()) throw new Error("请先创建可写的 WECHAT_DATA_DIR 持久数据目录");
const port = Number(process.env.WECHAT_PORT || 8788);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WECHAT_PORT 无效");
const jobs = createJobService({ appId, accountName, dataDir, api: createWechatApi({ appId, appSecret }) });
const server = createWechatServer({ jobs, syncToken });
server.listen(port, process.env.WECHAT_HOST || "127.0.0.1", () => {
  console.info(`公众号草稿服务已启动，端口 ${port}。公众号凭据不会输出到日志。`);
});
async function shutdown() {
  server.close();
  await jobs.idle();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
