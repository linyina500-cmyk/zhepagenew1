import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import { createAccountRegistry } from "./accounts.mjs";
import { createWechatServer } from "./http.mjs";
import { createPairingServer, listenLocalServers, closeLocalServers, PAIRING_PORT } from "./pairing.mjs";
import { createXhsService } from "../xiaohongshu/jobs.mjs";
import { createXhsBrowserDriver } from "../xiaohongshu/driver.mjs";
import { createXhsHandler } from "../xiaohongshu/http.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`请在服务端私密配置中设置 ${name}`);
  return value;
}

const syncToken = required("WECHAT_SYNC_TOKEN");
const dataDir = resolve(required("WECHAT_DATA_DIR"));
if (!(await stat(dataDir).catch(() => null))?.isDirectory()) throw new Error("请先创建可写的 WECHAT_DATA_DIR 持久数据目录");
const port = Number(process.env.WECHAT_PORT || 8788);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WECHAT_PORT 无效");
const accounts = createAccountRegistry({ dataDir, syncToken });
// These obsolete environment values are never used. Account credentials are
// supplied by the bound browser and are retained only in API-client memory.
delete process.env.WECHAT_APP_ID;
delete process.env.WECHAT_APP_SECRET;
delete process.env.WECHAT_ACCOUNT_NAME;
let xhsPromise;
let xhsHandler;
let xhsService;
const handleXhs = async (request, send) => {
  if (!xhsPromise) {
    const directory = join(dataDir, "xiaohongshu");
    xhsPromise = createXhsService({ dataDir: directory, driver: createXhsBrowserDriver({ profileDir: join(directory, "browser-profile") }) });
  }
  let service;
  try { service = await xhsPromise; }
  catch (error) { xhsPromise = null; throw error; }
  xhsService = service;
  xhsHandler ||= createXhsHandler({ service });
  return xhsHandler(request, send);
};
const server = createWechatServer({ accounts, syncToken, handleXhs, xhsBusy: () => xhsService?.busy() || false,
  onDiagnostic: ({ platform, action, code }) => console.info(`ZHEPAGE_DIAGNOSTIC ${platform} ${action} ${code}`),
});
const pairingServer = createPairingServer({ deviceId: accounts.deviceId, syncToken });
let stopping;
function shutdown() {
  stopping ||= (async () => {
    await closeLocalServers(server, pairingServer);
    await accounts.idle();
    if (xhsPromise) await xhsPromise.then((service) => service.close()).catch(() => {});
  })();
  return stopping;
}
function failed(error) {
  console.error(error.code === "EADDRINUSE"
    ? `端口 ${port} 或 ${PAIRING_PORT} 已被占用，请先关闭已有的启动窗口后再试。`
    : "本机同步服务未能监听，请检查端口和本机网络配置后再试。");
  process.exitCode = 1;
  void shutdown();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
try {
  await listenLocalServers({ server, pairingServer, port, host: "127.0.0.1" });
  server.on("error", failed); pairingServer.on("error", failed);
  if (!stopping) console.info(`公众号草稿服务已启动，端口 ${port}；本机配对端口 ${PAIRING_PORT}。公众号凭据不会输出到日志。`);
  else await closeLocalServers(server, pairingServer);
} catch (error) { failed(error); }
