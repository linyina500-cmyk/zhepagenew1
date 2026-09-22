export type LocalWechatAccount = { id: string; name: string; appId: string };
export type Binding = { deviceId: string; connectionToken: string };
type AccountSecret = LocalWechatAccount & { appSecret: string };
type Cipher = { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };
type KeyEntry = { key: "encryption-key"; keyId: string; value: CryptoKey };
type AccountEntry = LocalWechatAccount & Cipher & { key: string };
type BindingEntry = Cipher & { key: "binding"; deviceId: string };
type State = { key?: KeyEntry; binding?: BindingEntry; accounts: AccountEntry[] };

const DATABASE = "zhepage-wechat-device-vault";
const STORE = "records";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const unavailable = () => new Error("本机公众号资料无法保存，请检查浏览器存储权限和可用空间");
const damaged = () => new Error("本机公众号资料无法解锁，请在账号管理中清除公众号绑定后重新配置");
const changedDevice = () => new Error("连接设备已改变，请先清除本机公众号账号，再连接新设备");
let pendingWrite: Promise<unknown> = Promise.resolve();

function queueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingWrite.then(operation);
  pendingWrite = result.catch(() => {});
  return result;
}

function hasControl(value: string, allowLineWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && !(allowLineWhitespace && [9, 10, 13].includes(code)));
  });
}
function field(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || hasControl(value)) throw new Error(`${label}应为非空的单行内容`);
  return value.trim();
}
function accountInput(input: { appId: string; appSecret: string; name: string }) {
  return { appId: field(input.appId, "AppID", 200), appSecret: field(input.appSecret, "AppSecret"), name: field(input.name, "公众号名称") };
}
function bindingInput(input: Binding): Binding {
  return { deviceId: field(input.deviceId, "设备标识", 200), connectionToken: field(input.connectionToken, "连接口令") };
}
function accountId(value: string): string {
  if (!/^[a-f0-9]{20}$/u.test(value)) throw new Error("公众号账号标识无效");
  return value;
}
async function hashAppId(appId: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(appId));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 20);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !globalThis.crypto?.subtle) { reject(unavailable()); return; }
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else { request.result.onversionchange = () => request.result.close(); resolve(request.result); }
    };
    request.onerror = () => reject(unavailable());
    request.onblocked = () => { blocked = true; reject(new Error("另一窗口正在使用本机公众号资料，请关闭该窗口后重试")); };
  });
}

// Crypto runs before the write transaction. All conflict checks and writes run
// synchronously in its request callback, so IndexedDB cannot commit half a save.
async function transaction<T>(mode: IDBTransactionMode, operation: (records: unknown[], store: IDBObjectStore) => T): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const request = store.getAll();
      let result: T;
      let failure: Error | undefined;
      request.onsuccess = () => {
        try { result = operation(request.result, store); }
        catch (error) { failure = error instanceof Error ? error : damaged(); tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || unavailable());
    });
  } finally { database.close(); }
}

