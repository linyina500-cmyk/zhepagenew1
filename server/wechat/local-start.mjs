import { spawn } from "node:child_process";
import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const localDir = resolve(serviceDir, "../../.wechat-sync-local");
const configPath = resolve(localDir, "config.env");
const statusPath = resolve(localDir, "assistant-status.json");
let service;
let stopping = false;
let startupTimer;
let statusWrite = Promise.resolve();
function writeStatus(ready) {
  statusWrite = statusWrite.catch(() => {}).then(() => writeFile(statusPath, JSON.stringify({ pid: process.pid, ready }), { mode: 0o600 }));
  return statusWrite;
}
function log(message) { console.info(`${new Date().toISOString()} ${message}`); }
function stop(message, failed = false) {
  if (stopping) return;
  stopping = true; clearTimeout(startupTimer);
  log(message); void writeStatus(false).catch(() => {});
  process.exitCode = failed ? 1 : 0;
  // Never force-kill: in-flight requests must persist their receipts first.
  service?.kill("SIGTERM");
}

async function main() {
  await access(configPath, constants.R_OK).catch(() => { throw new Error("尚未准备本机助手，请先完成首次安装。"); });
  await chmod(localDir, 0o700); await chmod(configPath, 0o600);
  await writeStatus(false);
  // The env file is the only source of runtime connection settings. Inherited
  // account secrets are neither propagated nor printed by the supervisor.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WECHAT_")));
  log("正在启动折页同步助手，网页将直接连接这台电脑。");
  service = spawn(process.execPath, ["--env-file", configPath, resolve(serviceDir, "start.mjs")], {
    cwd: resolve(serviceDir, "../.."), env: { ...cleanEnv, WECHAT_HOST: "127.0.0.1", WECHAT_PORT: "8788" }, stdio: ["ignore", "pipe", "pipe"],
  });
  service.on("error", () => stop("本机服务启动失败，将由系统稍后重新启动。", true));
  service.on("close", (code, signal) => {
    if (!stopping) stop(`本机服务意外退出（${signal || code}），将由系统重新启动。`, true);
  });
  let output = "", errors = "", diagnostics = "", ready = false;
  startupTimer = setTimeout(() => stop("本机服务启动超时，将由系统稍后重新启动。", true), 20_000);
  service.stderr.on("data", (chunk) => {
    errors = (errors + chunk.toString()).slice(-2000);
    if (errors.includes("已被占用")) stop("端口 8788 或 8789 被占用，稍后重试。", true);
  });
  service.stdout.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
    const lines = diagnostics.split(/\r?\n/u); diagnostics = lines.pop();
    for (const line of lines) {
      // Forward only this fixed vocabulary, never raw errors, URLs or headers.
      if (/^ZHEPAGE_DIAGNOSTIC (local|wechat|xiaohongshu) (connection|login|account|draft|request) (browser_open_failed|page_open_failed|window_focus_failed|page_needs_attention|unexpected_error)$/u.test(line)) log(line);
    }
    output = (output + chunk.toString()).slice(-2000);
    if (ready || stopping || !output.includes("公众号草稿服务已启动")) return;
    ready = true; clearTimeout(startupTimer);
    void writeStatus(true).then(() => {
      if (!stopping) log("折页同步助手已就绪。回到折页点击“连接这台电脑”；Chrome 如询问本机访问权限，请选择允许。");
    }).catch(() => stop("无法保存助手状态，请检查本机文件夹权限。", true));
  });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(`收到 ${signal}，正在关闭连接并等待当前草稿任务保存结果。`));
}
main().catch(() => stop("本机助手未能启动，请检查安装文件与本机配置。", true));
