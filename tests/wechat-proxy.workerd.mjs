// Run separately: node --test tests/wechat-proxy.workerd.mjs
// Miniflare starts a local workerd listener, so this is intentionally outside
// the default unit discovery. Every outgoing request is an in-memory fixture.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

// Use the exact runtime dependency installed for the locked Wrangler version;
// do not rely on npm hoisting Miniflare to this project's top-level modules.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("workerd relays upstream JSON errors and refuses redirect credential forwarding", async () => {
  const source = await readFile(new URL("../functions/api/wechat/[[path]].ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const token = "a".repeat(64);
  const calls = [];
  let status = 401;
  const upstream = "https://upstream.example/api/wechat/account";
  const location = "https://must-not-receive-credentials.example/destination";
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: "2026-05-22",
    script: `${outputText}\nexport default { fetch(request, env) { return onRequest({ request, env }); } };`,
    bindings: { WECHAT_SYNC_URL: "https://upstream.example" },
    outboundService: async (request) => {
      calls.push({ url: request.url, authorization: request.headers.get("Authorization") });
      // Intercept all outbound requests, including a mistakenly followed URL.
      if (request.url !== upstream) return Response.json({ error: "unexpected destination" }, { status: 400 });
      if (status >= 300 && status < 400) return new Response("fixture redirect body", { status, headers: { Location: location } });
      return Response.json({ error: status === 401 ? "fixture-unauthorized" : "fixture-whitelist-error-40164" }, { status });
    },
  });
  try {
    for (const expectedStatus of [401, 502, 302]) {
      status = expectedStatus;
      const response = await mf.dispatchFetch("https://preview.example/api/wechat/account", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, expectedStatus === 302 ? 502 : expectedStatus);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Location"), null);
      const body = await response.json();
      if (expectedStatus === 302) {
        assert.match(body.error, /重定向/);
        assert.doesNotMatch(JSON.stringify(body), /must-not-receive|fixture redirect body/);
      } else {
        assert.equal(body.error, expectedStatus === 401 ? "fixture-unauthorized" : "fixture-whitelist-error-40164");
      }
    }
    assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ url: upstream, authorization: `Bearer ${token}` })));
    assert.ok(!calls.some((call) => call.url === location));
  } finally {
    await mf.dispose();
  }
});
