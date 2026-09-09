import { access } from "node:fs/promises";
import { constants } from "node:fs";

async function executableExists(filename) {
  try { await access(filename, constants.X_OK); return true; }
  catch { return false; }
}

export async function localBrowserLaunchOptions() {
  // A new persistent context still uses only our own account profile. The
  // installed Chrome binary does not grant access to the user's usual session.
  if (process.platform === "darwin" && await executableExists("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) return { channel: "chrome" };
  const { chromium } = await import("@playwright/test");
  return await executableExists(chromium.executablePath()) ? {} : null;
}
