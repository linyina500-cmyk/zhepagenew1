import { spawn } from "node:child_process";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { localPaths } from "./local-paths.mjs";
import { createWindowsControl } from "./local-windows.mjs";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const { privateDir: localDir, configPath, statusPath, pipePath } = localPaths();
let service;
let control;
let connection;
let ready = false;
let ownsStatus = false;
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
  log(message); if (ownsStatus) void writeStatus(false).catch(() => {});
  process.exitCode = failed ? 1 : 0;
  // Never force-kill: in-flight requests must persist their receipts first.
  if (service?.connected) service.send({ type: "zhepage-shutdown" }, () => {});
  else if (process.platform !== "win32") service?.kill("SIGTERM");
}

async function requestUserStop(message) {
  if (process.platform === "win32" && !stopping) {
    const state = await connection?.();
    if (!state || state.busy) { log(state?.busy ? "正在同步内容，请完成后再停止助手。" : "正在准备助手，请就绪后双击“停止助手”。"); return; }
  }
  stop(message);
}

async function main() {
  await access(configPath, constants.R_OK).catch(() => { throw new Error("尚未准备本机助手，请先完成首次安装。"); });
  await chmod(localDir, 0o700); await chmod(configPath, 0o600);
  if (process.platform === "win32") {
    const config = parseEnv(await readFile(configPath, "utf8"));
    connection = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8788/api/wechat/connection", { headers: { Authorization: `Bearer ${config.WECHAT_SYNC_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
        const value = await response.json();
        return response.ok && typeof value.busy === "boolean" ? value : null;
      } catch { return null; }
    };
    // The atomic pipe bind rejects simultaneous starts before either child can
    // open a port, browser profile or write a shared supervisor status file.
    control = await createWindowsControl({ pipePath, token: config.WECHAT_SYNC_TOKEN,
      status: async () => { const state = await connection(); return state ? { ready: ready && !stopping, busy: state.busy } : { ready: false }; },
      stop: () => stop("正在安全关闭助手并保存当前任务结果。"),
    });
  }
  ownsStatus = true;
  await writeStatus(false);
  // The env file is the only source of runtime connection settings. Inherited
  // account secrets are neither propagated nor printed by the supervisor.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WECHAT_")));
  log("正在启动折页同步助手，网页将直接连接这台电脑。");
  service = spawn(process.execPath, ["--env-file", configPath, resolve(serviceDir, "start.mjs")], {
    cwd: resolve(serviceDir, "../.."), env: { ...cleanEnv, WECHAT_HOST: "127.0.0.1", WECHAT_PORT: "8788" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Give Windows children their own hidden console, so Ctrl+C reaches the
    // supervisor's busy check. Parent loss still shuts the child down via IPC.
    detached: process.platform === "win32", windowsHide: true,
  });
  service.on("error", () => { stop("本机服务启动失败，请重新打开助手。", true); void control?.close(); });
  service.on("close", (code, signal) => {
    if (!stopping) stop(`本机服务意外退出（${signal || code}），${process.platform === "win32" ? "请重新打开助手" : "将由系统重新启动"}。`, true);
    void control?.close();
  });
  let output = "", errors = "", diagnostics = "";
  startupTimer = setTimeout(() => stop("本机服务启动超时，请稍后重新打开助手。", true), 20_000);
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
  process.on(signal, () => void requestUserStop(`收到 ${signal}，正在关闭连接并等待当前草稿任务保存结果。`));
}
main().catch(() => { stop("本机助手未能启动，请检查安装文件与本机配置，或等待另一个助手窗口完成启动。", true); void control?.close(); });
