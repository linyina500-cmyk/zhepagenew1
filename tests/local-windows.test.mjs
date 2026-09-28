import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsControl, startWindowsAssistant, stopWindowsAssistant, windowsControlRequest } from "../server/wechat/local-windows.mjs";

const token = "synthetic-device-token-0123456789-0123456789";
const never = async () => assert.fail("Unexpected operation");

async function fixture(t, status, stop) {
  const root = await mkdtemp(join(tmpdir(), "zhepage-pipe-"));
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\zhepage-test-${randomUUID()}` : join(root, "control.sock");
  const server = await createWindowsControl({ pipePath, token, status, stop });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { pipePath, close: () => server.close(), request: (action, secret = token) => windowsControlRequest({ pipePath, token: secret, action }) };
}

test("Windows first start launches once while repeat starts only check the same ready assistant", async () => {
  const calls = [];
  await startWindowsAssistant({ inspect: async () => null, launch: async () => calls.push("launch"), ready: never, pause: never });
  let checks = 0;
  await startWindowsAssistant({ inspect: async () => ({ ok: true, pid: 42, ready: ++checks > 1 }), launch: never,
    ready: async (pid) => { assert.equal(pid, 42); calls.push("verified"); return true; }, pause: async () => calls.push("wait") });
  assert.deepEqual(calls, ["launch", "wait", "verified"]);
  await assert.rejects(startWindowsAssistant({ inspect: async () => ({ ok: true, pid: 42, ready: false }), launch: never, ready: never, pause: async () => {}, attempts: 2 }), /准备中/u);
});

test("native control pipe requires authentication before exposing readiness or stopping", async (t) => {
  let checks = 0, stops = 0;
  const f = await fixture(t, async () => { checks++; return { ready: true, busy: false, internalSecret: token }; }, () => { stops++; });
  assert.deepEqual(await f.request("status", "wrong-token"), { ok: false });
  assert.deepEqual(await f.request("stop", "wrong-token"), { ok: false });
  assert.equal(checks, 0); assert.equal(stops, 0);
  for (const input of ["null", "[]", "true", "42", "{broken"]) {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(f.pipePath); let output = "";
      socket.on("connect", () => socket.write(input + "\n"));
      socket.on("data", (chunk) => { output += chunk; });
      socket.on("end", () => resolve(JSON.parse(output))); socket.on("error", reject);
    });
    assert.deepEqual(response, { ok: false });
  }
  assert.equal(checks, 0); assert.equal(stops, 0);
  assert.deepEqual(await f.request("status"), { ok: true, pid: process.pid, ready: true });
  assert.equal(checks, 1);
  assert.deepEqual(await f.request("stop"), { ok: true });
  assert.equal(stops, 1);
  await assert.rejects(createWindowsControl({ pipePath: f.pipePath, token, status: never, stop: never }), { code: "EADDRINUSE" });
});

test("busy or unconfirmed Windows work is refused by the owner before any stop request runs", async (t) => {
  for (const state of [{ ready: true, busy: true }, null, { ready: false }]) {
    const f = await fixture(t, async () => state, never);
    const response = await f.request("stop");
    assert.deepEqual(response, { ok: false, reason: state?.busy ? "busy" : "unknown" });
    await assert.rejects(stopWindowsAssistant({ inspect: () => f.request("status"), requestStop: () => f.request("stop"), pause: never }), /正在同步|无法确认/u);
  }
});

test("Windows stop waits for the owner to finish draining and never escalates to process kills", async () => {
  let inspections = 0, stops = 0;
  assert.equal(await stopWindowsAssistant({ inspect: async () => ++inspections < 4 ? { ok: true, pid: 42, ready: true } : null,
    requestStop: async () => { stops++; return { ok: true }; }, pause: async () => {} }), true);
  assert.equal(stops, 1);
  stops = 0;
  assert.equal(await stopWindowsAssistant({ inspect: async () => ({ ok: true, pid: 42, ready: false }), requestStop: async () => { stops++; return { ok: true }; }, pause: async () => {}, attempts: 2 }), false);
  assert.equal(stops, 1);
  assert.equal(await stopWindowsAssistant({ inspect: async () => null, requestStop: never, pause: never }), true);
});

test("native stop acknowledges acceptance before the controller waits for explicit drain completion", { timeout: 5000 }, async (t) => {
  const accepted = Promise.withResolvers(), drain = Promise.withResolvers(), drained = Promise.withResolvers(), waiting = Promise.withResolvers();
  let completed = false, stops = 0;
  const f = await fixture(t, async () => ({ ready: stops === 0, busy: false }), () => {
    stops++; accepted.resolve();
    void drain.promise.then(async () => { await f.close(); drained.resolve(); }).catch(drained.reject);
  });
  const operation = stopWindowsAssistant({ inspect: () => f.request("status"), requestStop: () => f.request("stop"),
    pause: async () => { waiting.resolve(); await drained.promise; },
  }).then((result) => { completed = true; return result; });
  await accepted.promise;
  await waiting.promise;
  assert.equal(stops, 1);
  assert.equal(completed, false, "an accepted stop is not yet a completed stop");
  drain.resolve();
  assert.equal(await operation, true);
  assert.equal(completed, true);
});

test("an authenticated idle stop is not lost when its requesting client closes early", { timeout: 5000 }, async (t) => {
  const checked = Promise.withResolvers(), release = Promise.withResolvers(), accepted = Promise.withResolvers();
  const f = await fixture(t, async () => { checked.resolve(); await release.promise; return { ready: true, busy: false }; }, () => accepted.resolve());
  const socket = createConnection(f.pipePath);
  socket.on("error", () => {});
  socket.on("connect", () => socket.write(`${JSON.stringify({ token, action: "stop" })}\n`));
  await checked.promise;
  const disconnected = new Promise((resolve) => socket.once("close", resolve));
  socket.destroy(); await disconnected;
  release.resolve();
  await accepted.promise;
});
