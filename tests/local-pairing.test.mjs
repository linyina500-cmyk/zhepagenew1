import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createPairingServer, listenLocalServers, closeLocalServers, PAIRING_APP_ORIGIN } from "../server/wechat/pairing.mjs";

const connectionToken = "fixture-only-connection-token-".repeat(2);
const deviceId = "a".repeat(32);
const nonce = "b".repeat(64);
async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function fixture(t) {
  const server = createPairingServer({ deviceId, syncToken: connectionToken });
  t.after(() => closeLocalServers(server));
  const port = await listen(server), host = `127.0.0.1:${port}`, origin = `http://${host}`;
  return { server, port, host, origin, call(path, headers = {}, method = "GET", body) {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { Host: host, ...headers } }, (response) => {
        const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject); request.end(body);
    });
  } };
}
function pageRuntime(html, fetcher = async () => ({ ok: true, json: async () => ({ deviceId, connectionToken }) })) {
  const source = html.match(/<script>([\s\S]+)<\/script>/u)[1];
  const messages = [], status = { textContent: "" }, requests = [];
  const opener = { postMessage(data, origin) { messages.push({ data, origin }); } };
  let listener;
  const window = { opener, addEventListener(type, fn) { assert.equal(type, "message"); listener = fn; } };
  runInNewContext(source, { window, document: { getElementById: () => status }, fetch: async (...args) => { requests.push(args); return fetcher(...args); } });
  return { source, messages, status, requests, opener, dispatch: (event) => listener(event) };
}

test("pairing page has strict no-cache/frame/script headers and contains no credentials", async (t) => {
  const f = await fixture(t), page = await f.call("/connect");
  assert.equal(page.status, 200); assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["x-frame-options"], "DENY"); assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.body.includes(connectionToken), false); assert.equal(page.body.includes(deviceId), false);
  const runtime = pageRuntime(page.body);
  assert.ok(page.headers["content-security-policy"].includes(`script-src 'sha256-${createHash("sha256").update(runtime.source).digest("base64")}'`));
  assert.ok(page.headers["content-security-policy"].includes("frame-ancestors 'none'"));
  assert.equal(page.headers["access-control-allow-origin"], undefined);
  assert.equal(JSON.stringify(runtime.messages), JSON.stringify([{ data: { type: "zhepage-local-ready" }, origin: "*" }]));
  assert.equal(runtime.requests.length, 0);
});

test("only same-origin POST on the actual numeric loopback port returns credentials", async (t) => {
  const f = await fixture(t);
  const result = await f.call("/pair", { Origin: f.origin, "Sec-Fetch-Site": "same-origin" }, "POST");
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { deviceId, connectionToken });
  assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["access-control-allow-origin"], undefined);
  for (const origin of [undefined, "null", PAIRING_APP_ORIGIN, "https://malicious.example", `http://localhost:${f.port}`, `${f.origin}/`, "http://127.0.0.1:1"]) {
    const bad = await f.call("/pair", origin ? { Origin: origin } : {}, "POST");
    assert.equal(bad.status, 403); assert.equal(bad.body.includes(connectionToken), false);
  }
  assert.equal((await f.call("/pair", { Origin: f.origin, "Sec-Fetch-Site": "cross-site" }, "POST")).status, 403);
});

test("host aliases, malformed routes, bodies and CORS preflights never expose credentials", async (t) => {
  const f = await fixture(t);
  for (const host of [`localhost:${f.port}`, "127.0.0.1", "127.0.0.1:1", `malicious.example:${f.port}`, `[::1]:${f.port}`]) {
    assert.equal((await f.call("/connect", { Host: host })).status, 403);
    assert.equal((await f.call("/pair", { Host: host, Origin: f.origin }, "POST")).status, 403);
  }
  for (const [path, method] of [["/pair", "GET"], ["/pair", "OPTIONS"], ["/pair?token=ignored", "POST"], ["/connect?returnTo=https://malicious.example", "GET"], ["//pair", "POST"], ["/pair/", "POST"]]) {
    const result = await f.call(path, { Origin: f.origin }, method);
    assert.equal(result.status, 404); assert.equal(result.body.includes(connectionToken), false);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  assert.equal((await f.call("/pair", { Origin: f.origin, "Content-Length": "2" }, "POST", "{}")).status, 400);
});

test("page ignores foreign senders, origins and nonces, then replies only once to the verified opener", async (t) => {
  const f = await fixture(t), { body } = await f.call("/connect"), runtime = pageRuntime(body);
  const event = { source: runtime.opener, origin: PAIRING_APP_ORIGIN, data: { type: "zhepage-local-connect", nonce } };
  for (const invalid of [{ ...event, source: {} }, { ...event, origin: "https://malicious.example" }, { ...event, origin: `${PAIRING_APP_ORIGIN}.malicious.example` },
    { ...event, data: { type: "zhepage-local-ready", nonce } }, { ...event, data: null }, { ...event, data: { type: "zhepage-local-connect", nonce: "short" } },
    { ...event, data: { type: "zhepage-local-connect", nonce: "g".repeat(64) } }]) await runtime.dispatch(invalid);
  assert.equal(runtime.requests.length, 0);
  await runtime.dispatch(event); await runtime.dispatch(event);
  assert.equal(runtime.requests.length, 1); assert.equal(runtime.requests[0][0], "/pair");
  assert.equal(runtime.requests[0][1].method, "POST"); assert.equal(runtime.messages.length, 2);
  assert.equal(JSON.stringify(runtime.messages[1]), JSON.stringify({ data: { type: "zhepage-local-connected", nonce, deviceId, connectionToken }, origin: PAIRING_APP_ORIGIN }));
});

test("concurrent messages and failed pairing cannot retry or leak a partial response", async (t) => {
  const f = await fixture(t), { body } = await f.call("/connect");
  let finish;
  const runtime = pageRuntime(body, () => new Promise((resolve) => { finish = resolve; }));
  const event = { source: runtime.opener, origin: PAIRING_APP_ORIGIN, data: { type: "zhepage-local-connect", nonce } };
  const first = runtime.dispatch(event); await runtime.dispatch(event);
  assert.equal(runtime.requests.length, 1); finish({ ok: false }); await first; await runtime.dispatch(event);
  assert.equal(runtime.messages.length, 1); assert.equal(runtime.requests.length, 1);
  assert.match(runtime.status.textContent, /未完成/u);
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
