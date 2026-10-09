import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NODE_VERSION, PACKAGES, PUBLIC_FILES, RUNTIMES, launcher, verifyDigest } from "../build/pack-local-sync.mjs";

test("distribution has only two choices and Mac bundles both chip types", () => {
  assert.deepEqual(Object.keys(PACKAGES).sort(), ["macos", "windows-x64"]);
  assert.deepEqual(PACKAGES.macos.runtimes, ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(PACKAGES["windows-x64"].runtimes, ["win-x64"]);
  assert.match(NODE_VERSION, /^v24\.\d+\.\d+$/);
  for (const runtime of Object.values(RUNTIMES)) assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
});

test("public runtime allowlist cannot include a private directory or environment file", () => {
  assert.equal(new Set(PUBLIC_FILES).size, PUBLIC_FILES.length);
  for (const file of PUBLIC_FILES) {
    assert.match(file, /^(server\/(wechat|xiaohongshu)|lib\/wechat)\/[\w.-]+\.mjs$/);
    assert.doesNotMatch(file, /(^|\/)(\.env|\.git|\.wechat|config|jobs\/|browser-profile)/);
  }
  assert.ok(PUBLIC_FILES.includes("server/wechat/local-paths.mjs"));
  assert.ok(PUBLIC_FILES.includes("server/wechat/local-windows.mjs"));
});

test("runtime integrity check rejects modified bytes", () => {
  verifyDigest(Buffer.from("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.throws(() => verifyDigest(Buffer.from("tampered"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"), /校验失败/);
});

test("Windows launcher uses only bundled Node and quotes paths with spaces", () => {
  const value = launcher("windows-x64", "start");
  assert.ok(value.includes('"%~dp0runtime\\node.exe" "%~dp0server\\wechat\\local-control.mjs" start --installed'));
  assert.ok(value.includes("pause\r\n"));
  assert.doesNotMatch(value, /taskkill|start \/b|npm|npx|powershell|ExecutionPolicy/);
  assert.equal(value.replaceAll("\r\n", "").includes("\n"), false);
});

test("Mac launcher chooses matching bundled Node and installed user directory", () => {
  const value = launcher("macos", "start");
  assert.ok(value.includes('arm64) helper_node="runtime/darwin-arm64/bin/node"'));
  assert.ok(value.includes('x86_64) helper_node="runtime/darwin-x64/bin/node"'));
  assert.ok(value.includes('"$helper_node" server/wechat/local-control.mjs start --installed'));
  assert.doesNotMatch(value, /brew|npm|npx|xattr|sudo/);
});

test("package copy instructions do not ask users to provide configuration or tokens", async () => {
  const text = await readFile(new URL("../build/local-sync-package-readme.txt", import.meta.url), "utf8");
  assert.match(text, /不需要填写或上传配置文件/);
  assert.match(text, /Windows 10 \/ 11/);
  assert.match(text, /保持助手窗口打开/);
});
