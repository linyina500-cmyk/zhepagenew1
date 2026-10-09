import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Rendered HTML checks run after the build in `npm test`. Keep them out of
// this discovery pass so a fresh checkout does not require an existing dist.
const files = (await readdir("tests"))
  .filter((file) => file.endsWith(".test.mjs") && file !== "rendered-html.test.mjs")
  .sort().map((file) => `tests/${file}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
