import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

// Installed packages keep device credentials and local drafts outside versioned
// download folders. A repository checkout retains its own development data.
export function localPaths({ root = projectRoot, installed = process.argv.includes("--installed"), platform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  const privateDir = installed
    ? platform === "win32"
      ? resolve(localAppData || resolve(home, "AppData/Local"), "Zhepage/Sync")
      : resolve(home, "Library/Application Support/Zhepage/Sync")
    : resolve(root, ".wechat-sync-local");
  const identity = createHash("sha256").update(installed ? privateDir : root).digest("hex").slice(0, 12);
  return { privateDir, configPath: resolve(privateDir, "config.env"), jobsDir: resolve(privateDir, "jobs"),
    statusPath: resolve(privateDir, "assistant-status.json"), label: `com.zhepage.sync.${identity}`,
    pipePath: `\\\\.\\pipe\\zhepage-sync-${identity}`, installed };
}
