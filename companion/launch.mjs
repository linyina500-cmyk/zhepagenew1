import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { homedir, platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_ORIGIN = "http://127.0.0.1:5173";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATA_DIR = path.join(homedir(), "Library", "Application Support", "Zhepage Draft Helper");
const require = createRequire(import.meta.url);

export function supportsNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 22 ? minor >= 18 : major >= 24;
}

export async function inspectProject(projectRoot) {
  try {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
    if (manifest.type !== "module" || !manifest.devDependencies?.vinext || !manifest.devDependencies?.["@playwright/test"] || !lock.packages?.[""]) throw new Error();
    await Promise.all(["vite.config.ts", "companion/server.mjs", "app/page.tsx"].map((name) => access(path.join(projectRoot, name))));
    return { manifest, lock };
  } catch {
    throw new Error("没有找到完整的折页文件。请先解压整个下载包，再双击文件夹里的“启动折页.command”，不要只移动启动文件。");
  }
}

export async function dependenciesReady(projectRoot, manifest, lock) {
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const name of packages) {
    try {
      const installed = JSON.parse(await readFile(path.join(projectRoot, "node_modules", name, "package.json"), "utf8"));
      if (installed.version !== lock.packages[`node_modules/${name}`]?.version) return false;
    } catch { return false; }
  }
  return true;
}

