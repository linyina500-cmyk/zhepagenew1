import { expect, test, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const APP_ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const PRODUCT_URL = `${APP_ORIGIN}/__extension-connection-test`;
const product = buildSync({
  entryPoints: [fileURLToPath(new URL("../../lib/localSync/connection.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "iife", globalName: "ProductConnection", target: "es2022",
}).outputFiles[0].text;

// Exercise the shipped connection code, without an installed extension, live
// account, helper server, browser-security override, or external page request.
async function fixture(page: Page, extensionPresent = false) {
  const unexpected: string[] = [];
  await page.route(`${APP_ORIGIN}/**`, async (route) => {
    if (route.request().url() !== PRODUCT_URL) { unexpected.push(route.request().url()); await route.abort(); return; }
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Extension connection fixture</title><link rel="icon" href="data:,">
      <button id="connect" type="button">检测插件</button><p id="status" role="status">尚未连接</p>
      <script>
        window.extensionMessages = 0;
        if (!window.chrome) Object.defineProperty(window, "chrome", { value: {}, configurable: true });
        Object.defineProperty(window.chrome, "runtime", { configurable: true, value: ${extensionPresent ? `{
          sendMessage(_id, _message, callback) {
            window.extensionMessages++;
            this.lastError = { message: "No receiving extension" };
            callback(undefined);
            delete this.lastError;
          }
        }` : "undefined"} });
        ${product}
        document.getElementById("connect").addEventListener("click", async () => {
          const button = document.getElementById("connect"), controller = new AbortController();
          button.disabled = true;
          const attempt = ProductConnection.beginLocalSyncConnection();
          try {
            await attempt.connect(controller.signal);
            document.getElementById("status").textContent = "插件已连接";
          } catch (error) {
            document.getElementById("status").textContent = error.message;
          } finally { attempt.close(); button.disabled = false; }
        });
      </script></html>` });
  });
  page.on("request", (request) => { if (request.url() !== PRODUCT_URL) unexpected.push(request.url()); });
  await page.goto(PRODUCT_URL);
  return { unexpected };
}

test("Chrome without the extension offers installation guidance without local requests or a popup", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "The missing-extension state is specific to Chrome.");
  const f = await fixture(page);
  await page.getByRole("button", { name: "检测插件" }).click();
  await expect(page.getByRole("status")).toContainText("尚未检测到折页插件", { timeout: 2_000 });
  await expect(page.getByRole("status")).toContainText("加载并启用插件");
  await expect(page.getByRole("button", { name: "检测插件" })).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).toBe(PRODUCT_URL);
  expect(f.unexpected).toEqual([]);
});

test("a disabled extension returns the same recoverable guidance without saving a connection", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Chrome exposes runtime errors through the message callback.");
  const f = await fixture(page, true);
  await page.getByRole("button", { name: "检测插件" }).click();
  await expect(page.getByRole("status")).toContainText("尚未检测到折页插件", { timeout: 2_000 });
  expect(await page.evaluate(() => (window as typeof window & { extensionMessages: number }).extensionMessages)).toBe(1);
  await expect(page.getByRole("button", { name: "检测插件" })).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
});

test("Firefox and Safari explain Chrome is required before attempting extension messaging", async ({ page, context, browserName }) => {
  test.skip(browserName === "chromium", "Uses the actual Firefox and Safari user agent.");
  const f = await fixture(page, true);
  await page.getByRole("button", { name: "检测插件" }).click();
  await expect(page.getByRole("status")).toContainText("请在 Windows 或 Mac 电脑的 Chrome 浏览器中加载折页插件", { timeout: 2_000 });
  expect(await page.evaluate(() => (window as typeof window & { extensionMessages: number }).extensionMessages)).toBe(0);
  await expect(page.getByRole("button", { name: "检测插件" })).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).toBe(PRODUCT_URL);
  expect(f.unexpected).toEqual([]);
});
