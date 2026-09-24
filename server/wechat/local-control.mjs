import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
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
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}

export function parseAgentState(output) {
  const pid = /^\tpid = (\d+)$/m.exec(output)?.[1];
  const definitionPath = /^\tpath = (.+)$/m.exec(output)?.[1] || null;
  return { registered: true, pid: pid && Number(pid) > 0 ? Number(pid) : null, definitionPath };
}

export async function assistantReady({ pid, statusPath, connection, fetcher = fetch }) {
  try {
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.pid !== pid || status.ready !== true || !(await connection())) return false;
    const response = await fetcher("http://127.0.0.1:8789/health", { redirect: "error", signal: AbortSignal.timeout(1500) });
    const value = await response.json();
    return response.ok && value.service === "zhepage-local-pairing" && value.ready === true;
  } catch { return false; }
}

// This coordinator never force-restarts a running instance. macOS owns the
// supervisor, so ending a terminal or an agent command cannot orphan its UI.
export async function startAgent({ inspect, prepare, bootstrap, ready, pause, attempts = 90 }) {
  // Install the next-login definition even when an older instance is running.
  // Its current tasks continue; no live instance is unloaded or restarted.
  await prepare();
  let state = await inspect();
  if (!state.pid) {
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

export async function unregisterStoppedAgent({ inspect, bootout }) {
  const state = await inspect();
  if (state.pid) throw new Error("助手仍在运行，请等待安全停止后再停用自动启动。");
  if (state.registered) await bootout();
}

export async function stopInstalledAgent({ inspect, connection, terminate, pause, disable, unregister, enable, remove, permanent = false, attempts = 60 }) {
  // Refusing busy work must not silently turn off its recovery policy.
  if ((await inspect()).pid) {
    const state = await connection();
    if (!state) throw new Error("暂时无法确认同步状态，请稍后再停用自动启动。");
    if (state.busy) throw new Error("正在同步内容，请等待任务完成后再停用自动启动。");
  }
  await disable();
  let stopped;
  try { stopped = await stopAgent({ inspect, connection, terminate, pause, attempts }); }
  catch (error) { await enable(); throw error; }
  if (!stopped) return false;
  await unregister();
  if (permanent) await remove();
  else await enable();
  return true;
}

export async function bootstrapAgent({ inspect, plistPath, unregister, bootstrap, kickstart }) {
  const state = await inspect();
  if (state.pid) return;
  if (state.registered && state.definitionPath !== plistPath) await unregister();
  if (!(await inspect()).registered) await bootstrap();
  await kickstart();
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
  if (!["start", "stop", "status", "uninstall"].includes(action)) throw new Error("请选择启动、停止、查看状态或停用自动启动。");
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
  const agentsDir = resolve(homedir(), "Library/LaunchAgents");
  const plistPath = resolve(agentsDir, `${label}.plist`), logPath = resolve(privateDir, "assistant.log");
  const run = async (args) => {
    try { return { ok: true, stdout: (await execute("/bin/launchctl", args, { timeout: 10_000, maxBuffer: 262144 })).stdout }; }
    catch { return { ok: false, stdout: "" }; }
  };
  const inspect = async () => { const result = await run(["print", target]); return result.ok ? parseAgentState(result.stdout) : { registered: false, pid: null }; };
  const terminate = async () => {
    if (!(await run(["kill", "SIGTERM", target])).ok && (await inspect()).pid) throw new Error("未能停止助手，请稍后重试。");
  };
  const unregister = () => unregisterStoppedAgent({ inspect, bootout: async () => {
    if (!(await run(["bootout", target])).ok && (await inspect()).registered) throw new Error("未能移除助手的自动启动，请稍后重试。");
  } });
  const enable = async () => { if (!(await run(["enable", target])).ok) throw new Error("无法启用助手的登录自动启动，请稍后重试。"); };
  const disable = async () => { if (!(await run(["disable", target])).ok) throw new Error("未能停用自动启动，请稍后重试。"); };
  const remove = async () => { await unlink(plistPath).catch((error) => { if (error.code !== "ENOENT") throw error; }); };
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
    console.info(await lstat(plistPath).then((info) => info.isFile() && !info.isSymbolicLink(), () => false) ? "已安装登录自动启动。" : "未安装登录自动启动。");
    return;
  }
  if (action === "stop") {
    const stopped = await stopInstalledAgent({ inspect, connection, pause, terminate, unregister, disable, enable, remove });
    console.info(stopped ? "助手已停止，本次不会自动重启；下次登录 Mac 后会自动启动。需要现在使用时重新打开助手即可。" : "助手正在安全停止，请等待当前处理结束；不会强制中断草稿任务。");
    console.info("如需一直停用，请打开“停用折页自动启动.command”。");
    return;
  }
  if (action === "uninstall") {
    const stopped = await stopInstalledAgent({ inspect, connection, pause, terminate, unregister, disable, enable, remove, permanent: true });
    console.info(stopped ? "已停止助手并移除登录自动启动。公众号资料与草稿全部保留；重新打开助手可恢复使用。" : "已停用自动恢复，助手仍在安全停止；处理结束后再打开此入口，即可完成移除。");
    return;
  }
  console.info("正在启动折页同步助手…");
  await startAgent({ inspect, ready, pause,
    prepare: async () => {
      // Only paths go into LaunchAgents. Credentials remain in the private folder.
      await access(process.execPath);
      await mkdir(agentsDir, { recursive: true, mode: 0o700 });
      const agents = await lstat(agentsDir);
      if (!agents.isDirectory() || agents.isSymbolicLink()) throw new Error("助手自动启动文件夹无效。");
      for (const path of [plistPath, logPath]) {
        const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("助手运行文件路径无效。");
      }
      await writeFile(logPath, "", { flag: "a", mode: 0o600 }); await chmod(logPath, 0o600);
      await writeFile(plistPath, agentPlist({ label, nodePath: process.execPath, supervisorPath: resolve(projectRoot, "server/wechat/local-start.mjs"), workDir: projectRoot, logPath }), { mode: 0o600 });
      await chmod(plistPath, 0o600);
      await enable();
    },
    bootstrap: () => bootstrapAgent({ inspect, plistPath, unregister,
      // Upgrade an exited temporary registration only. The command-level lock
      // prevents another controller from starting it between inspect/bootout.
      bootstrap: async () => {
        const result = await run(["bootstrap", domain, plistPath]);
        if (!result.ok && !(await inspect()).registered) throw new Error("无法启动后台助手，请在这台 Mac 登录后重新打开助手。");
      },
      kickstart: async () => { if (!(await run(["kickstart", target])).ok) throw new Error("无法启动后台助手，请稍后重试。"); },
    }),
  });
  console.info("助手已在后台运行。现在可以关闭此窗口，回到折页点击“连接这台电脑”。");
  console.info("以后登录 Mac 会自动启动，意外退出会自动恢复；同步时请保持电脑开机联网。");
  console.info("暂时停止请打开“停止折页同步助手.command”；不再需要自动启动时打开“停用折页自动启动.command”。");
}

export async function runWithControlLock({ lockPath, scriptPath, action, nodePath = process.execPath }) {
  await access("/usr/bin/lockf");
  // The kernel releases this lock even after a crash, while -k keeps one inode
  // for all callers. Never unlink the lock file to bypass an active operation.
  const status = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/lockf", ["-s", "-k", "-t", "0", lockPath, nodePath, scriptPath, action, "--locked"], { stdio: "inherit" });
    child.on("error", reject); child.on("close", (code) => resolve(code));
  });
  if (status === 75) throw new Error("助手正在启动或停止，请等当前操作完成后再试。");
  return status;
}

async function command(action) {
  if (process.argv[3] === "--locked" || action === "status") return main(action);
  if (process.platform !== "darwin") throw new Error("此后台启动入口适用于 Mac。");
  const directory = await lstat(privateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("助手私密配置文件夹无效。");
  await chmod(privateDir, 0o700);
  const lockPath = resolve(privateDir, "assistant-control.lock");
  const lock = await lstat(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (lock && (!lock.isFile() || lock.isSymbolicLink())) throw new Error("助手控制文件无效。");
  await writeFile(lockPath, "", { flag: "a", mode: 0o600 }); await chmod(lockPath, 0o600);
  const status = await runWithControlLock({ lockPath, scriptPath: fileURLToPath(import.meta.url), action });
  if (status !== 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  command(process.argv[2] || "start").catch((error) => {
    // Filesystem and process diagnostics may expose environment details.
    console.error(error.code ? "助手未能启动，请确认已完成首次配置且安装文件夹可用。" : error.message);
    process.exitCode = 1;
  });
}
