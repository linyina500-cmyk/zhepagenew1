import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const vault = loadDomModule("lib/wechat/deviceVault.ts");
const first = { appId: "wx-test-account-one", appSecret: "private-secret-one", name: "测试公众号一" };
const second = { appId: "wx-test-account-two", appSecret: "private-secret-two", name: "测试公众号二" };
const binding = { deviceId: "local-device-one", connectionToken: "private-local-connection-token" };
const idFor = (appId) => createHash("sha256").update(appId).digest("hex").slice(0, 20);

// A deliberately small transactional IDB model: request callbacks run before
// commit, puts are structured-cloned, and failed transactions discard all writes.
function memoryDatabase() {
  const records = new Map();
  let created = false;
  let tail = Promise.resolve();
  const state = { records, failWrite: false, databases: [], beforeWrite: null };
  state.open = (name, version) => {
    assert.equal(name, "zhepage-wechat-device-vault");
    assert.equal(version, 1);
    const request = {};
    const database = {
      close() {},
      createObjectStore(store, options) { assert.equal(store, "records"); assert.deepEqual(options, { keyPath: "key" }); },
      transaction(storeName, mode) {
        assert.equal(storeName, "records");
        let working;
        let aborted = false;
        const tx = { abort() { aborted = true; }, objectStore() { return store; } };
        const store = {
          getAll() {
            const reading = {};
            const run = tail.then(() => new Promise((resolve) => {
              if (mode === "readwrite" && state.beforeWrite) { const hook = state.beforeWrite; state.beforeWrite = null; hook(); }
              working = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
              queueMicrotask(() => {
                reading.result = [...working.values()];
                reading.onsuccess?.();
                queueMicrotask(() => {
                  if (aborted) tx.onabort?.();
                  else {
                    if (mode === "readwrite") { records.clear(); for (const entry of working) records.set(...entry); }
                    tx.oncomplete?.();
                  }
                  resolve();
                });
              });
            }));
            tail = run;
            return reading;
          },
          put(value) {
            assert.equal(mode, "readwrite");
            if (state.failWrite) { state.failWrite = false; aborted = true; return {}; }
            working.set(value.key, structuredClone(value));
            return {};
          },
          delete(key) { assert.equal(mode, "readwrite"); working.delete(key); return {}; },
          clear() { assert.equal(mode, "readwrite"); if (state.failWrite) { state.failWrite = false; aborted = true; } else working.clear(); return {}; },
        };
        return tx;
      },
    };
    state.databases.push(database);
    queueMicrotask(() => { request.result = database; if (!created) { created = true; request.onupgradeneeded?.(); } request.onsuccess?.(); });
    return request;
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: state });
  return state;
}

test("empty vault does not invent accounts, credentials, or an encryption key", async () => {
  const db = memoryDatabase();
  assert.deepEqual(await vault.listAccounts(), []);
  assert.equal(await vault.loadBinding(), null);
  assert.equal(db.records.size, 0);
});

test("real Web Crypto encrypts secrets and returns only public fields in lists", async () => {
  const db = memoryDatabase();
  await vault.saveBinding(binding);
  const one = await vault.saveAccount(first);
  const two = await vault.saveAccount(second);
  assert.deepEqual(one, { id: idFor(first.appId), appId: first.appId, name: first.name });
  assert.deepEqual(await vault.listAccounts(), [one, two]);
  assert.deepEqual(await vault.readAccountSecret(one.id), { ...first, id: one.id });
  assert.deepEqual(await vault.loadBinding(), binding);
  const serialized = JSON.stringify([...db.records.values()]);
  for (const secret of [first.appSecret, second.appSecret, binding.connectionToken]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('"appSecret"'), false);
  assert.equal(serialized.includes('"connectionToken"'), false);
  const key = db.records.get("encryption-key").value;
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey("raw", key));
  // The mock's structuredClone must retain a usable non-extractable CryptoKey.
  assert.equal(structuredClone(key).extractable, false);
});

test("saving the same AppID replaces its secret atomically and rotates the IV", async () => {
  const db = memoryDatabase();
  const one = await vault.saveAccount(first);
  const previous = structuredClone(db.records.get(`account:${one.id}`));
  await vault.saveAccount({ ...first, name: "已更新名称", appSecret: "replacement-secret" });
  assert.equal((await vault.listAccounts()).length, 1);
  assert.notDeepEqual(db.records.get(`account:${one.id}`).iv, previous.iv);
  assert.equal((await vault.readAccountSecret(one.id)).appSecret, "replacement-secret");
  assert.equal((await vault.readAccountSecret(one.id)).name, "已更新名称");
  db.failWrite = true;
  await assert.rejects(vault.saveAccount({ ...first, appSecret: "must-not-commit" }), /存储权限/);
  assert.equal((await vault.readAccountSecret(one.id)).appSecret, "replacement-secret");
  assert.equal((await vault.readAccountSecret(one.id)).name, "已更新名称");
});

