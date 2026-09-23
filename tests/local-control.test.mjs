import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { agentPlist, assistantReady, parseAgentState, startAgent, stopAgent } from "../server/wechat/local-control.mjs";

const fixtureSecret = "synthetic-private-token-do-not-log-0123456789";
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "zhepage-control-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const unreachable = async () => assert.fail("This operation must not be called");

test("private launch agent contains only escaped paths and never enables automatic starts or credentials", () => {
  const values = { label: "com.zhepage.fixture", nodePath: '/Applications/A&B/<node>"\'', supervisorPath: "/private/project/server/wechat/local-start.mjs", workDir: "/private/project", logPath: "/private/project/.wechat-sync-local/assistant.log" };
  const plist = agentPlist({ ...values, connectionToken: fixtureSecret, environment: { WECHAT_APP_SECRET: fixtureSecret } });
  const dom = new JSDOM(plist, { contentType: "application/xml" });
  try {
    const entries = new Map([...dom.window.document.querySelectorAll("dict > key")].map((node) => [node.textContent, node.nextElementSibling]));
    assert.deepEqual([...entries.get("ProgramArguments").children].map((node) => node.textContent), [values.nodePath, values.supervisorPath]);
    assert.equal(entries.get("WorkingDirectory").textContent, values.workDir);
    assert.equal(entries.get("StandardOutPath").textContent, values.logPath);
    assert.equal(entries.get("StandardErrorPath").textContent, values.logPath);
    assert.equal(entries.get("RunAtLoad").tagName, "false");
    assert.equal(entries.get("KeepAlive").tagName, "false");
    assert.equal(entries.get("ProcessType").textContent, "Background");
    assert.doesNotMatch(plist, /WECHAT_|EnvironmentVariables|--env-file|LaunchAgents|synthetic-private-token/);
  } finally { dom.window.close(); }
});

test("agent state distinguishes an active supervisor from an exited registered job", () => {
  assert.deepEqual(parseAgentState("gui/501/com.zhepage.fixture = {\n\tstate = running\n\tpid = 2314\n}"), { registered: true, pid: 2314 });
  for (const output of ["\tstate = not running\n", "\tpid = 0\n", "\tlast exit code = 2314\n", "\tpid = invalid\n"]) {
    assert.deepEqual(parseAgentState(output), { registered: true, pid: null });
  }
});

test("repeated start reuses the running supervisor without preparing or launching another instance", async () => {
  let checks = 0;
  const dependencies = { inspect: async () => ({ registered: true, pid: 100 }), prepare: unreachable, bootstrap: unreachable,
    ready: async (pid) => { assert.equal(pid, 100); checks++; return true; }, pause: unreachable };
  await Promise.all([startAgent(dependencies), startAgent(dependencies)]);
  assert.equal(checks, 2);
});

test("first start and a manually restarted stopped job prepare once and wait for complete readiness", async () => {
  for (const registered of [false, true]) {
    const calls = []; let pid = null, checks = 0;
    await startAgent({ inspect: async () => ({ registered, pid }), prepare: async () => calls.push("prepare"),
      bootstrap: async (known) => { calls.push(["bootstrap", known]); pid = 100; },
      ready: async () => ++checks === 3, pause: async () => calls.push("wait"), attempts: 4 });
    assert.deepEqual(calls, ["prepare", ["bootstrap", registered], "wait", "wait"]);
    assert.equal(checks, 3);
  }
});

test("unready and prematurely exited supervisors never report a successful start or retry launch", async () => {
  for (const pid of [100, null]) {
    let launches = 0, waits = 0;
    await assert.rejects(startAgent({ inspect: async () => ({ registered: true, pid }), prepare: async () => {}, bootstrap: async () => { launches++; },
      ready: async () => false, pause: async () => { waits++; }, attempts: 5 }), /未准备好|未能启动/);
    assert.equal(launches, pid ? 0 : 1);
    assert.equal(waits, pid ? 5 : 3);
  }
  await assert.rejects(startAgent({ inspect: async () => ({ registered: false, pid: null }), prepare: async () => { throw new Error("prepare refused"); }, bootstrap: unreachable, ready: unreachable, pause: unreachable }), /prepare refused/);
});

