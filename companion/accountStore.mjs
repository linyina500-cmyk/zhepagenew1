import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function publicAccount(account) {
  return { id: account.id, platform: account.platform, displayName: account.displayName, remoteId: account.remoteId, ready: account.platform === "xiaohongshu" || Boolean(account.appSecret), syncBlocked: Boolean(account.pendingJobId) };
}

export async function createAccountStore(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const file = path.join(dataDir, "accounts.json");
  let saved = [];
  try { saved = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("本机账号目录无法读取，请检查文件权限和存档完整性"); }
  if (!Array.isArray(saved) || !saved.every((account) => /^[a-f0-9-]{36}$/.test(account.id) && ["wechat", "xiaohongshu"].includes(account.platform) && typeof account.remoteId === "string" && typeof account.displayName === "string")) throw new Error("本机账号记录无效");
  const accounts = new Map(saved.map((account) => [account.id, { id: account.id, platform: account.platform, remoteId: account.remoteId, displayName: account.displayName, ...(typeof account.pendingJobId === "string" ? { pendingJobId: account.pendingJobId } : {}), ...(account.platform === "wechat" ? { appId: account.remoteId } : {}) }]));
  let writes = Promise.resolve();
  async function persist() {
    const metadata = [...accounts.values()].map(({ id, platform, displayName, remoteId, pendingJobId }) => ({ id, platform, displayName, remoteId, pendingJobId }));
    const write = writes.then(async () => {
      await writeFile(`${file}.tmp`, JSON.stringify(metadata), { mode: 0o600 });
      await chmod(`${file}.tmp`, 0o600);
      await rename(`${file}.tmp`, file);
    });
    writes = write.catch(() => {});
    await write;
  }
  return {
    accounts,
    async set(account) { accounts.set(account.id, account); await persist(); },
    async remove(id) {
      if (!accounts.has(id)) throw new Error("账号不存在");
      accounts.delete(id);
      await persist();
      await rm(path.join(dataDir, `profile-${id}`), { recursive: true, force: true });
    },
    async profilePath(id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("账号标识无效");
      const profile = path.join(dataDir, `profile-${id}`);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await chmod(profile, 0o700);
      return profile;
    },
    async discardProfile(id) {
      if (!/^[a-f0-9-]{36}$/.test(id) || accounts.has(id)) throw new Error("不能清理已连接的账号目录");
      await rm(path.join(dataDir, `profile-${id}`), { recursive: true, force: true });
    },
  };
}