test("changing the bound device requires removing every local account first", async () => {
  memoryDatabase();
  await vault.saveBinding(binding);
  const one = await vault.saveAccount(first);
  const two = await vault.saveAccount(second);
  const replacement = { deviceId: "different-device", connectionToken: "new-connection-token" };
  await assert.rejects(vault.saveBinding(replacement), /先清除本机公众号账号/);
  assert.deepEqual(await vault.loadBinding(), binding);
  await vault.saveBinding({ ...binding, connectionToken: "rotated-local-token" });
  assert.equal((await vault.loadBinding()).connectionToken, "rotated-local-token");
  await vault.removeAccount(one.id);
  await assert.rejects(vault.readAccountSecret(one.id), /没有这个公众号/);
  await assert.rejects(vault.saveBinding(replacement), /先清除/);
  assert.equal((await vault.readAccountSecret(two.id)).appSecret, second.appSecret);
  await vault.removeAccount(two.id);
  await vault.saveBinding(replacement);
  assert.deepEqual(await vault.loadBinding(), replacement);
});

test("queued first writes share one key and a failed write cannot poison later saves", async () => {
  const db = memoryDatabase();
  const [one, two] = await Promise.all([vault.saveAccount(first), vault.saveAccount(second), vault.saveBinding(binding)]);
  assert.equal([...db.records.keys()].filter((key) => key === "encryption-key").length, 1);
  assert.equal((await vault.readAccountSecret(one.id)).appSecret, first.appSecret);
  assert.equal((await vault.readAccountSecret(two.id)).appSecret, second.appSecret);
  db.failWrite = true;
  await assert.rejects(vault.saveBinding({ ...binding, connectionToken: "discard-this-token" }));
  assert.deepEqual(await vault.loadBinding(), binding);
  await vault.saveBinding({ ...binding, connectionToken: "keep-this-token" });
  assert.equal((await vault.loadBinding()).connectionToken, "keep-this-token");
});

test("a device change in another tab cannot race an in-progress account save", async () => {
  const db = memoryDatabase();
  await vault.saveBinding(binding);
  db.beforeWrite = () => { db.records.get("binding").deviceId = "other-tab-device"; };
  await assert.rejects(vault.saveAccount(first), /先清除本机公众号账号/);
  assert.deepEqual(await vault.listAccounts(), []);
});

test("an account added in another tab blocks rebinding inside the same write transaction", async () => {
  const db = memoryDatabase();
  await vault.saveBinding(binding);
  const one = await vault.saveAccount(first);
  const archived = structuredClone(db.records.get(`account:${one.id}`));
  await vault.removeAccount(one.id);
  db.beforeWrite = () => { db.records.set(archived.key, archived); };
  await assert.rejects(vault.saveBinding({ ...binding, deviceId: "other-device" }), /先清除本机公众号账号/);
  assert.deepEqual(await vault.loadBinding(), binding);
  assert.equal((await vault.readAccountSecret(one.id)).appSecret, first.appSecret);
});

test("ciphertext swapping, metadata tampering, and missing keys fail without exposing secrets", async () => {
  const db = memoryDatabase();
  const one = await vault.saveAccount(first);
  const two = await vault.saveAccount(second);
  const original = structuredClone(db.records.get(`account:${one.id}`));
  const other = db.records.get(`account:${two.id}`);
  db.records.set(`account:${one.id}`, { ...original, iv: other.iv, ciphertext: other.ciphertext });
  await assert.rejects(vault.readAccountSecret(one.id), /无法解锁/);
  db.records.set(`account:${one.id}`, { ...original, name: "被篡改名称" });
  await assert.rejects(vault.readAccountSecret(one.id), /无法解锁/);
  db.records.set(`account:${one.id}`, original);
  db.records.delete("encryption-key");
  await assert.rejects(vault.saveAccount(first), /无法解锁/);
  await assert.rejects(vault.readAccountSecret(one.id), /无法解锁/);
  assert.equal(db.records.has("encryption-key"), false);
  await vault.removeAccount(one.id);
  await vault.removeAccount(two.id);
  assert.deepEqual(await vault.listAccounts(), []);
});

test("bad inputs never become stored fields or leak their values through errors", async () => {
  const db = memoryDatabase();
  for (const input of [{ ...first, name: "" }, { ...first, appSecret: "sensitive\nsecret" }]) {
    await assert.rejects(vault.saveAccount(input), (error) => !error.message.includes("sensitive"));
  }
  await assert.rejects(vault.readAccountSecret("../outside"), /标识无效/);
  assert.equal(db.records.size, 0);
});

test("explicit recovery atomically clears only the credential vault and allows a new binding", async () => {
  const db = memoryDatabase();
  await vault.saveBinding(binding); await vault.saveAccount(first); await vault.saveAccount(second);
  db.failWrite = true;
  await assert.rejects(vault.clearDeviceVault(), /存储权限/);
  assert.deepEqual(await vault.loadBinding(), binding); assert.equal((await vault.listAccounts()).length, 2);
  await vault.clearDeviceVault();
  assert.equal(db.records.size, 0); assert.equal(await vault.loadBinding(), null); assert.deepEqual(await vault.listAccounts(), []);
  await vault.saveBinding({ deviceId: "replacement-device", connectionToken: "replacement-token" });
  await vault.saveAccount(first);
  assert.equal((await vault.loadBinding()).deviceId, "replacement-device");
  assert.equal((await vault.readAccountSecret(idFor(first.appId))).appSecret, first.appSecret);
});

test("recovery can clear a damaged key without decrypting or accepting its contents", async () => {
  const db = memoryDatabase();
  await vault.saveAccount(first);
  db.records.set("encryption-key", { key: "encryption-key", value: "damaged" });
  await vault.clearDeviceVault();
  assert.equal(db.records.size, 0);
});
