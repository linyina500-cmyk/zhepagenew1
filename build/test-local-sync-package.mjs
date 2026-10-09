// Native smoke test for the exact downloadable ZIP, not the developer checkout.
// Uses a clean extraction path containing spaces/Chinese and no existing config.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import JSZip from "jszip";
import { NODE_VERSION, PACKAGES, PUBLIC_FILES } from "./pack-local-sync.mjs";

const platform = process.platform === "win32" ? "windows-x64" : process.platform === "darwin" ? "macos" : "";
assert.ok(platform, "Native package smoke tests require Windows or macOS");
const archivePath = resolve(process.argv[2] || `dist-wechat/${PACKAGES[platform].filename}`);
const structureOnly = process.argv.includes("--structure-only");
const scratch = await mkdtemp(join(tmpdir(), "折页 new computer "));
const directory = join(scratch, "ZhepageSync");
const env = { ...process.env };
// Windows installed mode is stable per user; isolate that user data for CI.
if (process.platform === "win32") env.LOCALAPPDATA = join(scratch, "user data");
const flags = ["--installed"];
let starter; let starterClosed; let started = false; let stopped = false;
let output = "";
function run(node, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(node, args, { cwd: directory, env, windowsHide: true }); let message = "";
    child.stdout.on("data", (chunk) => { message += chunk; }); child.stderr.on("data", (chunk) => { message += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolveRun(message) : reject(new Error(`Helper exited ${code}: ${message}`)));
  });
}
async function healthy() {
  try { const response = await fetch("http://127.0.0.1:8789/health", { signal: AbortSignal.timeout(1000) }); return response.ok && (await response.json()).ready === true; }
  catch { return false; }
}
async function waitFor(check, label) {
  for (let index = 0; index < 120; index++) { if (await check()) return; await pause(500); }
  throw new Error(`${label}: ${output}`);
}
let node;
try {
  const bytes = await readFile(archivePath);
  const sums = await readFile(`${archivePath}.sha256`, "utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sums.trim().split(/\s+/)[0]);
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, file] of Object.entries(zip.files)) {
    assert.ok(name.startsWith("ZhepageSync/"), `Unexpected archive entry: ${name}`);
    assert.doesNotMatch(name, /(^|\/)(\.git|\.wechat-sync-local|\.env|config\.env|browser-profile)(\/|$)/);
    const destination = resolve(scratch, name);
    assert.ok(!relative(scratch, destination).startsWith("..") && !isAbsolute(relative(scratch, destination)));
    if (file.dir) { await mkdir(destination, { recursive: true }); continue; }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await file.async("nodebuffer"));
    if (process.platform !== "win32") await chmod(destination, (Number(file.unixPermissions) & 0o777) || 0o644);
  }
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.platform, platform); assert.deepEqual(manifest.sourceFiles, PUBLIC_FILES);
  node = join(directory, process.platform === "win32" ? "runtime/node.exe" : `runtime/darwin-${process.arch}/bin/node`);
  assert.equal(execFileSync(node, ["--version"], { encoding: "utf8" }).trim(), NODE_VERSION);
  const architecture = JSON.parse(execFileSync(node, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch})"], { encoding: "utf8" }));
  assert.deepEqual(architecture, { platform: process.platform, arch: process.arch });
  execFileSync(node, ["--input-type=module", "-e", "const {chromium}=await import('playwright');if(!chromium)throw Error('missing playwright')"], { cwd: directory, env });
  if (!structureOnly) {
    // Launch the same installed Chrome channel, sandbox and direct-network
    // flags as the production driver. Use an empty isolated profile and page:
    // this exercises Windows/macOS browser launch without any platform account.
    await run(node, ["--input-type=module", "-e", `
      import { chromium } from "playwright";
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const profile = await mkdtemp(join(tmpdir(), "zhepage-browser-smoke-"));
      let context;
      try {
        context = await chromium.launchPersistentContext(profile, {
          channel: "chrome", headless: false, chromiumSandbox: true,
          args: ["--no-proxy-server"], handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
        });
        const page = context.pages()[0] || await context.newPage();
        await page.goto("about:blank");
        if (await page.evaluate(() => document.readyState) !== "complete") throw Error("Chrome page was not ready");
      } finally { if (context) await context.close(); await rm(profile, { recursive: true, force: true }); }
    `]);
    assert.equal(await healthy(), false, "An existing helper is listening; stop it before this isolated smoke test");
    starter = spawn(node, ["server/wechat/local-control.mjs", "start", ...flags], { cwd: directory, env, windowsHide: true });
    starter.stdout.on("data", (chunk) => { output += chunk; }); starter.stderr.on("data", (chunk) => { output += chunk; });
    starter.on("error", (error) => { output += error.message; });
    starterClosed = new Promise((resolveClosed) => starter.once("close", (code) => resolveClosed(code)));
    started = true;
    await waitFor(healthy, "Fresh installation did not become ready");
    // macOS start holds its controller lock until launchd readiness has been
    // acknowledged. A listening API alone does not mean that command returned.
    // Windows intentionally keeps the owner process running in its window.
    if (process.platform === "darwin") assert.equal(await starterClosed, 0, `Startup process failed: ${output}`);
    const nonce = randomBytes(32).toString("hex");
    const paired = await fetch("http://127.0.0.1:8789/pair", { method: "POST", headers: { Origin: "https://feature-local-draft-sync.zhepagenew.pages.dev", "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });
    assert.equal(paired.status, 200);
    const binding = await paired.json();
    assert.equal(binding.nonce, nonce); assert.match(binding.deviceId, /^[a-f0-9]{32}$/); assert.match(binding.connectionToken, /^[a-f0-9]{64}$/);
    const connection = await fetch("http://127.0.0.1:8788/api/wechat/connection", { headers: { Authorization: `Bearer ${binding.connectionToken}` } });
    assert.equal(connection.status, 200); assert.equal((await connection.json()).deviceId, binding.deviceId);
    assert.equal((await fetch("http://127.0.0.1:8788/api/wechat/connection")).status, 401);
    const rejected = await fetch("http://127.0.0.1:8789/pair", { method: "POST", headers: { Origin: "https://other.example", "Content-Type": "application/json" }, body: JSON.stringify({ nonce }) });
    assert.equal(rejected.status, 403);
    await run(node, ["server/wechat/local-control.mjs", "stop", ...flags]);
    await waitFor(async () => !await healthy(), "Helper did not stop");
    assert.equal(await starterClosed, 0, `Startup process failed: ${output}`);
    stopped = true;
    if (process.platform === "darwin") await run(node, ["server/wechat/local-control.mjs", "uninstall", ...flags]);
  }
  console.info(`Package ${platform}/${process.arch}: runtime, production dependencies, archive privacy${structureOnly ? "" : ", sandboxed Chrome launch, first start, pairing, authentication and graceful stop"} passed.`);
} finally {
  if (started && !stopped && node) {
    try { await run(node, ["server/wechat/local-control.mjs", "stop", ...flags]); stopped = !await healthy(); if (stopped) await starterClosed; } catch { /* Preserve failed installation for diagnosis. */ }
    if (stopped && process.platform === "darwin") { try { await run(node, ["server/wechat/local-control.mjs", "uninstall", ...flags]); } catch { /* Failure is visible in the test result. */ } }
  }
  if (!started || stopped) await rm(scratch, { recursive: true, force: true });
}
