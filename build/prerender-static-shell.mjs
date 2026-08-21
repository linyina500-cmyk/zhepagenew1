import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  return null;
}

const serverEntry = await firstExisting([
  resolve("dist/server/index.js"),
  resolve("dist/server/index.mjs"),
  resolve("dist/index.js"),
]);
const wranglerPath = await firstExisting([
  resolve("dist/server/wrangler.json"),
  resolve("dist/wrangler.json"),
]);

if (!serverEntry || !wranglerPath) {
  console.warn("未发现可预渲染的 Worker 产物；保留当前 vinext 构建结果。Cloudflare 仍会缓存静态 JS、图片和样式。 ");
  process.exit(0);
}

const wrangler = JSON.parse(await readFile(wranglerPath, "utf8"));
const assetDirectory = resolve(wranglerPath, "..", wrangler.assets?.directory || "../client");
const clientIndex = resolve(assetDirectory, "index.html");

const workerModule = await import(`${pathToFileURL(serverEntry).href}?static-shell=${Date.now()}`);
const worker = workerModule.default;
const request = new Request("https://zhepage.local/", {
  headers: { Accept: "text/html,application/xhtml+xml" },
});
const assets = {
  fetch: async () => new Response("Not found", { status: 404 }),
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};
const response = await worker.fetch(request, { ASSETS: assets }, context);

if (!response.ok) {
  throw new Error(`静态首页生成失败：${response.status} ${await response.text()}`);
}

let html = await response.text();
html = html
  .replaceAll("https://zhepage.local/og-zhepage.png", "/og-zhepage.png")
  .replaceAll("https://zhepage.local", "");
await writeFile(clientIndex, html, "utf8");

wrangler.assets = {
  ...(wrangler.assets || {}),
  not_found_handling: "single-page-application",
  run_worker_first: ["/api/import", "/api/image"],
};
await writeFile(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`, "utf8");

console.log("静态首页已生成：仅 /api/import 与 /api/image 请求优先进入 Worker");