export async function prepareBrowser(getLaunchOptions, installBrowser, progress = console.log) {
  if (await getLaunchOptions()) return;
  progress("首次使用需要下载浏览器组件，请稍候…");
  await installBrowser();
  if (!await getLaunchOptions()) throw new Error("浏览器组件未能准备完成，请检查网络后再次双击启动。");
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareFonts(projectRoot, fetchImpl = fetch, progress = console.log) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(projectRoot, "companion/runtime-assets.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw new Error("字体下载清单无法读取，请重新下载并解压折页。"); }
  let origin;
  try { origin = new URL(manifest.assetOrigin); }
  catch { throw new Error("字体下载清单无效，请重新下载折页。"); }
  if (origin.protocol !== "https:" || origin.origin !== manifest.assetOrigin || !Array.isArray(manifest.files) || manifest.files.length > 10) throw new Error("字体下载清单无效，请重新下载折页。");
  for (const asset of manifest.files) {
    if (!asset || !/^public\/fonts\/[a-z0-9-]+\.woff2$/.test(asset.path) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("字体下载清单无效，请重新下载折页。");
    const destination = path.join(projectRoot, asset.path);
    try {
      const existing = await readFile(destination);
      if (existing.length === asset.bytes && digest(existing) === asset.sha256) continue;
    } catch (error) { if (error.code !== "ENOENT") throw new Error("无法读取折页字体，请把整个折页文件夹移到“下载”或“文稿”后重试。"); }
    progress("正在准备排版字体，首次启动需要下载，请稍候…");
    let response;
    try { response = await fetchImpl(new URL(asset.path.slice("public".length), origin), { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(300_000) }); }
    catch (error) { throw new Error("字体下载未完成，请检查网络后再次双击启动。", { cause: error }); }
    if (!response.ok || !response.body) throw new Error("字体下载未完成，请检查网络后再次双击启动。");
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > asset.bytes) throw new Error("Font response exceeded its declared size");
        chunks.push(chunk);
      }
    } catch (error) { throw new Error("字体下载未完成，请检查网络后再次双击启动。", { cause: error }); }
    const bytes = Buffer.concat(chunks);
    if (size !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error("字体校验未通过，请检查网络后再次双击启动。");
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.download-${process.pid}`;
    try { await writeFile(temporary, bytes); await rename(temporary, destination); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  return manifest.assetOrigin;
}

function connectToLauncher(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("折页启动窗口暂时没有响应，请查看原来的启动窗口。")));
    socket.on("connect", () => socket.end('{"action":"reopen"}\n'));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.length > 1024) socket.destroy(new Error("折页启动记录无效，请关闭原启动窗口后重试。"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const result = JSON.parse(response);
        if (!["opened", "starting"].includes(result.status)) throw new Error();
        resolve(result.status);
      } catch { reject(new Error("折页未能重新打开页面，请查看原来的启动窗口。")); }
    });
  });
}

export async function createLauncherChannel(dataDir, reopen) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(dataDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid()) throw new Error("折页账号目录不属于当前用户，不能启动。");
  await chmod(dataDir, 0o700);
  const socketPath = path.join(dataDir, "launcher.sock");
  if (Buffer.byteLength(socketPath) > 103) throw new Error("当前用户目录名称太长，无法建立本机启动连接，请联系开发者处理。");
  let previous;
  try {
    previous = await lstat(socketPath);
    if (!previous.isSocket() || previous.uid !== process.getuid() || (previous.mode & 0o077)) throw new Error("本机启动记录不安全，请联系开发者处理；账号资料未被更改。");
    return { reused: await connectToLauncher(socketPath) };
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    if (error.code === "ECONNREFUSED") {
      const stale = await lstat(socketPath);
      if (!previous || stale.ino !== previous.ino || !stale.isSocket() || stale.uid !== process.getuid()) throw new Error("另一个折页启动窗口正在准备，请稍候再试。");
      await unlink(socketPath);
    }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = "";
    let handled = false;
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk.toString("utf8");
      if (input.length > 1024) { handled = true; socket.destroy(); return; }
      if (!input.includes("\n")) return;
      handled = true;
      try {
        if (JSON.parse(input).action !== "reopen") throw new Error();
        socket.end(JSON.stringify({ status: await reopen() }));
      } catch { socket.end('{"status":"failed"}'); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  } catch (error) {
    if (error.code === "EADDRINUSE") return { reused: await connectToLauncher(socketPath) };
    throw error;
  }
  try { await chmod(socketPath, 0o600); }
  catch (error) { await new Promise((resolve) => server.close(resolve)); throw error; }
  return { async close() { await new Promise((resolve) => server.close(resolve)); } };
}

export function redactSetupLog(value) {
  return String(value)
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/#zhepage-pairing=[^\s"'<>]+/gi, "#zhepage-pairing=[redacted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\b(token|appsecret|secret|password|access_token|refresh_token|authorization)(["']?\s*[:=]\s*["']?)[^\s"'<>]+/gi, "$1$2[redacted]");
}

function runCommand(command, args, cwd, children, failureMessage, log, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"], detached: true });
    children.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        const end = pending.lastIndexOf("\n");
        if (end >= 0) { log(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
      });
      stream.on("end", () => { if (pending) log(pending); });
    }
    child.once("error", () => { children.delete(child); reject(new Error(failureMessage)); });
    child.once("close", (code) => { children.delete(child); if (code === 0) resolve(); else reject(new Error(failureMessage)); });
  });
}

export async function startLocalSession({ projectRoot, dataDir, createPageServer, createHelper, openPage, logger }) {
  let helper;
  let page;
  const close = async () => { await Promise.allSettled([page?.close(), helper?.close()]); };
  try {
    helper = await createHelper({ dataDir, allowedOrigins: [LOCAL_ORIGIN] });
    if (await helper.listen() !== 47831) throw new Error("本机助手未在预期地址启动。");
    page = await createPageServer({ root: projectRoot, logLevel: "warn", ...(logger ? { customLogger: logger } : {}), server: { host: "127.0.0.1", port: 5173, strictPort: true, open: false } });
    await page.listen();
    const checkPageAddress = () => {
      const address = page.httpServer?.address();
      if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port !== 5173) throw new Error("本机页面未在预期地址启动，请关闭启动窗口后重新双击启动。");
    };
    checkPageAddress();
    return { open: () => { checkPageAddress(); return openPage(`${LOCAL_ORIGIN}/#zhepage-pairing=${encodeURIComponent(helper.token)}`); }, close };
  } catch (error) {
    await close();
    if (error.code === "EADDRINUSE" || /Port 5173 is already in use/.test(error.message)) throw new Error("折页需要的本机端口已被占用。请关闭之前手动启动的折页页面和助手窗口，再双击启动；本工具不会关闭其他程序。");
    throw error;
  }
}

