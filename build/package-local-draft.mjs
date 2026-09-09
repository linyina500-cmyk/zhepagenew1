import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ASSET_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
export const DEFERRED_ASSET_FILES = Object.freeze([
  "public/fonts/source-han-sans-sc-vf.woff2",
  "public/fonts/source-han-serif-sc-vf.woff2",
]);

const DEFAULT_PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));
const ASSET_MANIFEST_PATH = "companion/runtime-assets.json";
const PROGRAM_DIRECTORY = "程序文件";
const OUTER_LAUNCHER = [
  "#!/bin/zsh",
  "",
  'cd -- "${0:A:h}/程序文件" || exit 1',
  "exec /bin/zsh ./启动折页.command",
  "",
].join("\n");
const ROOT_FILES = Object.freeze([
  "package.json", "package-lock.json", "vite.config.ts", "vite.pages.config.ts",
  "postcss.config.mjs", "tsconfig.json", "next-env.d.ts", "drizzle.config.ts",
  "eslint.config.mjs", "playwright.config.ts", "DRAFT_SYNC.md",
  "启动折页.command", "双击启动说明.txt",
]);
const OPTIONAL_ROOT_FILES = new Set(["README.md", "使用说明.md", "LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", "NOTICE.txt"]);

// Both directory paths and file types are limited. A new runtime directory
// must be deliberately added here rather than pulling in nearby user data.
const SOURCE_DIRECTORIES = {
  app: { directories: ["", "api", "api/import", "api/image", "components", "hooks"], extensions: [".ts", ".tsx", ".css"] },
  lib: { directories: ["", "async", "beautify", "draftSync", "export", "layouts", "pagination", "richText"], extensions: [".ts", ".tsx", ".mjs"] },
  worker: { directories: [""], extensions: [".ts"] },
  functions: { directories: ["", "api"], extensions: [".ts"] },
  build: { directories: [""], extensions: [".ts", ".mjs"] },
  companion: { directories: ["", "providers"], extensions: [".mjs"] },
  db: { directories: [""], extensions: [".ts"] },
  drizzle: { directories: ["", "meta"], extensions: [".sql"] },
  "pages-entry": { directories: [""], extensions: [".ts", ".tsx", ".html", ".css"] },
};
const PUBLIC_FILES = new Set([
  "public/_headers", "public/og.png", "public/og-zhepage.png", "public/hotspot-report-cover.webp",
  "public/fonts/LICENSE.txt",
]);
const EXTRA_FILES = new Set(["companion/THIRD_PARTY_NOTICES.md", "drizzle/meta/_journal.json"]);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  ...ROOT_FILES,
  "app/page.tsx", "app/layout.tsx", "app/globals.css", "lib/draftSync/validation.ts",
  "worker/index.ts", "functions/api/import.ts", "functions/api/image.ts",
  "build/sites-vite-plugin.ts", "build/finalize-pages-build.mjs", "build/prerender-static-shell.mjs", "build/package-local-draft.mjs",
  "companion/launch.mjs", "companion/server.mjs", "companion/security.mjs", "companion/accountStore.mjs",
  "companion/imageInput.mjs", "companion/browserRuntime.mjs", "companion/providers/wechat.mjs", "companion/providers/xiaohongshu.mjs",
  "companion/THIRD_PARTY_NOTICES.md", "public/fonts/LICENSE.txt",
  "db/index.ts", "db/schema.ts", "drizzle/meta/_journal.json", "pages-entry/index.html", "pages-entry/main.tsx",
]);

export function normalizeAssetOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("字体下载地址必须是完整的 HTTPS 来源"); }
  if (typeof value !== "string" || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("字体下载地址必须是 HTTPS 来源，不能包含账号、路径、查询参数或片段");
  }
  return url.origin;
}

async function isRegularSourceFile(projectDir, relativePath) {
  const segments = relativePath.split("/");
  let current = projectDir;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (info.isSymbolicLink()) return false;
    if (index === segments.length - 1) return info.isFile();
    if (!info.isDirectory()) return false;
  }
  return false;
}

