import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createPairingServer, listenLocalServers, closeLocalServers, PAIRING_APP_ORIGIN } from "../server/wechat/pairing.mjs";
import { createWechatServer } from "../server/wechat/http.mjs";
const connectionToken = "fixture-only-connection-token-".repeat(2);
const deviceId = "a".repeat(32), nonce = "b".repeat(64);
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function fixture(t, server = createPairingServer({ deviceId, syncToken: connectionToken })) {
  t.after(() => closeLocalServers(server));
  const port = await listen(server), host = `127.0.0.1:${port}`;
  return { server, port, host, call(path, headers = {}, method = "GET", body) {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { Host: host, ...headers } }, (response) => {
        const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject); request.end(body);
    });
  } };
}
const pairHeaders = { Origin: PAIRING_APP_ORIGIN, "Content-Type": "application/json" };
test("trusted app pairs through an exact-origin JSON POST without credentials in URLs or HTML", async (t) => {
  const f = await fixture(t), health = await f.call("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { service: "zhepage-local-pairing", ready: true });
  assert.equal(health.body.includes(connectionToken), false);
  const result = await f.call("/pair", pairHeaders, "POST", JSON.stringify({ nonce }));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { nonce, deviceId, connectionToken });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["access-control-allow-origin"], PAIRING_APP_ORIGIN);
  assert.equal(result.headers["access-control-allow-credentials"], undefined);
  assert.equal((await f.call("/connect")).status, 404);
});
test("pairing rejects missing, opaque and foreign origins plus DNS rebinding Hosts", async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, "null", "https://malicious.example", `${PAIRING_APP_ORIGIN}.evil.test`, `${PAIRING_APP_ORIGIN}/`, `http://${f.host}`]) {
    const result = await f.call("/pair", { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, "POST", JSON.stringify({ nonce }));
    assert.equal(result.status, 403); assert.equal(result.body.includes(connectionToken), false);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  for (const host of [`localhost:${f.port}`, "127.0.0.1", "127.0.0.1:1", `malicious.example:${f.port}`, `[::1]:${f.port}`]) {
    const result = await f.call("/pair", { ...pairHeaders, Host: host }, "POST", JSON.stringify({ nonce }));
    assert.equal(result.status, 403); assert.equal(result.body.includes(connectionToken), false);
  }
});
test("pairing preflight permits only JSON POST from the trusted app and never returns credentials", async (t) => {
  const f = await fixture(t);
  const headers = { Origin: PAIRING_APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" };
  const good = await f.call("/pair", headers, "OPTIONS");
  assert.equal(good.status, 204); assert.equal(good.body, "");
  assert.equal(good.headers["access-control-allow-origin"], PAIRING_APP_ORIGIN);
  for (const overrides of [{ Origin: "null" }, { "Access-Control-Request-Method": "GET" }, { "Access-Control-Request-Headers": "x-arbitrary" }]) {
    assert.equal((await f.call("/pair", { ...headers, ...overrides }, "OPTIONS")).status, 403);
  }
});
test("malformed challenges, simple form posts and extra routes never pair", async (t) => {
  const f = await fixture(t);
  for (const body of ["{invalid", "null", "[]", "{}", JSON.stringify({ nonce: "short" }), JSON.stringify({ nonce, extra: true }), JSON.stringify({ nonce: "x".repeat(300) })]) {
    const result = await f.call("/pair", pairHeaders, "POST", body);
    assert.ok([400, 413].includes(result.status)); assert.equal(result.body.includes(connectionToken), false);
  }
  assert.equal((await f.call("/pair", { ...pairHeaders, "Content-Type": "text/plain" }, "POST", JSON.stringify({ nonce }))).status, 400);
  for (const path of ["/pair?token=ignored", "//pair", "/pair/"]) assert.equal((await f.call(path, pairHeaders, "POST", JSON.stringify({ nonce }))).status, 404);
});
test("sync API enforces Host, origin, preflight and Bearer before dispatching platform work", async (t) => {
  const accounts = { deviceId, busy: () => false };
  const f = await fixture(t, createWechatServer({ accounts, syncToken: connectionToken }));
  const path = "/api/wechat/connection";
  const headers = { Origin: PAIRING_APP_ORIGIN, Authorization: `Bearer ${connectionToken}` };
  const ok = await f.call(path, headers);
  assert.equal(ok.status, 200); assert.equal(ok.headers["access-control-allow-origin"], PAIRING_APP_ORIGIN);
  assert.equal((await f.call(path, { Authorization: headers.Authorization })).status, 200, "local CLI diagnostics require authentication");
  assert.equal((await f.call(path, { Origin: PAIRING_APP_ORIGIN })).status, 401);
  for (const overrides of [{ Origin: "https://malicious.example" }, { Origin: "null" }, { Host: `malicious.example:${f.port}` }]) assert.equal((await f.call(path, { ...headers, ...overrides })).status, 403);
  const preflight = await f.call(path, { Origin: PAIRING_APP_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" }, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal((await f.call(path, { Origin: PAIRING_APP_ORIGIN, "Access-Control-Request-Method": "DELETE" }, "OPTIONS")).status, 403);
});

test("both loopback listeners become available together and close cleanly", async (t) => {
  const server = createServer(), pairingServer = createPairingServer({ deviceId, syncToken: connectionToken });
  t.after(() => closeLocalServers(server, pairingServer));
  await listenLocalServers({ server, pairingServer, port: 0, pairingPort: 0 });
  assert.equal(server.listening, true); assert.equal(pairingServer.listening, true);
  assert.equal(pairingServer.address().address, "127.0.0.1");
  await closeLocalServers(server, pairingServer);
  assert.equal(server.listening, false); assert.equal(pairingServer.listening, false);
});

test("failure of either listener closes the successful listener before rejecting startup", async (t) => {
  const occupied = createServer(); const occupiedPort = await listen(occupied); t.after(() => closeLocalServers(occupied));
  for (const failedSide of ["sync", "pairing"]) {
    const server = createServer(), pairingServer = createPairingServer({ deviceId, syncToken: connectionToken });
    await assert.rejects(listenLocalServers({ server, pairingServer,
      port: failedSide === "sync" ? occupiedPort : 0, pairingPort: failedSide === "pairing" ? occupiedPort : 0 }), (error) => error.code === "EADDRINUSE");
    assert.equal(server.listening, false); assert.equal(pairingServer.listening, false);
  }
});