test("readiness needs a current supervisor, an authenticated sync service and a working pairing listener", async (t) => {
  const statusPath = join(await directory(t), "status.json");
  let connectionCalls = 0, pairingCalls = 0;
  const connection = async () => { connectionCalls++; return { deviceId: "a".repeat(32), busy: false }; };
  const fetcher = async (url, options) => {
    pairingCalls++; assert.equal(url, "http://127.0.0.1:8789/connect"); assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers, undefined);
    return new Response("<script>zhepage-local-ready</script>");
  };
  for (const status of [null, "{invalid", { pid: 99, ready: true }, { pid: 100, ready: false }]) {
    if (status !== null) await writeFile(statusPath, typeof status === "string" ? status : JSON.stringify(status));
    assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher }), false);
  }
  assert.equal(connectionCalls, 0); assert.equal(pairingCalls, 0);
  await writeFile(statusPath, JSON.stringify({ pid: 100, ready: true }));
  assert.equal(await assistantReady({ pid: 100, statusPath, connection: async () => null, fetcher }), false);
  assert.equal(await assistantReady({ pid: 100, statusPath, connection: async () => { throw new Error("service unavailable"); }, fetcher }), false);
  assert.equal(pairingCalls, 0, "do not probe or accept pairing before the authenticated sync service is available");
  for (const response of [new Response("zhepage-local-ready", { status: 503 }), new Response("wrong local service")]) {
    assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher: async () => response }), false);
  }
  assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher: async () => { throw new Error("pairing listener unavailable"); } }), false);
  assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher }), true);
  assert.equal(pairingCalls, 1);
});

test("stop refuses active work or unknown state and never signals a stopped supervisor", async () => {
  assert.equal(await stopAgent({ inspect: async () => ({ pid: null }), connection: unreachable, terminate: unreachable, pause: unreachable }), true);
  for (const state of [null, { busy: true }]) {
    await assert.rejects(stopAgent({ inspect: async () => ({ pid: 100 }), connection: async () => state, terminate: unreachable, pause: unreachable }), /正在同步|无法确认同步状态/);
  }
});

test("idle stop signals once and waits; a slow shutdown never escalates to a forced kill", async () => {
  let signals = 0, inspections = 0, waits = 0;
  assert.equal(await stopAgent({ inspect: async () => ({ pid: ++inspections < 4 ? 100 : null }), connection: async () => ({ busy: false }),
    terminate: async () => { signals++; }, pause: async () => { waits++; }, attempts: 5 }), true);
  assert.equal(signals, 1); assert.equal(waits, 2);
  signals = 0;
  assert.equal(await stopAgent({ inspect: async () => ({ pid: 100 }), connection: async () => ({ busy: false }),
    terminate: async () => { signals++; }, pause: async () => {}, attempts: 3 }), false);
  assert.equal(signals, 1, "timeout must not send additional termination signals");
});

async function waitFor(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(15); }
  assert.fail(message);
}

