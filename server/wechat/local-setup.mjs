import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const privateDir = resolve(projectRoot, ".wechat-sync-local");
const configPath = resolve(privateDir, "config.env");
const jobsDir = resolve(privateDir, "jobs");

class SetupError extends Error {}

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new SetupError("私密配置路径不是普通目录，请先检查 .wechat-sync-local 文件夹。");
  await chmod(path, 0o700);
}

// Node reads this file as data, never as shell commands. Verify quoting with the
// same parser that --env-file uses, including spaces, Chinese and literal $/`.
function envLine(name, value) {
  const candidates = /^[A-Za-z0-9_.:/-]+$/u.test(value) ? [value] : ["'", '"', "`"].filter((quote) => !value.includes(quote)).map((quote) => `${quote}${value}${quote}`);
  const encoded = candidates.find((candidate) => parseEnv(`${name}=${candidate}\n`)[name] === value);
  if (encoded === undefined) throw new SetupError("名称或文件夹路径包含无法保存的引号组合，请避免同时使用单引号、双引号和反引号。");
  return `${name}=${encoded}`;
}

async function setup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SetupError("请在 Mac 上双击“配置公众号.command”，在打开的终端窗口填写；不接受管道或命令行传入密钥。");
  const existingDirectory = await inspect(privateDir);
  if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) throw new SetupError(".wechat-sync-local 不是普通文件夹，请检查此路径后再配置。");
  const existing = await inspect(configPath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new SetupError("config.env 不是普通配置文件，请检查此路径后再配置。");

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  readline.on("SIGINT", () => { controller.abort(); readline.close(); });
  readline.on("close", () => controller.abort());
  const ask = (prompt) => readline.question(prompt, { signal: controller.signal });

  try {
    process.stdout.write("折页同步助手 · 首次准备\n这里准备这台电脑的连接。公众号资料请在折页网页中添加，仅在该浏览器加密保存。\n\n");
    if (existing) {
      process.stdout.write("这台电脑已准备好。重新配置会更换连接，原浏览器需要先移除账号再重新绑定；草稿任务记录会保留。\n");
      const choice = await ask("直接回车保留现有连接；只有需要重置时才输入 1：");
      if (choice !== "1") {
        process.stdout.write("已保留现有连接。双击“折页同步助手.command”，再回到折页网页点击“连接这台电脑”。\n");
        return;
      }
    }
    const fields = {
      WECHAT_SYNC_TOKEN: randomBytes(32).toString("hex"),
      WECHAT_DATA_DIR: jobsDir,
      WECHAT_HOST: "127.0.0.1",
      WECHAT_PORT: "8788",
    };
    const data = ["# 私密配置：请勿上传、分享或粘贴到聊天。", ...Object.entries(fields).map(([name, value]) => envLine(name, value)), ""].join("\n");
    await privateDirectory(privateDir);
    await privateDirectory(jobsDir);
    const temporaryPath = resolve(privateDir, `.config-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (existing) await rename(temporaryPath, configPath);
      else await link(temporaryPath, configPath); // Never replace a file created by another setup window.
    } finally { await unlink(temporaryPath).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    process.stdout.write("\n这台电脑已准备好，尚未上传任何内容。\n下一步双击“折页同步助手.command”，再回到折页网页点击“连接这台电脑”。无需寻找配置文件或填写口令。\n");
  } finally { readline.close(); }
}

try { await setup(); }
catch (error) {
  process.stderr.write(error.name === "AbortError" ? "\n已取消配置，原有凭据未改变。\n" : error instanceof SetupError ? `${error.message}\n` : "配置未完成。请检查文件夹是否可写，并确认没有另一个配置窗口正在保存。原有草稿任务记录不会删除。\n");
  process.exitCode = 1;
}
