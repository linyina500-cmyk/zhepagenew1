import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  createLocalDraftPackage, DEFERRED_ASSET_FILES, MAX_PACKAGE_BYTES,
  normalizeAssetOrigin, REQUIRED_PACKAGE_FILES, writeLocalDraftPackage,
} from "../build/package-local-draft.mjs";

const assetOrigin = "https://preview.example.pages.dev";

async function fixture(context) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "zhepage-package-test-"));
  context.after(() => rm(projectDir, { recursive: true, force: true }));
  const put = async (relativePath, contents = "fixture source\n") => {
    const target = path.join(projectDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  // Only scaffolding uses the required list. Assertions below independently
  // cover what may leave the source tree and what a Mac user can execute.
  for (const relativePath of REQUIRED_PACKAGE_FILES) await put(relativePath);
  for (const [index, relativePath] of DEFERRED_ASSET_FILES.entries()) await put(relativePath, Buffer.from(`font fixture ${index}`));
  return { projectDir, put };
}

test("package exposes only its launcher and instructions above the preserved program files", async (context) => {
  const { projectDir, put } = await fixture(context);
  const originalLauncher = "#!/bin/zsh\nnode companion/launch.mjs\n";
  const instructions = "双击启动折页.command，保留程序文件夹。\n";
  await put("启动折页.command", originalLauncher);
  await put("双击启动说明.txt", instructions);
  const result = await createLocalDraftPackage({ projectDir, assetOrigin });
  const zip = await JSZip.loadAsync(result.buffer);
  const roots = [...new Set(Object.keys(zip.files).map((name) => name.includes("/") ? `${name.split("/")[0]}/` : name))].sort();
  assert.deepEqual(roots, ["启动折页.command", "双击启动说明.txt", "程序文件/"].sort());
  for (const relativePath of REQUIRED_PACKAGE_FILES) assert.ok(zip.file(`程序文件/${relativePath}`), relativePath);
  assert.equal(await zip.file("启动折页.command").async("string"), '#!/bin/zsh\n\ncd -- "${0:A:h}/程序文件" || exit 1\nexec /bin/zsh ./启动折页.command\n');
  assert.equal(await zip.file("程序文件/启动折页.command").async("string"), originalLauncher);
  for (const name of ["双击启动说明.txt", "程序文件/双击启动说明.txt"]) assert.equal(await zip.file(name).async("string"), instructions);
  for (const name of ["启动折页.command", "程序文件/启动折页.command"]) assert.equal(zip.file(name).unixPermissions, 0o100755);
  assert.equal(zip.file("程序文件/package.json").unixPermissions, 0o100644);
  assert.deepEqual(result.files, Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort());
});

test("nested program files preserve licenses, defer fonts, and exclude local data and links", async (context) => {
  const { projectDir, put } = await fixture(context);
  await put("app/components/Example.tsx", "export const Example = 'package source';\n");
  await put("public/og.png", Buffer.from([137, 80, 78, 71]));
  await put("drizzle/meta/0000_snapshot.json", "{}");
  const privatePaths = [
    ".env", ".env.production", ".openai/hosting.json", ".git/config", ".wrangler/state/secret.json",
    "node_modules/private.js", "tests/private.test.mjs", "research/private.md", "docs/private.md", "history/private.md",
    "app/.env.production", "app/components/.private.tsx", "app/private/secret.ts", "build/.cache/private.mjs",
    "companion/accounts.json", "companion/profile-private/Cookies", "companion/profile-private/private.mjs",
    "public/private.png", "public/fonts/private.pem", "drizzle/meta/private.json",
    "companion/runtime-assets.json",
  ];
  for (const relativePath of privatePaths) await put(relativePath, "PRIVATE-FIXTURE-MUST-NOT-BE-PACKAGED");
  await symlink(path.join(projectDir, ".env"), path.join(projectDir, "lib/draftSync/linked.ts"));
  const result = await createLocalDraftPackage({ projectDir, assetOrigin });
  const zip = await JSZip.loadAsync(result.buffer);
  assert.ok(zip.file("程序文件/app/components/Example.tsx"));
  assert.ok(zip.file("程序文件/public/og.png"));
  assert.ok(zip.file("程序文件/drizzle/meta/0000_snapshot.json"));
  assert.ok(zip.file("程序文件/companion/THIRD_PARTY_NOTICES.md"));
  assert.ok(zip.file("程序文件/public/fonts/LICENSE.txt"));
  for (const relativePath of [...privatePaths.filter((name) => name !== "companion/runtime-assets.json"), ...DEFERRED_ASSET_FILES, "lib/draftSync/linked.ts"]) {
    assert.equal(zip.file(relativePath), null, relativePath);
    assert.equal(zip.file(`程序文件/${relativePath}`), null, relativePath);
  }
  const manifest = JSON.parse(await zip.file("程序文件/companion/runtime-assets.json").async("string"));
  assert.equal(manifest.assetOrigin, assetOrigin);
  assert.equal(manifest.files.length, 2);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(projectDir, entry.path));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  for (const entry of Object.values(zip.files)) assert.equal((await entry.async("string")).includes("PRIVATE-FIXTURE-MUST-NOT-BE-PACKAGED"), false, entry.name);
  assert.equal(await readFile(path.join(projectDir, "companion/runtime-assets.json"), "utf8"), "PRIVATE-FIXTURE-MUST-NOT-BE-PACKAGED");
  assert.ok(result.bytes <= MAX_PACKAGE_BYTES);
});