export async function launch() {
  if (platform() !== "darwin" || Number(release().split(".")[0]) < 23) throw new Error("此双击启动包需要 macOS 14 或更新版本。");
  if (!supportsNodeVersion(process.versions.node)) throw new Error("请先安装 Node.js 24 或更新版本：https://nodejs.org/zh-cn/download 。安装后再次双击启动即可。");
  process.chdir(PROJECT_ROOT);
  const { manifest, lock } = await inspectProject(PROJECT_ROOT);
  let session;
  const channel = await createLauncherChannel(DATA_DIR, async () => { if (!session) return "starting"; await session.open(); return "opened"; });
  if (channel.reused) {
    console.log(channel.reused === "opened" ? "已重新打开折页并自动连接本机助手。可以关闭这个新窗口。" : "折页正在原来的启动窗口中准备，完成后会自动打开页面。可以关闭这个新窗口。");
    return;
  }
  const children = new Set();
  const logPath = path.join(DATA_DIR, "launcher.log");
  let logWrites = Promise.resolve();
  const log = (value) => { logWrites = logWrites.then(() => appendFile(logPath, `${redactSetupLog(value)}\n`)).catch(() => {}); };
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
    await session?.close();
    await channel.close();
    await logWrites;
  };
  const onSignal = () => { void stop().finally(() => process.exit(0)); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, onSignal);
  try {
    await writeFile(logPath, `折页启动记录 ${new Date().toISOString()}\n`, { mode: 0o600 });
    await chmod(logPath, 0o600);
    console.log("折页本机开发版\n首次准备可能需要几分钟，请保持网络连接，无需重复双击。\n");
    if (!await dependenciesReady(PROJECT_ROOT, manifest, lock)) {
      console.log("[1/4] 正在安装折页依赖，请保持网络连接…");
      await runCommand("npm", ["ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"], PROJECT_ROOT, children, "依赖安装未完成。请检查网络后再次双击启动；不需要输入命令。", log);
    } else console.log("[1/4] 折页依赖已就绪。");
    console.log("[2/4] 正在检查排版字体和本机下载入口…");
    const assetOrigin = await prepareFonts(PROJECT_ROOT);
    const { writeLocalDraftPackage } = await import("../build/package-local-draft.mjs");
    await writeLocalDraftPackage({ projectDir: PROJECT_ROOT, output: path.join(PROJECT_ROOT, "public/downloads/zhepage-draft-helper.zip"), ...(assetOrigin ? { assetOrigin } : {}) });
    console.log("[3/4] 正在检查小红书使用的浏览器…");
    const { localBrowserLaunchOptions } = await import("./browserRuntime.mjs");
    await prepareBrowser(localBrowserLaunchOptions, () => runCommand(process.execPath, [require.resolve("@playwright/test/cli"), "install", "chromium", "--no-shell"], PROJECT_ROOT, children, "独立浏览器未下载完成。请检查网络后再次双击启动；不会读取你平时浏览器的账号。", log));
    console.log("[4/4] 正在启动本机页面和助手…");
    const [{ createServer: createPageServer, createLogger }, { createCompanion: createHelper }] = await Promise.all([import("vite"), import("./server.mjs")]);
    const logger = createLogger("silent");
    logger.warn = logger.warnOnce = logger.error = (message) => log(message);
    session = await startLocalSession({ projectRoot: PROJECT_ROOT, dataDir: DATA_DIR, createPageServer, createHelper, logger, openPage: (url) => runCommand("open", [url], PROJECT_ROOT, children, "浏览器未能自动打开，请再次双击“启动折页.command”重试。", log, true) });
    await session.open();
    console.log("\n折页已打开，并已自动连接本机助手。\n请保持这个窗口开启。需要重新打开页面时，再双击“启动折页.command”即可。\n关闭这个窗口会停止本次助手；不会删除草稿或账号资料。\n");
  } catch (error) {
    log([error.stack || error.message, error.cause?.stack].filter(Boolean).join("\n"));
    await stop();
    throw new Error(`${error.message}\n详细启动日志仅保存在本机：${logPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().catch((error) => { console.error(`\n启动未完成：${error.message}\n`); process.exitCode = 1; });
}
