import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createLauncherChannel, dependenciesReady, LOCAL_ORIGIN, prepareBrowser, prepareFonts, redactSetupLog, startLocalSession, supportsNodeVersion } from "../companion/launch.mjs";

async function directory(context) {
  const location = await mkdtemp("/tmp/zhepage-launch-");
  context.after(() => rm(location, { recursive: true, force: true }));
  return location;
}

test("double-click runtime accepts only supported Node versions", () => {
  for (const version of ["22.18.0", "22.19.1", "24.0.0", "25.2.0"]) assert.equal(supportsNodeVersion(version), true);
  for (const version of ["18.20.0", "22.17.1", "23.11.0", "invalid", "24"]) assert.equal(supportsNodeVersion(version), false);
});

test("dependency checks detect missing or changed locked packages without invoking an installer", async (context) => {
  const root = await directory(context);
  const manifest = { dependencies: { example: "1.2.0" }, devDependencies: { "@scope/development": "2.1.0" } };
  const lock = { packages: { "node_modules/example": { version: "1.2.0" }, "node_modules/@scope/development": { version: "2.1.0" } } };
  assert.equal(await dependenciesReady(root, manifest, lock), false);
  for (const [relative, value] of Object.entries(lock.packages)) {
    await mkdir(path.join(root, relative), { recursive: true });
    await writeFile(path.join(root, relative, "package.json"), JSON.stringify(value));
  }
  assert.equal(await dependenciesReady(root, manifest, lock), true);
  await writeFile(path.join(root, "node_modules/example/package.json"), '{"version":"9.0.0"}');
  assert.equal(await dependenciesReady(root, manifest, lock), false);
});

test("installed Chrome or Chromium skips downloads and a missing browser installs only once", async () => {
  let installs = 0;
  const install = async () => { installs++; };
  await prepareBrowser(async () => ({ channel: "chrome" }), install, () => {});
  await prepareBrowser(async () => ({}), install, () => {});
  assert.equal(installs, 0);
  let checks = 0;
  await prepareBrowser(async () => ++checks === 1 ? null : {}, install, () => {});
  assert.equal(installs, 1);
  await assert.rejects(prepareBrowser(async () => null, install, () => {}), /未能准备完成/);
  assert.equal(installs, 2);
});

test("font preparation checks original bytes, reuses verified assets and rejects corrupt downloads", async (context) => {
  const root = await directory(context);
  const bytes = Buffer.from("test-only-font-bytes");
  const asset = { path: "public/fonts/test-font.woff2", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifest = { assetOrigin: "https://example.test", files: [asset] };
  await mkdir(path.join(root, "companion"));
  await writeFile(path.join(root, "companion/runtime-assets.json"), JSON.stringify(manifest));
  let downloads = 0;
  const fetchAsset = async (url, options) => {
    downloads++;
    assert.equal(String(url), "https://example.test/fonts/test-font.woff2");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    return new Response(bytes);
  };
  await prepareFonts(root, fetchAsset, () => {});
  assert.deepEqual(await readFile(path.join(root, asset.path)), bytes);
  await prepareFonts(root, fetchAsset, () => {});
  assert.equal(downloads, 1);
  await writeFile(path.join(root, asset.path), "unchanged partial file");
  await assert.rejects(prepareFonts(root, async () => new Response(Buffer.alloc(bytes.length)), () => {}), /字体校验未通过/);
  assert.equal(await readFile(path.join(root, asset.path), "utf8"), "unchanged partial file");
  await assert.rejects(prepareFonts(root, async () => { throw new Error("fetch failed"); }, () => {}), /字体下载未完成，请检查网络/);
  manifest.files[0].path = "../private.woff2";
  await writeFile(path.join(root, "companion/runtime-assets.json"), JSON.stringify(manifest));
  await assert.rejects(prepareFonts(root, fetchAsset, () => {}), /清单无效/);
  assert.equal(downloads, 1);
});

test("only the owned loopback page receives the in-memory fragment and closes with its helper", async () => {
  const events = [];
  let pageAddress = { address: "127.0.0.1", port: 5173 };
  const token = "test-pairing-value-never-a-real-secret";
  const session = await startLocalSession({
    projectRoot: "/test project", dataDir: "/test account directory",
    createHelper: async (options) => {
      assert.deepEqual(options.allowedOrigins, [LOCAL_ORIGIN]);
      return { token, listen: async () => { events.push("helper ready"); return 47831; }, close: async () => { events.push("helper closed"); } };
    },
    createPageServer: async (options) => {
      assert.deepEqual(options.server, { host: "127.0.0.1", port: 5173, strictPort: true, open: false });
      return { listen: async () => { events.push("page ready"); }, httpServer: { address: () => pageAddress }, close: async () => { events.push("page closed"); } };
    },
    openPage: async (address) => {
      assert.deepEqual(events.slice(0, 2), ["helper ready", "page ready"]);
      const url = new URL(address);
      assert.equal(url.origin, LOCAL_ORIGIN);
      assert.equal(url.search, "");
      assert.equal(url.hash, `#zhepage-pairing=${token}`);
      events.push("opened");
    },
  });
  assert.equal(events.includes("opened"), false);
  await session.open();
  await session.open();
  assert.equal(events.filter((value) => value === "opened").length, 2);
  pageAddress = null;
  assert.throws(() => session.open(), /预期地址/);
  assert.equal(events.filter((value) => value === "opened").length, 2);
  await session.close();
  assert.ok(events.includes("helper closed") && events.includes("page closed"));
});

test("an occupied or unexpected page address never receives a pairing token", async () => {
  for (const address of [null, { address: "127.0.0.1", port: 5174 }, { address: "0.0.0.0", port: 5173 }]) {
    let opened = 0;
    let closed = 0;
    await assert.rejects(startLocalSession({
      projectRoot: "/test project", dataDir: "/test account directory",
      createHelper: async () => ({ token: "unused secret", listen: async () => 47831, close: async () => { closed++; } }),
      createPageServer: async () => ({
        listen: async () => { if (address === null) throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" }); },
        httpServer: { address: () => address }, close: async () => { closed++; },
      }),
      openPage: async () => { opened++; },
    }), /端口已被占用|预期地址/);
    assert.equal(opened, 0);
    assert.equal(closed, 2);
  }
});

test("a protected local socket reuses the launcher without returning or persisting pairing credentials", async (context) => {
  const root = await directory(context);
  let ready = false;
  let reopened = 0;
  const owner = await createLauncherChannel(root, async () => { if (!ready) return "starting"; reopened++; return "opened"; });
  context.after(() => owner.close());
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, "launcher.sock"))).mode & 0o777, 0o600);
  assert.equal((await createLauncherChannel(root, async () => { throw new Error("must not own existing launcher"); })).reused, "starting");
  ready = true;
  assert.equal((await createLauncherChannel(root, async () => { throw new Error("must not own existing launcher"); })).reused, "opened");
  assert.equal(reopened, 1);
  await owner.close();
  await assert.rejects(stat(path.join(root, "launcher.sock")), { code: "ENOENT" });
});

test("setup diagnostics redact pairing links and recognizable credential fields", () => {
  const source = 'https://name:private-value@example.test/ #zhepage-pairing=pairing-value Bearer bearer-value token=token-value {"appSecret":"appsecret-value"} access_token=access-value';
  const result = redactSetupLog(source);
  for (const value of ["private-value", "pairing-value", "bearer-value", "token-value", "appsecret-value", "access-value"]) assert.equal(result.includes(value), false);
  assert.equal(redactSetupLog("npm failed: ECONNRESET"), "npm failed: ECONNRESET");
});
