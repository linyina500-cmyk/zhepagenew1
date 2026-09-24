import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { agentPlist, assistantReady, bootstrapAgent, parseAgentState, runWithControlLock, startAgent, stopAgent, stopInstalledAgent, unregisterStoppedAgent } from "../server/wechat/local-control.mjs";

const fixtureSecret = "synthetic-private-token-do-not-log-0123456789";
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "zhepage-control-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const unreachable = async () => assert.fail("This operation must not be called");

test("login agent starts at login and after failures, while a successful manual stop stays stopped", () => {
  const values = { label: "com.zhepage.fixture", nodePath: '/Applications/A&B/<node>"\'', supervisorPath: "/private/project/server/wechat/local-start.mjs", workDir: "/private/project", logPath: "/private/project/.wechat-sync-local/assistant.log" };
  const plist = agentPlist({ ...values, connectionToken: fixtureSecret, environment: { WECHAT_APP_SECRET: fixtureSecret } });
  const dom = new JSDOM(plist, { contentType: "application/xml" });
  try {
    const entries = new Map([...dom.window.document.querySelectorAll("dict > key")].map((node) => [node.textContent, node.nextElementSibling]));
    assert.deepEqual([...entries.get("ProgramArguments").children].map((node) => node.textContent), [values.nodePath, values.supervisorPath]);
    assert.equal(entries.get("WorkingDirectory").textContent, values.workDir);
    assert.equal(entries.get("StandardOutPath").textContent, values.logPath);
    assert.equal(entries.get("StandardErrorPath").textContent, values.logPath);
    assert.equal(entries.get("RunAtLoad").tagName, "true");
    assert.equal(entries.get("KeepAlive").tagName, "dict");
    assert.equal(entries.get("KeepAlive").querySelector("key").textContent, "SuccessfulExit");
    assert.equal(entries.get("KeepAlive").querySelector("key").nextElementSibling.tagName, "false");
    assert.equal(entries.get("ProcessType").textContent, "Background");
    assert.doesNotMatch(plist, /WECHAT_|EnvironmentVariables|--env-file|LaunchAgents|synthetic-private-token/);
  } finally { dom.window.close(); }
});

test("agent state distinguishes an active supervisor from an exited registered job", () => {
  assert.deepEqual(parseAgentState("gui/501/com.zhepage.fixture = {\n\tpath = /Users/fixture/Library/LaunchAgents/sync.plist\n\tstate = running\n\tpid = 2314\n}"), { registered: true, pid: 2314, definitionPath: "/Users/fixture/Library/LaunchAgents/sync.plist" });
  for (const output of ["\tstate = not running\n", "\tpid = 0\n", "\tlast exit code = 2314\n", "\tpid = invalid\n"]) {
    assert.deepEqual(parseAgentState(output), { registered: true, pid: null, definitionPath: null });
  }
});

test("repeated start installs login startup but preserves the running supervisor and current work", async () => {
  let checks = 0, preparations = 0;
  const dependencies = { inspect: async () => ({ registered: true, pid: 100 }), prepare: async () => { preparations++; }, bootstrap: unreachable,
    ready: async (pid) => { assert.equal(pid, 100); checks++; return true; }, pause: unreachable };
  await Promise.all([startAgent(dependencies), startAgent(dependencies)]);
  assert.equal(checks, 2);
  assert.equal(preparations, 2);
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
    pairingCalls++; assert.equal(url, "http://127.0.0.1:8789/health"); assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.headers, undefined);
    return Response.json({ service: "zhepage-local-pairing", ready: true });
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
  for (const response of [Response.json({ service: "zhepage-local-pairing", ready: true }, { status: 503 }), new Response("wrong local service"),
    Response.json({ service: "wrong-service", ready: true }), Response.json({ service: "zhepage-local-pairing", ready: false }), Response.json({ service: "zhepage-local-pairing", ready: "true" })]) {
    assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher: async () => response }), false);
  }
  assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher: async () => { throw new Error("pairing listener unavailable"); } }), false);
  assert.equal(await assistantReady({ pid: 100, statusPath, connection, fetcher }), true);
  assert.equal(pairingCalls, 1);
});

test("bootstrap replaces only an exited obsolete registration, while a running job is never unloaded", async () => {
  const plistPath = "/Users/fixture/Library/LaunchAgents/sync.plist";
  for (const definitionPath of [plistPath, "/private/old-temporary.plist", null]) {
    const calls = []; let registered = Boolean(definitionPath);
    const inspect = async () => ({ registered, pid: null, definitionPath });
    await bootstrapAgent({ inspect, plistPath,
      unregister: async () => { calls.push("unregister"); registered = false; },
      bootstrap: async () => { calls.push("bootstrap"); registered = true; }, kickstart: async () => calls.push("kickstart") });
    assert.deepEqual(calls, definitionPath === plistPath ? ["kickstart"] : definitionPath ? ["unregister", "bootstrap", "kickstart"] : ["bootstrap", "kickstart"]);
  }
  await bootstrapAgent({ inspect: async () => ({ registered: true, pid: 100 }), plistPath, unregister: unreachable, bootstrap: unreachable, kickstart: unreachable });
  await assert.rejects(unregisterStoppedAgent({ inspect: async () => ({ registered: true, pid: 100 }), bootout: unreachable }), /仍在运行/);
  let unloaded = 0;
  await unregisterStoppedAgent({ inspect: async () => ({ registered: true, pid: null }), bootout: async () => { unloaded++; } });
  await unregisterStoppedAgent({ inspect: async () => ({ registered: false, pid: null }), bootout: unreachable });
  assert.equal(unloaded, 1);
});

