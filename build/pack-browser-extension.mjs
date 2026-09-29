import { readFile, writeFile, mkdir, rm, readdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function packBrowserExtension(outputRoot = path.join(root, "dist-extension")) {
  const source = path.join(root, "browser-extension");
  const files = (await readdir(source)).filter((name) => /^[a-z][a-z-]+\.mjs$/.test(name)).map((name) => `browser-extension/${name}`);
  files.push("lib/wechat/api.mjs");
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  const identity = JSON.parse(await readFile(path.join(source, "identity.json"), "utf8"));
  const derived = [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
  if (identity.id !== derived) throw new Error("Extension identity does not match manifest");
  const zip = new JSZip();
  const directory = path.join(outputRoot, "zhepage-draft-extension");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const contents = await readFile(path.join(root, file));
    // Fail closed if a server-only import ever enters the browser distribution.
    if (/from\s+["'](?:node:|\.\.\/server\/)/.test(contents.toString())) throw new Error(`Non-browser dependency in ${file}`);
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), contents);
    zip.file(file, contents, { date: new Date("2026-01-01T00:00:00Z") });
  }
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const instructions = "折页草稿同步插件\n\nWindows 和 Mac 共用此文件夹，无需安装电脑程序。\n1. 将整个文件夹放在固定位置。\n2. 在 Chrome 地址栏输入 chrome://extensions/，开启开发者模式，点击加载已解压的扩展程序，选择此文件夹（内含 manifest.json）。\n3. 回到折页，点击检测插件。同步期间保持浏览器和折页网页开启。\n\n更新插件：先等待当前同步完成，将新版文件覆盖原插件文件夹；在 chrome://extensions/ 点击折页插件的重新加载，再刷新折页网页。无需删除插件。\n\n插件仅保存草稿，不发表。小红书登录当前 Chrome 账号，草稿留在当前浏览器。公众号使用官方接口，需要账号权限和当前网络 IP 白名单。账号密钥不会上传折页网站，不会跨设备同步。公众号封面请在后台重新选择并确认保存。\n";
  for (const [name, content] of [["manifest.json", manifestText], ["开始使用.txt", instructions]]) {
    await writeFile(path.join(directory, name), content);
    zip.file(name, content, { date: new Date("2026-01-01T00:00:00Z") });
  }
  const archive = path.join(outputRoot, "zhepage-draft-extension.zip");
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  await writeFile(archive, data);
  return { archive, directory, bytes: data.length, id: derived };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await packBrowserExtension();
  await mkdir(path.join(root, "public/downloads"), { recursive: true });
  await cp(result.archive, path.join(root, "public/downloads/zhepage-draft-extension.zip"));
  console.log(JSON.stringify(result));
}
