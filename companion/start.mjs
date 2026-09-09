import { homedir, platform } from "node:os";
import path from "node:path";
import { createCompanion } from "./server.mjs";

const base = platform() === "darwin" ? path.join(homedir(), "Library", "Application Support")
  : platform() === "win32" ? (process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"))
    : path.join(homedir(), ".local", "share");
const dataDir = path.join(base, "Zhepage Draft Helper");
const extraOrigin = process.argv[2];
if (process.argv.length > 3) throw new Error("用法：npm run draft:helper -- http://127.0.0.1:5173");
const companion = await createCompanion({ dataDir, ...(extraOrigin ? { allowedOrigins: [extraOrigin] } : {}) });
try { await companion.listen(); }
catch (error) {
  if (error.code === "EADDRINUSE") throw new Error("本机助手已在运行（端口 47831），请使用原窗口中的配对码");
  throw error;
}
process.stdout.write(`\n折页本机草稿助手已启动\n配对码：${companion.token}\n请仅粘贴到你刚打开的本机折页页面。关闭助手后配对码失效。\n账号资料目录：${dataDir}\n公众号密钥仅在当前进程内存中保存，重启后需要重新连接。\n\n`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await companion.close();
  process.exit(0);
});
