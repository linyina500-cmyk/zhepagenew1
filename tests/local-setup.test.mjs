import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { localPaths } from "../server/wechat/local-paths.mjs";
import { ensureLocalConfig, envLine, protectPrivateDirectory } from "../server/wechat/local-setup.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhepage-first-use-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return localPaths({ root, installed: false });
}

test("first start needs no terminal input and creates only this device's random private connection", async (t) => {
  const paths = await fixture(t);
  assert.equal((await ensureLocalConfig({ paths })).created, true);
  const config = parseEnv(await readFile(paths.configPath, "utf8"));
  assert.match(config.WECHAT_SYNC_TOKEN, /^[a-f0-9]{64}$/u);
  assert.equal(config.WECHAT_HOST, "127.0.0.1");
  assert.equal(config.WECHAT_PORT, "8788");
  assert.equal(config.WECHAT_DATA_DIR, paths.jobsDir);
  assert.equal((await stat(config.WECHAT_DATA_DIR)).isDirectory(), true);
  assert.deepEqual(Object.keys(config).sort(), ["WECHAT_DATA_DIR", "WECHAT_HOST", "WECHAT_PORT", "WECHAT_SYNC_TOKEN"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.privateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
  }
  const other = await fixture(t);
  await ensureLocalConfig({ paths: other });
  assert.notEqual(parseEnv(await readFile(other.configPath, "utf8")).WECHAT_SYNC_TOKEN, config.WECHAT_SYNC_TOKEN);
});

test("repeated and simultaneous first starts never replace the device connection or task files", async (t) => {
  const paths = await fixture(t);
  await Promise.all([ensureLocalConfig({ paths }), ensureLocalConfig({ paths }), ensureLocalConfig({ paths })]);
  const initial = await readFile(paths.configPath, "utf8");
  await writeFile(join(paths.jobsDir, "retained.json"), '{"keep":true}');
  assert.equal((await ensureLocalConfig({ paths })).created, false);
  assert.equal(await readFile(paths.configPath, "utf8"), initial);
  assert.equal(await readFile(join(paths.jobsDir, "retained.json"), "utf8"), '{"keep":true}');
  assert.deepEqual((await readdir(paths.privateDir)).sort(), ["config.env", "jobs"]);
});

test("damaged or linked existing config fails without resetting the device's saved data", async (t) => {
  const paths = await fixture(t);
  await ensureLocalConfig({ paths });
  await writeFile(paths.configPath, "WECHAT_SYNC_TOKEN=broken\n");
  await assert.rejects(ensureLocalConfig({ paths }), /未覆盖原有资料/u);
  assert.equal(await readFile(paths.configPath, "utf8"), "WECHAT_SYNC_TOKEN=broken\n");
  if (process.platform !== "win32") {
    await rm(paths.configPath);
    const target = join(paths.privateDir, "outside.env");
    await writeFile(target, "unchanged");
    await symlink(target, paths.configPath);
    await assert.rejects(ensureLocalConfig({ paths }), /配置无效/u);
    assert.equal(await readFile(target, "utf8"), "unchanged");
  }
});

test("installed packages retain the same per-user storage across upgrades while development stays isolated", () => {
  for (const platform of ["win32", "darwin"]) {
    const options = { platform, installed: true, home: resolve("fixture-home"), localAppData: resolve("fixture-app-data") };
    const first = localPaths({ ...options, root: resolve("download-v1") });
    const second = localPaths({ ...options, root: resolve("download-v2") });
    assert.equal(first.privateDir, second.privateDir);
    assert.equal(first.label, second.label); assert.equal(first.pipePath, second.pipePath);
    assert.notEqual(first.privateDir, localPaths({ ...options, home: resolve("other-user"), localAppData: resolve("other-user-app-data") }).privateDir);
  }
  const root = resolve("fixture-development") + "/";
  const development = localPaths({ root, installed: false });
  assert.equal(development.privateDir, resolve(root, ".wechat-sync-local"));
  assert.equal(development.label, `com.zhepage.sync.${createHash("sha256").update(root).digest("hex").slice(0, 12)}`, "existing repository launchd label must not change");
});

test("paths with spaces, Chinese and Windows backslashes are parsed as literal data", () => {
  for (const value of ["C:\\Users\\测试 user\\AppData\\Local\\Zhepage\\Sync\\jobs", "/Users/测试 $` user/private data/jobs"]) {
    assert.equal(parseEnv(envLine("WECHAT_DATA_DIR", value)).WECHAT_DATA_DIR, value);
  }
});

test("Windows ACL protection uses the current SID, never a username shell command", async () => {
  const calls = [], path = "C:\\Users\\User Name\\Zhepage";
  await protectPrivateDirectory(path, "win32", async (...args) => { calls.push(args); return { stdout: '"computer\\fixture","S-1-5-21-111-222-333-1001"\r\n' }; });
  assert.equal(calls[0][0], "whoami.exe");
  assert.deepEqual(calls[1][1], [path, "/inheritance:r", "/grant:r", "*S-1-5-21-111-222-333-1001:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"]);
  assert.equal(calls[1][2].windowsHide, true);
  let changes = 0;
  await assert.rejects(protectPrivateDirectory(path, "win32", async () => { changes++; return { stdout: "unknown" }; }), /无法确认/u);
  assert.equal(changes, 1, "do not change ACLs without a verified user identity");
});
