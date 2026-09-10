import { readFile, stat } from "node:fs/promises";
import { createCloudSync } from "./server.mjs";

async function secretFile(name) {
  const file = process.env[name];
  if (!file) throw new Error(`缺少 ${name} 配置`);
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error(`${name} 必须指向权限为 0600 或 0400 的私密文件`);
  return (await readFile(file, "utf8")).trim();
}

try {
  const service = createCloudSync({
    passwords: JSON.parse(await secretFile("SYNC_KEYS_FILE")),
    accessPassword: await secretFile("SYNC_ACCESS_PASSWORD_FILE"),
    gatewaySecret: await secretFile("SYNC_GATEWAY_SECRET_FILE"),
    allowedOrigins: (process.env.SYNC_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
    ownerId: process.env.SYNC_OWNER_ID || "owner",
    host: process.env.SYNC_HOST || "127.0.0.1",
    port: Number(process.env.SYNC_PORT || 47832),
    onCleanupFailure: () => {
      console.error("临时浏览器清理失败，服务正在退出以释放会话；请核对未完成的草稿结果。");
      process.exit(1);
    },
  });
  await service.listen();
  console.log("网页同步服务已启动；未载入任何平台账号资料。");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void service.close().finally(() => process.exit(0)); });
} catch {
  console.error("网页同步服务启动失败。请检查私密文件权限、网页来源及运行环境。为保护密钥，详细配置不会输出。");
  process.exitCode = 1;
}
