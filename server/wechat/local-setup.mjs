import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { localPaths } from "./local-paths.mjs";

const execute = promisify(execFile);
export class SetupError extends Error {}

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function protectPrivateDirectory(path, platform = process.platform, run = execute) {
  if (platform !== "win32") { await chmod(path, 0o700); return; }
  // chmod does not apply Windows ACLs. Newly written connection tokens inherit
  // only this user's and SYSTEM's permissions.
  const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 });
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/u.exec(identity.stdout.trim())?.[1];
  if (!sid) throw new SetupError("无法确认当前 Windows 用户，请重新打开助手。");
  await run("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, timeout: 5000 });
}

async function privateDirectory(path, protect) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new SetupError("助手的私密文件夹无效，请检查安装位置。");
  await protect(path);
}

// Read as data, never shell commands, including literal Windows backslashes.
export function envLine(name, value) {
  const candidates = /^[A-Za-z0-9_.:/-]+$/u.test(value) ? [value] : ["'", '"', "`"].filter((quote) => !value.includes(quote)).map((quote) => `${quote}${value}${quote}`);
  const encoded = candidates.find((candidate) => parseEnv(`${name}=${candidate}\n`)[name] === value);
  if (encoded === undefined) throw new SetupError("安装位置包含无法保存的引号组合，请换一个文件夹。");
  return `${name}=${encoded}`;
}

export async function ensureLocalConfig({ paths = localPaths(), protect = protectPrivateDirectory } = {}) {
  const { privateDir, configPath, jobsDir } = paths;
  const existingDirectory = await inspect(privateDir);
  if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) throw new SetupError("助手的私密文件夹无效，请检查安装位置。");
  await privateDirectory(privateDir, protect);
  const existing = await inspect(configPath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new SetupError("助手的连接配置无效，请检查安装位置。");
  if (existing) {
    const config = parseEnv(await readFile(configPath, "utf8"));
    if (typeof config.WECHAT_SYNC_TOKEN !== "string" || config.WECHAT_SYNC_TOKEN.length < 32 || config.WECHAT_SYNC_TOKEN.length > 256 || /\s/u.test(config.WECHAT_SYNC_TOKEN)) throw new SetupError("已保存的本机连接配置无效，未覆盖原有资料，请联系维护人员。");
    if (process.platform !== "win32") await chmod(configPath, 0o600);
    return { created: false };
  }
  await privateDirectory(jobsDir, protect);
  const fields = { WECHAT_SYNC_TOKEN: randomBytes(32).toString("hex"), WECHAT_DATA_DIR: jobsDir, WECHAT_HOST: "127.0.0.1", WECHAT_PORT: "8788" };
  const data = ["# 私密配置：请勿上传、分享或粘贴到聊天。", ...Object.entries(fields).map(([name, value]) => envLine(name, value)), ""].join("\n");
  const temporaryPath = resolve(privateDir, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await link(temporaryPath, configPath); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await unlink(temporaryPath).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  // A simultaneous first start must use the winner's token; never replace it.
  await ensureLocalConfig({ paths, protect });
  return { created: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureLocalConfig().then(() => console.info("这台电脑已准备好。打开折页同步助手后，在网页点击连接即可。无需寻找配置文件或填写口令。"))
    .catch((error) => { console.error(error instanceof SetupError ? error.message : "准备助手失败，请确认安装文件夹可写后重试。原有资料未改变。"); process.exitCode = 1; });
}
