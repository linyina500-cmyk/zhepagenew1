import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { CLOUD_ORIGIN, credentialState } from "../helpers/cloud-sync";

type CredentialStore = typeof import("../../lib/draftSync/credentialStore");
declare global { interface Window { __testCredentialStore: CredentialStore } }
const account = { id: "synthetic-shared-account", platform: "wechat", displayName: "跨页测试公众号", remoteId: "wx5555555555555555", ready: true } as const;

test.use({ baseURL: CLOUD_ORIGIN, ignoreHTTPSErrors: true });

async function loadRealStore(page: Page) {
  // Compile the actual product module. Each page gets an independent module
  // scope and memory map, while both use the same browser IndexedDB origin.
  const source = await readFile(path.resolve("lib/draftSync/credentialStore.ts"), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: "credentialStore.ts", reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  expect(diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
  await page.goto("/");
  await page.addScriptTag({ content: `(function () { const exports = {}; ${outputText}\nwindow.__testCredentialStore = exports; })();` });
}

test("the latest remember preference and stored credential win across separate page modules", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([loadRealStore(page), loadRealStore(other)]);
  await page.evaluate(async (value) => {
    await window.__testCredentialStore.setRememberAccounts(true);
    await window.__testCredentialStore.saveCredential(value, "opaque-test-envelope-initial");
  }, account);
  expect((await credentialState(page)).credentials[0].envelope).toBe("opaque-test-envelope-initial");
  await other.evaluate(() => window.__testCredentialStore.setRememberAccounts(false));
  // A still has its old remember=true module state when this result arrives.
  await page.evaluate((value) => window.__testCredentialStore.saveCredential(value, "opaque-test-envelope-memory-only"), account);
  expect((await credentialState(page)).credentials).toEqual([]);
  expect((await credentialState(other)).settings).toEqual([false]);
  expect(await page.evaluate((id) => window.__testCredentialStore.getCredential(id), account.id)).toMatchObject({ envelope: "opaque-test-envelope-memory-only" });

  // A now caches false; enabling persistence in B must govern A's next write.
  expect(await page.evaluate(() => window.__testCredentialStore.getRememberAccounts())).toBe(false);
  await other.evaluate(() => window.__testCredentialStore.setRememberAccounts(true));
  await other.evaluate((value) => window.__testCredentialStore.saveCredential(value, "opaque-test-envelope-newer-database-copy"), account);
  expect(await page.evaluate((id) => window.__testCredentialStore.getCredential(id), account.id)).toMatchObject({ envelope: "opaque-test-envelope-newer-database-copy" });
  await page.evaluate((value) => window.__testCredentialStore.saveCredential(value, "opaque-test-envelope-after-enabled-elsewhere"), account);
  expect((await credentialState(other)).credentials[0].envelope).toBe("opaque-test-envelope-after-enabled-elsewhere");

  // A preference write from a tab holding an old memory copy must also retain
  // the newer database copy, instead of restoring the older authorization.
  await page.evaluate(() => window.__testCredentialStore.setRememberAccounts(false));
  await other.evaluate(() => window.__testCredentialStore.setRememberAccounts(true));
  await other.evaluate((value) => window.__testCredentialStore.saveCredential(value, "opaque-test-envelope-latest"), account);
  await page.evaluate(() => window.__testCredentialStore.setRememberAccounts(true));
  expect((await credentialState(page)).credentials[0].envelope).toBe("opaque-test-envelope-latest");
  await other.close();
});

test("two pages cannot both lock one account or clear another request's pending lock", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([loadRealStore(page), loadRealStore(other)]);
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const outcomes = await Promise.all([
    page.evaluate(async ({ account, requestId }) => {
      try { await window.__testCredentialStore.lockSync(account, requestId); return true; } catch { return false; }
    }, { account, requestId: firstId }),
    other.evaluate(async ({ account, requestId }) => {
      try { await window.__testCredentialStore.lockSync(account, requestId); return true; } catch { return false; }
    }, { account, requestId: secondId }),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const winner = outcomes[0] ? firstId : secondId;
  const loser = outcomes[0] ? secondId : firstId;
  expect(await page.evaluate((value) => window.__testCredentialStore.getPendingRequestId(value), account)).toBe(winner);
  expect(await other.evaluate((value) => window.__testCredentialStore.getPendingRequestId(value), account)).toBe(winner);
  expect((await credentialState(page)).pending).toHaveLength(1);
  const wrongUnlock = await other.evaluate(async ({ account, requestId }) => {
    try { await window.__testCredentialStore.unlockSync(account, requestId); return true; } catch { return false; }
  }, { account, requestId: loser });
  expect(wrongUnlock).toBe(false);
  expect(await page.evaluate((value) => window.__testCredentialStore.withPendingAccounts([value]), account)).toMatchObject([{ id: account.id, syncBlocked: true }]);
  await page.evaluate(({ account, requestId }) => window.__testCredentialStore.unlockSync(account, requestId), { account, requestId: winner });
  await other.evaluate(({ account, requestId }) => window.__testCredentialStore.lockSync(account, requestId), { account, requestId: loser });
  expect(await page.evaluate((value) => window.__testCredentialStore.getPendingRequestId(value), account)).toBe(loser);
  await other.close();
});
