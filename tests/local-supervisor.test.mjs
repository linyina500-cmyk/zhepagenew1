import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const fixtureSecret = "synthetic-private-token-do-not-log-0123456789";
async function waitFor(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(15); }
  assert.fail(message);
}
async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), "zhepage-supervisor-")), serviceDir = join(project, "server/wechat"), localDir = join(project, ".wechat-sync-local");
  await mkdir(serviceDir, { recursive: true }); await mkdir(join(localDir, "bin"), { recursive: true });
  await copyFile(new URL("../server/wechat/local-start.mjs", import.meta.url), join(serviceDir, "local-start.mjs"));
  await writeFile(join(localDir, "config.env"), `WECHAT_SYNC_TOKEN=${fixtureSecret}\nWECHAT_APP_SECRET=synthetic-app-secret\n`);
  // The synthetic child never opens a port or browser. Readiness is released
  // explicitly, and both output streams deliberately contain fake credentials.
  await writeFile(join(serviceDir, "start.mjs"), `
    import { existsSync, writeFileSync } from "node:fs";
    writeFileSync("service-observed.json", JSON.stringify({ token: process.env.WECHAT_SYNC_TOKEN, secret: process.env.WECHAT_APP_SECRET }));
    console.log(process.env.WECHAT_SYNC_TOKEN); console.error(process.env.WECHAT_APP_SECRET);
    let ready = false, stopping = false;
    setInterval(() => {
      if (!ready && existsSync("release-ready")) { ready = true; console.log("公众号草稿服务已启动"); }
      if (existsSync("release-crash")) process.exit(3);
      if (existsSync("release-port-conflict")) { console.error("已被占用 synthetic-sensitive-diagnostic"); process.exit(1); }
    }, 15);
    process.on("SIGTERM", () => { if (stopping) return; stopping = true; writeFileSync("service-stopping", "true"); setTimeout(() => { writeFileSync("service-drained", "true"); process.exit(0); }, 200); });
    setTimeout(() => process.exit(2), 10000);
  `);
  await writeFile(join(localDir, "bin/cloudflared"), `#!${process.execPath}\nrequire("node:fs").writeFileSync("unexpected-tunnel", "started"); process.exit(9);\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(serviceDir, "local-start.mjs")], {
    cwd: project, env: { ...process.env, WECHAT_SYNC_TOKEN: "synthetic-inherited-token", WECHAT_APP_SECRET: "synthetic-inherited-secret" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.on("close", (code, signal) => resolve({ code, signal })); child.on("error", reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; await rm(project, { recursive: true, force: true }); });
  const exists = (path) => stat(join(project, path)).then(() => true, () => false);
  const status = () => readFile(join(localDir, "assistant-status.json"), "utf8").then(JSON.parse).catch(() => null);
  await waitFor(() => exists("service-observed.json"), "synthetic service did not start");
  return { project, localDir, child, closed, exists, status, get output() { return output; }, release: (name) => writeFile(join(project, name), "true") };
}

test("direct supervisor waits for service readiness without a tunnel, hides secrets and drains on repeated stop signals", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.status(), { pid: f.child.pid, ready: false });
  assert.doesNotMatch(f.output, /助手已就绪/);
  const observed = JSON.parse(await readFile(join(f.project, "service-observed.json"), "utf8"));
  assert.deepEqual(observed, { token: fixtureSecret, secret: "synthetic-app-secret" });
  await f.release("release-ready");
  await waitFor(async () => (await f.status())?.ready && f.output.includes("助手已就绪"), "supervisor did not acknowledge the local service");
  assert.equal(await f.exists("unexpected-tunnel"), false);
  assert.equal(await f.exists(".wechat-sync-local/tunnel-url.txt"), false);
  for (const file of ["config.env", "assistant-status.json"]) assert.equal((await stat(join(f.localDir, file))).mode & 0o777, 0o600);
  f.child.kill("SIGTERM"); await waitFor(() => f.exists("service-stopping"), "service never began graceful shutdown");
  f.child.kill("SIGHUP"); f.child.kill("SIGTERM");
  assert.deepEqual(await f.closed, { code: 0, signal: null });
  assert.equal(await f.exists("service-drained"), true);
  assert.deepEqual(await f.status(), { pid: f.child.pid, ready: false });
  assert.doesNotMatch(f.output, /synthetic-|WECHAT_APP_SECRET|WECHAT_SYNC_TOKEN/);
});

test("unexpected service exit clears readiness and fails the supervisor for controlled system recovery", async (t) => {
  const f = await fixture(t);
  await f.release("release-ready");
  await waitFor(async () => (await f.status())?.ready, "supervisor did not become ready");
  await f.release("release-crash");
  assert.deepEqual(await f.closed, { code: 1, signal: null });
  assert.deepEqual(await f.status(), { pid: f.child.pid, ready: false });
  assert.equal(await f.exists("unexpected-tunnel"), false);
  assert.doesNotMatch(f.output, /synthetic-|WECHAT_APP_SECRET|WECHAT_SYNC_TOKEN/);
});

test("a port conflict never reports readiness or emits raw child diagnostics", async (t) => {
  const f = await fixture(t);
  await f.release("release-port-conflict");
  assert.deepEqual(await f.closed, { code: 1, signal: null });
  assert.deepEqual(await f.status(), { pid: f.child.pid, ready: false });
  assert.doesNotMatch(f.output, /助手已就绪|synthetic-|WECHAT_APP_SECRET|WECHAT_SYNC_TOKEN/);
});