test("asset origins allow only credential-free HTTPS roots and explicit configuration wins", async (context) => {
  assert.equal(normalizeAssetOrigin("https://example.pages.dev/"), "https://example.pages.dev");
  for (const invalid of [undefined, null, "", "http://example.com", "https://user:password@example.com", "https://@example.com", "https://example.com/fonts", "https://example.com/fonts/..", "https://example.com/?token=secret", "https://example.com/#fragment", "https://example.com?", "https://example.com#"]) assert.throws(() => normalizeAssetOrigin(invalid));
  const { projectDir } = await fixture(context);
  const previous = process.env.CF_PAGES_URL;
  process.env.CF_PAGES_URL = "https://cloudflare-build.example.pages.dev";
  try {
    assert.equal((await createLocalDraftPackage({ projectDir })).assetManifest.assetOrigin, process.env.CF_PAGES_URL);
    assert.equal((await createLocalDraftPackage({ projectDir, assetOrigin })).assetManifest.assetOrigin, assetOrigin);
  } finally {
    if (previous === undefined) delete process.env.CF_PAGES_URL;
    else process.env.CF_PAGES_URL = previous;
  }
});

test("missing required files and linked font sources stop packaging before output", async (context) => {
  const { projectDir, put } = await fixture(context);
  await rm(path.join(projectDir, "启动折页.command"));
  await assert.rejects(createLocalDraftPackage({ projectDir, assetOrigin }), /启动折页\.command/);
  await put("启动折页.command", "#!/bin/zsh\n");
  await rm(path.join(projectDir, DEFERRED_ASSET_FILES[0]));
  await symlink(path.join(projectDir, DEFERRED_ASSET_FILES[1]), path.join(projectDir, DEFERRED_ASSET_FILES[0]));
  await assert.rejects(createLocalDraftPackage({ projectDir, assetOrigin }), /字体.*符号链接/);
});

test("an explicit output path receives the complete zip without changing source metadata", async (context) => {
  const { projectDir } = await fixture(context);
  const output = path.join(projectDir, "result", "helper.zip");
  const result = await writeLocalDraftPackage({ projectDir, assetOrigin, output });
  assert.equal(result.outputPath, output);
  assert.equal((await readFile(output)).equals(result.buffer), true);
  assert.deepEqual(await readdir(path.dirname(output)), ["helper.zip"]);
  await assert.rejects(readFile(path.join(projectDir, "companion/runtime-assets.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(projectDir, "dist-pages/downloads/zhepage-draft-helper.zip")), { code: "ENOENT" });
});

test("the hard 25 MiB limit rejects oversized output instead of replacing an existing package", async (context) => {
  const { projectDir, put } = await fixture(context);
  const output = path.join(projectDir, "existing.zip");
  await writeFile(output, "existing download");
  await put("public/og.png", randomBytes(MAX_PACKAGE_BYTES + 256 * 1024));
  await assert.rejects(writeLocalDraftPackage({ projectDir, assetOrigin, output }), /超过 25 MiB/);
  assert.equal(await readFile(output, "utf8"), "existing download");
});
