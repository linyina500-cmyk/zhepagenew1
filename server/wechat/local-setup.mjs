import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
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

  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  output.isTTY = true;
  Object.defineProperty(output, "columns", { get: () => process.stdout.columns || 80 });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  readline.on("SIGINT", () => { controller.abort(); readline.close(); });
  readline.on("close", () => controller.abort());
  async function ask(prompt, secret = false) {
    process.stdout.write(prompt);
    hidden = secret;
    try { return (await readline.question("", { signal: controller.signal })).trim(); }
    finally { hidden = false; if (secret) process.stdout.write("\n"); }
  }
  async function required(prompt, secret = false) {
    while (true) {
      const value = await ask(prompt, secret);
      if (value && value.length <= 512 && !/[\r\n\0]/u.test(value)) return value;
      process.stdout.write("请填写非空的单行内容，最多 512 个字符。\n");
    }
  }

  try {
    process.stdout.write("公众号草稿同步 · 本机配置\nAppSecret 输入会隐藏；密钥和连接口令不会打印到窗口。\n\n");
    if (existing) {
      process.stdout.write("已有配置。重新配置会替换公众号凭据并生成新的连接口令，草稿任务记录会保留。\n");
      const choice = await ask("输入 1 重新配置；输入 2 或直接回车仅显示位置：");
      if (choice !== "1") {
        process.stdout.write(`未修改已有配置。私密文件位置：\n${configPath}\n`);
        return;
      }
    }
    const appId = await required("公众号 AppID：");
    const appSecret = await required("公众号 AppSecret（输入隐藏）：", true);
    const accountName = await required("公众号名称：");
    const fields = {
      WECHAT_APP_ID: appId,
      WECHAT_APP_SECRET: appSecret,
      WECHAT_ACCOUNT_NAME: accountName,
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
    process.stdout.write(`\n配置已保存，尚未连接公众号或上传内容。\n私密文件位置：\n${configPath}\n\n在本机打开该文件，复制 WECHAT_SYNC_TOKEN 等号后的连接口令，粘贴到折页的“公众号连接口令”。请勿发送到聊天。\n下一步双击“启动公众号.command”。\n`);
  } finally { hidden = false; readline.close(); output.end(); }
}

try { await setup(); }
catch (error) {
  process.stderr.write(error.name === "AbortError" ? "\n已取消配置，原有凭据未改变。\n" : error instanceof SetupError ? `${error.message}\n` : "配置未完成。请检查文件夹是否可写，并确认没有另一个配置窗口正在保存。原有草稿任务记录不会删除。\n");
  process.exitCode = 1;
}