function readState(records: unknown[]): State {
  const state: State = { accounts: [] };
  for (const value of records) {
    if (!value || typeof value !== "object" || !("key" in value)) throw damaged();
    const entry = value as Record<string, unknown>;
    if (entry.key === "encryption-key") {
      const key = entry.value as CryptoKey;
      if (!key || key.type !== "secret" || key.extractable !== false || key.algorithm?.name !== "AES-GCM" || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt") || typeof entry.keyId !== "string") throw damaged();
      state.key = entry as KeyEntry;
    } else if (entry.key === "binding") {
      if (typeof entry.deviceId !== "string" || !entry.deviceId) throw damaged();
      state.binding = entry as BindingEntry;
    } else if (typeof entry.key === "string" && entry.key.startsWith("account:")) {
      if (typeof entry.id !== "string" || !/^[a-f0-9]{20}$/u.test(entry.id) || entry.key !== `account:${entry.id}` || typeof entry.appId !== "string" || !entry.appId || typeof entry.name !== "string" || !entry.name) throw damaged();
      state.accounts.push(entry as AccountEntry);
    } else throw damaged();
  }
  return state;
}
function aad(kind: "binding" | "account", metadata: string[], keyId: string) {
  return encoder.encode(JSON.stringify([DATABASE, 1, keyId, kind, ...metadata]));
}
async function encrypt(value: string, key: KeyEntry, additionalData: Uint8Array<ArrayBuffer>): Promise<Cipher> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key.value, encoder.encode(value));
  return { iv, ciphertext };
}
async function decrypt(value: Cipher, key: KeyEntry | undefined, additionalData: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    if (!key || !(value.iv instanceof Uint8Array) || value.iv.byteLength !== 12 || !(value.ciphertext instanceof ArrayBuffer) || value.ciphertext.byteLength < 16) throw damaged();
    return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv, additionalData }, key.value, value.ciphertext));
  } catch { throw damaged(); }
}
async function encryptionContext(): Promise<State & { key: KeyEntry }> {
  const current = await transaction("readonly", (records) => readState(records));
  if (current.key) return { ...current, key: current.key };
  if (current.binding || current.accounts.length) throw damaged();
  // This prevents plaintext storage, not same-origin script access or copying
  // an entire browser profile. The non-extractable key stays in this origin's IDB.
  const candidate: KeyEntry = { key: "encryption-key", keyId: crypto.randomUUID(), value: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
  return transaction("readwrite", (records, store) => {
    const state = readState(records);
    if (state.key) return { ...state, key: state.key };
    if (state.binding || state.accounts.length) throw damaged();
    store.put(candidate);
    return { ...state, key: candidate };
  });
}
function sameContext(current: State, expected: State & { key: KeyEntry }) {
  if (current.key?.keyId !== expected.key.keyId) throw damaged();
  if (current.binding?.deviceId !== expected.binding?.deviceId) throw changedDevice();
}

export async function saveBinding(binding: Binding): Promise<void> {
  const input = bindingInput(binding);
  return queueWrite(async () => {
    const context = await encryptionContext();
    if (context.binding && context.binding.deviceId !== input.deviceId && context.accounts.length) throw changedDevice();
    const encoded = await encrypt(input.connectionToken, context.key, aad("binding", [input.deviceId], context.key.keyId));
    await transaction("readwrite", (records, store) => {
      const current = readState(records);
      sameContext(current, context);
      if (current.binding && current.binding.deviceId !== input.deviceId && current.accounts.length) throw changedDevice();
      store.put({ key: "binding", deviceId: input.deviceId, ...encoded } satisfies BindingEntry);
    });
  });
}

export async function loadBinding(): Promise<Binding | null> {
  await pendingWrite;
  const state = await transaction("readonly", (records) => readState(records));
  if (!state.binding) return null;
  const connectionToken = await decrypt(state.binding, state.key, aad("binding", [state.binding.deviceId], state.key?.keyId || ""));
  return bindingInput({ deviceId: state.binding.deviceId, connectionToken });
}

export async function listAccounts(): Promise<LocalWechatAccount[]> {
  await pendingWrite;
  return transaction("readonly", (records) => readState(records).accounts.map(({ id, name, appId }) => ({ id, name, appId })));
}

export async function saveAccount(account: { appId: string; appSecret: string; name: string }): Promise<LocalWechatAccount> {
  const input = accountInput(account);
  return queueWrite(async () => {
    const id = await hashAppId(input.appId);
    const result: LocalWechatAccount = { id, name: input.name, appId: input.appId };
    const context = await encryptionContext();
    const encoded = await encrypt(input.appSecret, context.key, aad("account", [id, input.appId, input.name], context.key.keyId));
    await transaction("readwrite", (records, store) => {
      sameContext(readState(records), context);
      store.put({ key: `account:${id}`, ...result, ...encoded } satisfies AccountEntry);
    });
    return result;
  });
}

export async function readAccountSecret(id: string): Promise<AccountSecret> {
  accountId(id);
  await pendingWrite;
  const state = await transaction("readonly", (records) => readState(records));
  const entry = state.accounts.find((account) => account.id === id);
  if (!entry) throw new Error("本机没有这个公众号，请重新添加账号");
  if (await hashAppId(entry.appId) !== id) throw damaged();
  const appSecret = await decrypt(entry, state.key, aad("account", [id, entry.appId, entry.name], state.key?.keyId || ""));
  return { id, ...accountInput({ appId: entry.appId, name: entry.name, appSecret }) };
}

export async function removeAccount(id: string): Promise<void> {
  accountId(id);
  return queueWrite(() => transaction("readwrite", (_records, store) => { store.delete(`account:${id}`); }));
}

/** Clear only this credential vault after the caller's explicit recovery flow. */
export async function clearDeviceVault(): Promise<void> {
  return queueWrite(() => transaction("readwrite", (_records, store) => { store.clear(); }));
}

/** Import only this app's old data file; never execute or expand shell syntax. */
export function parseLocalWechatConfig(text: string): { appId: string; appSecret: string; name: string; token: string } {
  const invalid = () => new Error("配置文件格式不支持，请选择原来的 config.env 文件，或手动填写公众号资料");
  if (typeof text !== "string" || text.length > 32768 || hasControl(text, true)) throw invalid();
  const allowed = new Set(["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_ACCOUNT_NAME", "WECHAT_SYNC_TOKEN", "WECHAT_DATA_DIR", "WECHAT_HOST", "WECHAT_PORT"]);
  const values = new Map<string, string>();
  for (const raw of text.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_]+)\s*=\s*(.*)$/u.exec(line);
    if (!match || !allowed.has(match[1]) || values.has(match[1])) throw invalid();
    const source = match[2];
    const quote = source[0];
    let value: string;
    if (quote === "'" || quote === '"' || quote === "`") {
      const end = source.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/u.test(source.slice(end + 1))) throw invalid();
      value = source.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/gu, "\n");
    } else {
      const plain = /^([A-Za-z0-9_.:/-]+)\s*(?:#.*)?$/u.exec(source);
      if (!plain) throw invalid();
      value = plain[1];
    }
    if (/\$\(|\$\{/u.test(value)) throw invalid();
    values.set(match[1], value);
  }
  try {
    const account = accountInput({ appId: values.get("WECHAT_APP_ID") || "", appSecret: values.get("WECHAT_APP_SECRET") || "", name: values.get("WECHAT_ACCOUNT_NAME") || "" });
    return { ...account, token: field(values.get("WECHAT_SYNC_TOKEN"), "连接口令") };
  } catch { throw invalid(); }
}
