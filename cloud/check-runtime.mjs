import assert from "node:assert/strict";
import { createCloudBrowser } from "./browser.mjs";

// Isolated CI smoke check: synthetic content and cookie, no platform requests.
let runtime;
let restored;
try {
  runtime = await createCloudBrowser();
  await runtime.context.route("https://creator.xiaohongshu.com/__zhepage_test__", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Runtime check</title><p>Temporary session</p>",
  }));
  await runtime.context.addCookies([{ name: "runtime_check", value: "synthetic", domain: "creator.xiaohongshu.com", path: "/", secure: true, httpOnly: true, sameSite: "Strict" }]);
  const page = await runtime.context.newPage();
  await page.goto("https://creator.xiaohongshu.com/__zhepage_test__");
  assert.match(await runtime.screenshot(), /^data:image\/jpeg;base64,/);
  const state = await runtime.snapshot();
  await runtime.close();
  restored = await createCloudBrowser({ storageState: state });
  const cookies = await restored.context.cookies("https://creator.xiaohongshu.com");
  assert.equal(cookies.find((cookie) => cookie.name === "runtime_check")?.value, "synthetic");
  console.log("Temporary browser starts, captures, restores and closes with the deployment sandbox enabled.");
} finally {
  await Promise.all([runtime?.close(), restored?.close()]);
}