test("isolated supervisor waits for tunnel registration, redacts child logs and drains after repeated stop signals", async (t) => {
  const project = await directory(t), serviceDir = join(project, "server/wechat"), localDir = join(project, ".wechat-sync-local");
  await mkdir(serviceDir, { recursive: true }); await mkdir(join(localDir, "bin"), { recursive: true });
  await copyFile(new URL("../server/wechat/local-start.mjs", import.meta.url), join(serviceDir, "local-start.mjs"));
  await writeFile(join(localDir, "config.env"), `WECHAT_SYNC_TOKEN=${fixtureSecret}\nWECHAT_APP_SECRET=synthetic-app-secret\n`);
  // Synthetic children deliberately emit their fake credentials. They open no
  // ports, browser profiles, platform connections or actual Cloudflare tunnel.
  await writeFile(join(serviceDir, "start.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync("service-observed.json", JSON.stringify({ token: process.env.WECHAT_SYNC_TOKEN, secret: process.env.WECHAT_APP_SECRET }));
    console.log(process.env.WECHAT_SYNC_TOKEN); console.error(process.env.WECHAT_APP_SECRET);
    console.log("公众号草稿服务已启动");
    let stopping = false;
    process.on("SIGTERM", () => { if (stopping) return; stopping = true; writeFileSync("service-stopping", "true"); setTimeout(() => { writeFileSync("service-drained", "true"); process.exit(0); }, 200); });
    setInterval(() => {}, 1000); setTimeout(() => process.exit(2), 10000);
  `);
  await writeFile(join(localDir, "bin/cloudflared"), `#!${process.execPath}
    const { existsSync, writeFileSync } = require("node:fs");
    writeFileSync("tunnel-observed.json", JSON.stringify({ credentialKeys: Object.keys(process.env).filter((key) => key.startsWith("WECHAT_")), args: process.argv.slice(2) }));
    console.error(${JSON.stringify(fixtureSecret)}); console.error("https://fixture-only.trycloudflare.com");
    writeFileSync("tunnel-url-announced", "true");
    let sent = false;
    setInterval(() => { if (!sent && existsSync("release-tunnel")) { sent = true; console.error("Registered tunnel connection"); } }, 15);
    process.on("SIGTERM", () => { writeFileSync("tunnel-stopped", "true"); process.exit(0); });
    setTimeout(() => process.exit(2), 10000);
  `, { mode: 0o755 });
  const child = spawn(process.execPath, [join(serviceDir, "local-start.mjs")], {
    cwd: project, env: { ...process.env, WECHAT_SYNC_TOKEN: "synthetic-inherited-token", WECHAT_APP_SECRET: "synthetic-inherited-secret" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => { child.on("close", (code, signal) => resolve({ code, signal })); child.on("error", reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; });
  const exists = (path) => stat(join(project, path)).then(() => true, () => false);
  const status = () => readFile(join(localDir, "assistant-status.json"), "utf8").then(JSON.parse);
  await waitFor(() => exists("tunnel-url-announced"), "fake tunnel did not start");
  assert.deepEqual(await status(), { pid: child.pid, ready: false });
  assert.doesNotMatch(output, /助手已就绪/);
  assert.equal(await exists(".wechat-sync-local/tunnel-url.txt"), false);
  const observed = JSON.parse(await readFile(join(project, "service-observed.json"), "utf8"));
  assert.deepEqual(observed, { token: fixtureSecret, secret: "synthetic-app-secret" });
  const tunnel = JSON.parse(await readFile(join(project, "tunnel-observed.json"), "utf8"));
  assert.deepEqual(tunnel.credentialKeys, []);
  assert.deepEqual(tunnel.args, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8788"]);
  await writeFile(join(project, "release-tunnel"), "true");
  await waitFor(async () => (await status().catch(() => null))?.ready && output.includes("助手已就绪"), "supervisor did not acknowledge the registered tunnel");
  assert.equal(await readFile(join(localDir, "tunnel-url.txt"), "utf8"), "https://fixture-only.trycloudflare.com\n");
  for (const file of ["config.env", "assistant-status.json", "tunnel-url.txt"]) assert.equal((await stat(join(localDir, file))).mode & 0o777, 0o600);
  child.kill("SIGTERM"); await waitFor(() => exists("service-stopping"), "service never began graceful shutdown");
  child.kill("SIGHUP"); child.kill("SIGTERM");
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(await exists("service-drained"), true); assert.equal(await exists("tunnel-stopped"), true);
  assert.deepEqual(await status(), { pid: child.pid, ready: false });
  assert.doesNotMatch(output, /synthetic-|WECHAT_APP_SECRET|WECHAT_SYNC_TOKEN/);
  assert.equal(output.includes(fixtureSecret), false);
});