test("safe stop disables crash recovery before shutdown and preserves next-login startup after exit", async () => {
  const calls = []; let pid = 100;
  assert.equal(await stopInstalledAgent({ inspect: async () => ({ registered: true, pid }),
    connection: async () => { calls.push("check"); return { busy: false }; },
    disable: async () => calls.push("disable"), terminate: async () => { calls.push("term"); },
    pause: async () => { calls.push("wait"); pid = null; }, unregister: async () => { assert.equal(pid, null); calls.push("unregister"); },
    enable: async () => calls.push("enable"), remove: unreachable,
  }), true);
  assert.deepEqual(calls, ["check", "disable", "check", "term", "wait", "unregister", "enable"]);
});

test("stopping during launchd restart throttling removes the pending restart instead of falsely succeeding", async () => {
  const calls = []; let registered = true;
  assert.equal(await stopInstalledAgent({ inspect: async () => ({ registered, pid: null }), connection: unreachable, terminate: unreachable, pause: unreachable,
    disable: async () => calls.push("disable"), unregister: async () => { registered = false; calls.push("unregister"); },
    enable: async () => calls.push("enable"), remove: unreachable,
  }), true);
  assert.equal(registered, false); assert.deepEqual(calls, ["disable", "unregister", "enable"]);
});

test("permanent uninstall only removes startup after exit, retains browser data and can be enabled again", async () => {
  const calls = []; let pid = 100, registered = true, enabled = true, installed = true;
  const inspect = async () => ({ registered, pid });
  assert.equal(await stopInstalledAgent({ inspect, connection: async () => ({ busy: false }),
    disable: async () => { enabled = false; calls.push("disable"); }, terminate: async () => { pid = null; calls.push("term"); }, pause: unreachable,
    unregister: async () => { assert.equal(pid, null); registered = false; calls.push("unregister"); }, enable: unreachable,
    remove: async () => { assert.equal(registered, false); installed = false; calls.push("remove-startup"); }, permanent: true,
  }), true);
  assert.equal(enabled, false); assert.equal(installed, false);
  assert.deepEqual(calls, ["disable", "term", "unregister", "remove-startup"]);
  await startAgent({ inspect, prepare: async () => { installed = true; enabled = true; calls.push("install-enable"); },
    bootstrap: async () => { assert.equal(enabled, true); assert.equal(installed, true); registered = true; pid = 200; }, ready: async () => true, pause: unreachable });
  assert.equal(pid, 200); assert.equal(registered, true); assert.equal(enabled, true);
});

test("busy or unknown work blocks both signal and startup changes; timeout never unloads or force-kills", async () => {
  for (const state of [null, { busy: true }]) {
    await assert.rejects(stopInstalledAgent({ inspect: async () => ({ pid: 100 }), connection: async () => state,
      disable: unreachable, terminate: unreachable, pause: unreachable, unregister: unreachable, enable: unreachable, remove: unreachable }), /正在同步|无法确认同步状态/);
  }
  let terms = 0, disables = 0;
  assert.equal(await stopInstalledAgent({ inspect: async () => ({ pid: 100 }), connection: async () => ({ busy: false }),
    disable: async () => { disables++; }, terminate: async () => { terms++; }, pause: async () => {},
    unregister: unreachable, enable: unreachable, remove: unreachable, attempts: 2,
  }), false);
  assert.equal(disables, 1); assert.equal(terms, 1);
});

test("work that starts during stop preflight restores crash recovery without signaling the service", async () => {
  let checks = 0; const calls = [];
  await assert.rejects(stopInstalledAgent({ inspect: async () => ({ pid: 100 }), connection: async () => ({ busy: ++checks > 1 }),
    disable: async () => calls.push("disable"), enable: async () => calls.push("enable"), terminate: unreachable, pause: unreachable, unregister: unreachable, remove: unreachable,
  }), /正在同步/);
  assert.deepEqual(calls, ["disable", "enable"]);
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

test("macOS system lock serializes controllers and releases after an abnormal synthetic child exit", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await directory(t), scriptPath = join(root, "fixture.mjs"), lockPath = join(root, "control.lock");
  const first = join(root, "first"), second = join(root, "second");
  await writeFile(scriptPath, `import { writeFileSync, existsSync } from "node:fs";
    const prefix = process.argv[2]; writeFileSync(prefix + ".started", "true");
    const timer = setInterval(() => { if (existsSync(prefix + ".release")) { clearInterval(timer); process.exit(2); } }, 10);
    setTimeout(() => process.exit(3), 5000).unref();`);
  const active = runWithControlLock({ lockPath, scriptPath, action: first });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(await access(`${first}.started`).then(() => true, () => false))) await delay(10);
  await access(`${first}.started`);
  await assert.rejects(runWithControlLock({ lockPath, scriptPath, action: second }), /正在启动或停止/);
  assert.equal(await access(`${second}.started`).then(() => true, () => false), false);
  await writeFile(`${first}.release`, "true"); assert.equal(await active, 2);
  await writeFile(`${second}.release`, "true");
  assert.equal(await runWithControlLock({ lockPath, scriptPath, action: second }), 2);
  await access(`${second}.started`);
});