async function collectSourceFiles(projectDir) {
  const selected = new Set();
  for (const relativePath of [...ROOT_FILES, ...OPTIONAL_ROOT_FILES, ...PUBLIC_FILES, ...EXTRA_FILES]) {
    if (await isRegularSourceFile(projectDir, relativePath)) selected.add(relativePath);
  }
  for (const [root, rule] of Object.entries(SOURCE_DIRECTORIES)) {
    const allowedDirectories = new Set(rule.directories);
    async function visit(relativeDirectory = "") {
      const directory = path.join(projectDir, root, relativeDirectory);
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (info.isSymbolicLink() || !info.isDirectory()) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          if (allowedDirectories.has(relative)) await visit(relative);
          continue;
        }
        if (!entry.isFile()) continue;
        const archivePath = path.posix.join(root, relative);
        const drizzleMetadata = /^drizzle\/meta\/\d{4}_snapshot\.json$/.test(archivePath);
        if (rule.extensions.includes(path.extname(entry.name)) || EXTRA_FILES.has(archivePath) || drizzleMetadata) selected.add(archivePath);
      }
    }
    await visit();
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!selected.has(required)) throw new Error(`启动包缺少必需文件，或文件为符号链接：${required}`);
  }
  return [...selected].sort();
}

export async function createLocalDraftPackage({ projectDir = DEFAULT_PROJECT_DIR, assetOrigin } = {}) {
  projectDir = path.resolve(projectDir);
  const origin = normalizeAssetOrigin(assetOrigin ?? process.env.CF_PAGES_URL ?? DEFAULT_ASSET_ORIGIN);
  const files = await collectSourceFiles(projectDir);
  const assetManifest = { assetOrigin: origin, files: [] };
  for (const relativePath of DEFERRED_ASSET_FILES) {
    if (!await isRegularSourceFile(projectDir, relativePath)) throw new Error(`启动包缺少字体源文件，或字体为符号链接：${relativePath}`);
    const bytes = await readFile(path.join(projectDir, relativePath));
    if (!bytes.length) throw new Error(`字体源文件为空：${relativePath}`);
    assetManifest.files.push({ path: relativePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }

  const zip = new JSZip();
  const addFile = (relativePath, contents) => {
    zip.file(relativePath, contents, { createFolders: false, unixPermissions: path.posix.basename(relativePath) === "启动折页.command" ? 0o100755 : 0o100644 });
  };
  zip.file(`${PROGRAM_DIRECTORY}/`, null, { dir: true, createFolders: false, unixPermissions: 0o40755 });
  addFile("启动折页.command", OUTER_LAUNCHER);
  addFile("双击启动说明.txt", await readFile(path.join(projectDir, "双击启动说明.txt")));
  for (const relativePath of files) addFile(`${PROGRAM_DIRECTORY}/${relativePath}`, await readFile(path.join(projectDir, relativePath)));
  addFile(`${PROGRAM_DIRECTORY}/${ASSET_MANIFEST_PATH}`, `${JSON.stringify(assetManifest, null, 2)}\n`);
  const buffer = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error(`启动包超过 25 MiB 上限（当前 ${buffer.length.toLocaleString("en-US")} 字节），未写出压缩包`);
  return { buffer, bytes: buffer.length, files: Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort(), assetManifest };
}

export async function writeLocalDraftPackage({ projectDir = DEFAULT_PROJECT_DIR, output, assetOrigin } = {}) {
  const result = await createLocalDraftPackage({ projectDir, assetOrigin });
  const outputPath = path.resolve(output ?? path.join(projectDir, "dist-pages/downloads/zhepage-draft-helper.zip"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, result.buffer, { flag: "wx", mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } finally { await rm(temporaryPath, { force: true }); }
  return { ...result, outputPath };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help") {
      process.stdout.write("用法：node build/package-local-draft.mjs [--asset-origin https://example.pages.dev] [--output /path/to/helper.zip]\n");
      return;
    }
    const match = /^(--asset-origin|--output)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`不支持的打包参数：${argument}`);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${match[1]} 需要一个值`);
    options[match[1] === "--asset-origin" ? "assetOrigin" : "output"] = value;
  }
  const result = await writeLocalDraftPackage(options);
  process.stdout.write(`本机启动包已生成：${result.outputPath}\n大小：${(result.bytes / 1024 / 1024).toFixed(2)} MiB\n字体将在首次启动时从 ${result.assetManifest.assetOrigin} 下载并核对。\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`打包失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
