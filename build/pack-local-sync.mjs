import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// Explicit public-code allowlist; never copy config, receipts, or login profiles.
const files = [
  "server/wechat/.env.example", "server/wechat/start.mjs", "server/wechat/http.mjs", "server/wechat/pairing.mjs", "server/wechat/local-access.mjs",
  "server/wechat/jobs.mjs", "server/wechat/accounts.mjs", "server/wechat/publications.mjs",
  "server/wechat/local-setup.mjs", "server/wechat/local-start.mjs", "server/wechat/local-control.mjs", "server/wechat/配置公众号.command",
  "server/wechat/折页同步助手.command", "server/wechat/停止折页同步助手.command", "server/wechat/停用折页自动启动.command", "server/wechat/本机使用说明.md", "server/wechat/README.md",
  "server/wechat/zhepage-wechat.service", "server/wechat/Caddyfile.example", "lib/wechat/api.mjs",
  "server/xiaohongshu/driver.mjs", "server/xiaohongshu/jobs.mjs", "server/xiaohongshu/http.mjs", "server/xiaohongshu/README.md",
];
const staging = await mkdtemp(join(tmpdir(), "zhepage-local-package-"));
try {
  for (const file of files) {
    const target = join(staging, file); await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target); await chmod(target, file.endsWith(".command") ? 0o755 : 0o644);
  }
  await writeFile(join(staging, "package.json"), JSON.stringify({ name: "zhepage-local-sync", private: true, type: "module", engines: { node: "^22.18.0 || >=24.0.0" }, dependencies: { playwright: "1.63.0" } }, null, 2));
  await mkdir("dist-wechat", { recursive: true });
  execFileSync("tar", ["-czf", resolve("dist-wechat/zhepage-wechat-service.tar.gz"), "-C", staging, ...files, "package.json"]);
  console.info("已生成本机服务包，包含公开代码和空白配置，不包含密钥、任务或登录状态。");
} finally { await rm(staging, { recursive: true, force: true }); }
