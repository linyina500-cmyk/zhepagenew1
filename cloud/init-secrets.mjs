import { mkdir, writeFile, stat, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("请指定仓库以外的绝对私密目录");
const repository = await realpath(new URL("..", import.meta.url));
const canonicalDirectory = path.join(await realpath(path.dirname(directory)), path.basename(directory));
if (canonicalDirectory === repository || canonicalDirectory.startsWith(`${repository}${path.sep}`)) throw new Error("密钥不能保存在项目仓库内");
await mkdir(directory, { mode: 0o700 });
if ((await stat(directory)).mode & 0o077) throw new Error("私密目录权限必须为 0700");
for (const [name, value] of [
  ["keys.json", JSON.stringify({ 1: randomBytes(32).toString("base64url") })],
  ["access-password", randomBytes(24).toString("base64url")],
  ["gateway-secret", randomBytes(32).toString("base64url")],
]) await writeFile(path.join(directory, name), `${value}\n`, { mode: 0o600, flag: "wx" });
console.log("已生成三个私密文件，未输出密钥。请按部署说明设置容器访问权限并妥善保管。");
