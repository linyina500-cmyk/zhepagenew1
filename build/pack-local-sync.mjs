import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";

export const NODE_VERSION = "v24.21.0";
// From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt. Runtime updates are
// reviewed changes; the builder must never silently select a newer runtime.
export const RUNTIMES = {
  "darwin-arm64": { archive: "node-v24.21.0-darwin-arm64.tar.gz", sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" },
  "darwin-x64": { archive: "node-v24.21.0-darwin-x64.tar.gz", sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" },
  "win-x64": { archive: "node-v24.21.0-win-x64.zip", sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541" },
};
export const PACKAGES = {
  macos: { filename: "zhepage-sync-macos.zip", runtimes: ["darwin-arm64", "darwin-x64"] },
  "windows-x64": { filename: "zhepage-sync-windows-x64.zip", runtimes: ["win-x64"] },
};
// Copy only reviewed public runtime code. Never glob the repository: private
// configuration, receipts, login profiles, environment files and git stay out.
export const PUBLIC_FILES = [
  "server/wechat/start.mjs", "server/wechat/http.mjs", "server/wechat/pairing.mjs", "server/wechat/local-access.mjs",
  "server/wechat/jobs.mjs", "server/wechat/accounts.mjs", "server/wechat/publications.mjs",
  "server/wechat/local-setup.mjs", "server/wechat/local-start.mjs", "server/wechat/local-control.mjs",
  "server/wechat/local-paths.mjs", "server/wechat/local-windows.mjs", "lib/wechat/api.mjs",
  "server/xiaohongshu/driver.mjs", "server/xiaohongshu/image-evidence.mjs", "server/xiaohongshu/jobs.mjs", "server/xiaohongshu/http.mjs",
];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zipDate = new Date("2026-09-28T00:00:00.000Z");

export function verifyDigest(bytes, expected, algorithm = "sha256", encoding = "hex") {
  if (createHash(algorithm).update(bytes).digest(encoding) !== expected) throw new Error("下载文件校验失败，已停止打包。");
}
async function digestFile(path, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest(encoding);
}
async function downloadVerified(url, path, expected, algorithm = "sha256", encoding = "hex") {
  await mkdir(dirname(path), { recursive: true });
  let exists = true;
  try { await stat(path); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  if (!exists) {
    const temporary = `${path}.partial`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000), redirect: "error" });
      if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      if (await digestFile(temporary, algorithm, encoding) !== expected) throw new Error("下载文件校验失败，已停止打包。");
      await copyFile(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  if (await digestFile(path, algorithm, encoding) !== expected) throw new Error("缓存文件校验失败，请移除缓存后重新打包。");
  return path;
}
export function launcher(platform, action) {
  if (!["start", "stop", "status", "uninstall"].includes(action)) throw new Error("不支持的助手操作");
  if (platform === "windows-x64") return [
    "@echo off", "chcp 65001 >nul", "setlocal", "cd /d \"%~dp0\"",
    `\"%~dp0runtime\\node.exe\" \"%~dp0server\\wechat\\local-control.mjs\" ${action} --installed`,
    "set \"helper_exit=%errorlevel%\"", "echo.", "pause", "exit /b %helper_exit%", "",
  ].join("\r\n");
  return `#!/bin/bash\ncd -- "$(dirname -- "$0")" || exit 1\ncase "$(uname -m)" in\n  arm64) helper_node="runtime/darwin-arm64/bin/node" ;;\n  x86_64) helper_node="runtime/darwin-x64/bin/node" ;;\n  *) echo "此助手支持 Apple 芯片和 Intel Mac。"; exit 1 ;;\nesac\n"$helper_node" server/wechat/local-control.mjs ${action} --installed\nhelper_exit=$?\nif [ "$helper_exit" -ne 0 ]; then\n  echo "请检查上方提示，再重新打开助手。"\nfi\nread -r -p "按回车关闭此窗口…"\nexit "$helper_exit"\n`;
}
async function addFiles(zip, source, prefix) {
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const file = join(source, entry.name); const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await addFiles(zip, file, name);
    else if (entry.isFile()) zip.file(name, createReadStream(file), { date: zipDate, unixPermissions: 0o100644 });
    else throw new Error(`打包文件中不允许符号链接：${name}`);
  }
}
async function installDependencies(staging, cache, root) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const dependencies = {};
  for (const name of ["playwright", "playwright-core"]) {
    const metadata = lock.packages[`node_modules/${name}`];
    if (!metadata || !/^\d+\.\d+\.\d+$/.test(metadata.version) || !metadata.integrity?.startsWith("sha512-")) throw new Error("Playwright 的锁定版本或完整性信息无效");
    const url = `https://registry.npmjs.org/${name}/-/${name}-${metadata.version}.tgz`;
    const archive = await downloadVerified(url, join(cache, `${name}-${metadata.version}.tgz`), metadata.integrity.slice(7), "sha512", "base64");
    const directory = join(staging, "node_modules", name); await mkdir(directory, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], { stdio: "pipe" });
    dependencies[name] = { version: metadata.version, source: url, integrity: metadata.integrity };
  }
  return dependencies;
}
async function addRuntime(zip, target, staging, cache) {
  const runtime = RUNTIMES[target];
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${runtime.archive}`;
  const archive = await downloadVerified(url, join(cache, runtime.archive), runtime.sha256);
  const distribution = `node-${NODE_VERSION}-${target}`;
  if (target === "win-x64") {
    const upstream = await JSZip.loadAsync(await readFile(archive));
    for (const name of ["node.exe", "LICENSE"]) {
      const file = upstream.file(`${distribution}/${name}`);
      if (!file) throw new Error("官方 Node Windows 压缩包不完整");
      zip.file(`ZhepageSync/runtime/${name}`, await file.async("nodebuffer"), { date: zipDate, unixPermissions: name === "node.exe" ? 0o100755 : 0o100644 });
    }
  } else {
    const directory = join(staging, target); await mkdir(directory, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", directory, `${distribution}/bin/node`, `${distribution}/LICENSE`], { stdio: "pipe" });
    for (const name of ["bin/node", "LICENSE"]) zip.file(`ZhepageSync/runtime/${target}/${name}`, createReadStream(join(directory, name)), { date: zipDate, unixPermissions: name === "bin/node" ? 0o100755 : 0o100644 });
  }
  return { version: NODE_VERSION, source: url, sha256: runtime.sha256 };
}
export async function buildPackage(platform, { root = projectRoot, output = resolve(root, "dist-wechat") } = {}) {
  const spec = PACKAGES[platform]; if (!spec) throw new Error("支持的系统为 macos 或 windows-x64");
  const staging = await mkdtemp(join(tmpdir(), "zhepage-public-package-"));
  await mkdir(output, { recursive: true }); const cache = join(output, ".cache");
  try {
    const zip = new JSZip();
    for (const name of PUBLIC_FILES) zip.file(`ZhepageSync/${name}`, await readFile(join(root, name)), { date: zipDate, unixPermissions: 0o100644 });
    const dependencies = await installDependencies(staging, cache, root);
    await addFiles(zip, join(staging, "node_modules"), "ZhepageSync/node_modules");
    const runtimes = {};
    for (const target of spec.runtimes) runtimes[target] = await addRuntime(zip, target, staging, cache);
    const extension = platform === "macos" ? "command" : "cmd";
    const actions = { start: "启动折页同步助手", stop: "停止折页同步助手", status: "查看助手状态" };
    if (platform === "macos") actions.uninstall = "停用自动启动";
    for (const [action, name] of Object.entries(actions)) zip.file(`ZhepageSync/${name}.${extension}`, launcher(platform, action), { date: zipDate, unixPermissions: 0o100755 });
    zip.file("ZhepageSync/使用说明.txt", await readFile(join(root, "build/local-sync-package-readme.txt")), { date: zipDate, unixPermissions: 0o100644 });
    zip.file("ZhepageSync/package.json", `${JSON.stringify({ name: "zhepage-local-sync", version: "1.0.0", private: true, type: "module", engines: { node: "24.x" }, dependencies: { playwright: dependencies.playwright.version } }, null, 2)}\n`, { date: zipDate, unixPermissions: 0o100644 });
    let commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("无法识别打包代码版本");
    const manifest = { schema: 1, product: "ZhepageSync", version: "1.0.0", platform, commit, runtimes, dependencies, sourceFiles: PUBLIC_FILES };
    zip.file("ZhepageSync/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, { date: zipDate, unixPermissions: 0o100644 });
    const target = join(output, spec.filename);
    await pipeline(zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "UNIX" }), createWriteStream(`${target}.partial`));
    await copyFile(`${target}.partial`, target); await rm(`${target}.partial`);
    await chmod(target, 0o644);
    const sha256 = await digestFile(target);
    await writeFile(`${target}.sha256`, `${sha256}  ${spec.filename}\n`, { mode: 0o644 });
    console.info(`已生成 ${spec.filename}；内置 Node ${NODE_VERSION}，不含配置、密钥或用户数据。`);
    return { filename: target, sha256, manifest };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2] || "all";
  const targets = platform === "all" ? Object.keys(PACKAGES) : [platform];
  const checksums = [];
  for (const target of targets) { const result = await buildPackage(target); checksums.push(`${result.sha256}  ${PACKAGES[target].filename}`); }
  await writeFile(resolve(projectRoot, "dist-wechat/SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
}
