import { spawn } from "node:child_process";
import { access, chmod, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceDir = dirname(fileURLToPath(import.meta.url));
const localDir = resolve(serviceDir, "../../.wechat-sync-local");
const configPath = resolve(localDir, "config.env");
const publicUrlPath = resolve(localDir, "tunnel-url.txt");
const children = new Set();
let stopping = false;
let startupTimer;
let tunnelTimer;
let tunnel;
let urlFound = false;

// The tunnel never inherits the WeChat credentials, including values supplied
// by an existing shell. Only the service child reads the private env file.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WECHAT_")));

function stop(message, failed = false) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  clearTimeout(tunnelTimer);
  if (message) console.info(message);
  process.exitCode = failed ? 1 : 0;
  tunnel?.kill("SIGTERM");
  for (const child of children) if (child !== tunnel) child.kill("SIGTERM");
  // Do not force-kill the service: an in-flight draft must persist its receipt.
}

function launch(binary, args, env = cleanEnv) {
  const child = spawn(binary, args, { cwd: resolve(serviceDir, "../.."), env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.on("error", () => stop("启动失败，请检查 Node.js 和 Cloudflare Tunnel 是否安装完整。", true));
  child.on("close", () => {
    children.delete(child);
    if (!stopping) stop("连接程序已退出，本机同步服务已停止；需要时重新打开启动入口。", true);
  });
  return child;
}

async function main() {
  await access(configPath, constants.R_OK).catch(() => { throw new Error("尚未配置公众号，请先双击“配置公众号.command”。"); });
  await chmod(localDir, 0o700);
  await chmod(configPath, 0o600);
  const candidates = [resolve(localDir, "bin/cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  let cloudflared;
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) { cloudflared = candidate; break; }
  }
  if (!cloudflared) throw new Error("尚未安装 Cloudflare Tunnel，请先按“本机使用说明.md”完成安装。");

  console.info("正在启动公众号草稿服务。同步期间请保持此窗口打开、电脑联网且不休眠。");
  const service = launch(process.execPath, ["--env-file", configPath, resolve(serviceDir, "start.mjs")], {
    ...cleanEnv, WECHAT_HOST: "127.0.0.1", WECHAT_PORT: "8788",
  });
  let serviceOutput = "";
  let serviceError = "";
  service.stderr.on("data", (chunk) => {
    serviceError = (serviceError + chunk.toString()).slice(-2_000);
    // Recognize one controlled startup failure, never forward raw diagnostics.
    if (serviceError.includes("已被占用")) stop("端口 8788 已被占用，请先关闭之前的公众号启动窗口，再重新启动。", true);
  });
  startupTimer = setTimeout(() => stop("本机服务未能启动，请检查配置和端口 8788 是否被占用。", true), 20_000);
  service.stdout.on("data", (chunk) => {
    serviceOutput = (serviceOutput + chunk.toString()).slice(-2_000);
    if (tunnel || stopping || !serviceOutput.includes("公众号草稿服务已启动")) return;
    clearTimeout(startupTimer);
    console.info("本机服务已启动，正在建立免费测试连接……");
    tunnel = launch(cloudflared, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8788"]);
    tunnelTimer = setTimeout(() => stop("免费测试连接暂未建立，请检查网络后重新启动。", true), 60_000);
    let output = "";
    const read = (chunk) => {
      output = (output + chunk.toString()).slice(-8_000);
      const url = output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/u)?.[0];
      if (!url || urlFound || stopping) return;
      urlFound = true;
      clearTimeout(tunnelTimer);
      void writeFile(publicUrlPath, `${url}\n`, { mode: 0o600 }).then(() => {
        if (stopping) return;
        console.info(`本次测试服务地址：${url}`);
        console.info("地址已保存到本机 tunnel-url.txt。首次使用需把它接入折页测试网页，重启后地址会改变。");
        console.info("地址生成不代表微信连接已通过；还需配置微信 IP 白名单，并在折页检查公众号连接。");
        console.info("完成同步后按 Control+C 关闭；如有正在上传的任务，请等待保存结束。");
      }).catch(() => stop("无法保存测试地址，请检查本机配置目录是否可写。", true));
    };
    tunnel.stdout.on("data", read);
    tunnel.stderr.on("data", read);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => stop("正在关闭连接，并等待当前草稿任务保留处理结果……"));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
