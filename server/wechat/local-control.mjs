import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify, parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const privateDir = resolve(projectRoot, ".wechat-sync-local");
const label = `com.zhepage.sync.${createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)}`;

export function agentPlist({ label, nodePath, supervisorPath, workDir, logPath }) {
  const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(supervisorPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(workDir)}</string>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
<key>RunAtLoad</key><false/>
<key>KeepAlive</key><false/>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

export function parseAgentState(output) {
  const pid = /^\tpid = (\d+)$/m.exec(output)?.[1];
  return { registered: true, pid: pid && Number(pid) > 0 ? Number(pid) : null };
}

export async function assistantReady({ pid, statusPath, connection, fetcher = fetch }) {
  try {
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.pid !== pid || status.ready !== true || !(await connection())) return false;
    const response = await fetcher("http://127.0.0.1:8789/connect", { redirect: "error", signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.text()).includes("zhepage-local-ready");
  } catch { return false; }
}

// This coordinator never force-restarts a running instance. macOS owns the
// supervisor, so ending a terminal or an agent command cannot orphan its UI.
export async function startAgent({ inspect, prepare, bootstrap, ready, pause, attempts = 90 }) {
  let state = await inspect();
  if (!state.pid) {
    await prepare();
    // bootstrap must tolerate a concurrent start only if the same job exists.
    await bootstrap(state.registered);
  }
  for (let index = 0; index < attempts; index++) {
    state = await inspect();
    if (state.pid && await ready(state.pid)) return;
    if (index > 2 && !state.pid) throw new Error("助手未能启动，请检查本机网络后重新打开助手。");
    await pause();
  }
  throw new Error("助手仍未准备好，请稍后再试。请勿重复启动多个窗口。");
}

export async function stopAgent({ inspect, connection, terminate, pause, attempts = 60 }) {
  if (!(await inspect()).pid) return true;
  const state = await connection();
  if (!state) throw new Error("暂时无法确认同步状态，请稍后再停止助手。");
  if (state.busy) throw new Error("正在同步内容，请等待任务完成后再停止助手。");
  await terminate();
  for (let index = 0; index < attempts; index++) {
    if (!(await inspect()).pid) return true;
    await pause();
  }
  return false;
}

async function main(action) {
  if (process.platform !== "darwin") throw new Error("此后台启动入口适用于 Mac。");
  if (!["start", "stop", "status"].includes(action)) throw new Error("请选择启动、停止或查看助手状态。");
  const directory = await lstat(privateDir);
  const configPath = resolve(privateDir, "config.env");
  const configFile = await lstat(configPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !configFile.isFile() || configFile.isSymbolicLink()) throw new Error("本机助手配置路径无效，请先检查安装。");
  await chmod(privateDir, 0o700); await chmod(configPath, 0o600);
  const config = parseEnv(await readFile(configPath, "utf8"));
  const token = config.WECHAT_SYNC_TOKEN;
  if (typeof token !== "string" || token.length < 32 || token.length > 256 || /\s/u.test(token)) throw new Error("本机助手尚未准备好，请先完成首次配置。");
  const deviceId = createHash("sha256").update(`zhepage-device:${token}`).digest("hex").slice(0, 32);
  const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
  const plistPath = resolve(privateDir, "assistant.plist"), logPath = resolve(privateDir, "assistant.log");
  const run = async (args) => {
    try { return { ok: true, stdout: (await execute("/bin/launchctl", args, { timeout: 10_000, maxBuffer: 262144 })).stdout }; }
    catch { return { ok: false, stdout: "" }; }
  };
  const inspect = async () => { const result = await run(["print", target]); return result.ok ? parseAgentState(result.stdout) : { registered: false, pid: null }; };
  const connection = async () => {
    try {
      const response = await fetch("http://127.0.0.1:8788/api/wechat/connection", { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(1500) });
      const value = await response.json();
      return response.ok && value.deviceId === deviceId && typeof value.busy === "boolean" ? value : null;
    } catch { return null; }
  };
  const ready = (pid) => assistantReady({ pid, statusPath: resolve(privateDir, "assistant-status.json"), connection });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
  if (action === "status") {
    const { pid } = await inspect();
    console.info(pid && await ready(pid) ? "折页同步助手正在后台运行。" : "折页同步助手尚未运行或正在启动。");
    return;
  }
  if (action === "stop") {
    const stopped = await stopAgent({ inspect, connection, pause, terminate: async () => {
      if (!(await run(["kill", "SIGTERM", target])).ok) throw new Error("未能停止助手，请稍后重试。");
    } });
    console.info(stopped ? "折页同步助手已停止。下次使用时重新打开助手即可。" : "助手正在安全停止，请等待当前处理结束；不会强制中断草稿任务。");
    return;
  }
  console.info("正在启动折页同步助手…");
  await startAgent({ inspect, ready, pause,
    prepare: async () => {
      // Only paths go into the private plist. No credentials or inherited env.
      await access(process.execPath);
      for (const path of [plistPath, logPath]) {
        const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("助手运行文件路径无效。");
      }
      await writeFile(logPath, "", { mode: 0o600 }); await chmod(logPath, 0o600);
      await writeFile(plistPath, agentPlist({ label, nodePath: process.execPath, supervisorPath: resolve(projectRoot, "server/wechat/local-start.mjs"), workDir: projectRoot, logPath }), { mode: 0o600 });
      await chmod(plistPath, 0o600);
    },
    bootstrap: async (registered) => {
      // A finished job remains registered; kickstart without -k never kills a
      // concurrent running job. No plist is installed in login-start folders.
      if (!registered) {
        const result = await run(["bootstrap", domain, plistPath]);
        if (!result.ok && !(await inspect()).registered) throw new Error("无法启动后台助手，请在这台 Mac 登录后重新打开助手。");
      }
      if (!(await run(["kickstart", target])).ok) throw new Error("无法启动后台助手，请稍后重试。");
    },
  });
  console.info("助手已在后台运行。现在可以关闭此窗口，回到折页点击“连接这台电脑”。");
  console.info("同步时请保持电脑开机联网。停止助手请打开“停止折页同步助手.command”。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] || "start").catch((error) => {
    // Filesystem and process diagnostics may expose environment details.
    console.error(error.code ? "助手未能启动，请确认已完成首次配置且安装文件夹可用。" : error.message);
    process.exitCode = 1;
  });
}
