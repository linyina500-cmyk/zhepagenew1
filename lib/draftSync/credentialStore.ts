import type { DraftAccount } from "./types";

const DATABASE = "zhepage-cloud-sync-credentials";
const CREDENTIALS = "credentials";
const PENDING = "pending";
const SETTINGS = "settings";
export type StoredCredential = { account: DraftAccount; envelope: string };
type PendingSync = { account: DraftAccount; requestId: string; createdAt: number };
const memory = new Map<string, StoredCredential>();
let rememberAccounts = false;
const identity = (account: DraftAccount) => `${account.platform}:${account.remoteId}`;
const storageError = () => new Error("浏览器未能保存账号或待核对记录。请检查存储权限和可用空间；未确认的同步不会自动重试。");

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(CREDENTIALS);
      request.result.createObjectStore(PENDING);
      request.result.createObjectStore(SETTINGS);
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(storageError());
    request.onblocked = () => { blocked = true; reject(storageError()); };
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, operation: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(storageError());
      tx.onabort = () => reject(storageError());
      try { operation(tx, (value) => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { database.close(); }
}

async function readAll<T>(store: string): Promise<T[]> {
  return transaction<T[]>([store], "readonly", (tx, result) => {
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => result(request.result as T[]);
  });
}

/** Only opaque server-encrypted envelopes enter this store, never raw credentials. */
export async function getCredentials(): Promise<StoredCredential[]> {
  const persisted = await readAll<StoredCredential>(CREDENTIALS);
  return [...new Map([...memory.values(), ...persisted].map((item) => [item.account.id, item])).values()];
}

export async function getCredential(accountId: string): Promise<StoredCredential | undefined> {
  return (await getCredentials()).find((item) => item.account.id === accountId);
}

export async function getRememberAccounts(): Promise<boolean> {
  rememberAccounts = await transaction<boolean>([SETTINGS], "readonly", (tx, result) => {
    const request = tx.objectStore(SETTINGS).get("remember");
    request.onsuccess = () => result(request.result === true);
  });
  return rememberAccounts;
}

export async function setRememberAccounts(remember: boolean): Promise<void> {
  const credentials = await transaction<StoredCredential[]>([CREDENTIALS, SETTINGS], "readwrite", (tx, result) => {
    const store = tx.objectStore(CREDENTIALS);
    const request = store.getAll();
    request.onsuccess = () => {
      const current = [...new Map([...memory.values(), ...(request.result as StoredCredential[])].map((item) => [item.account.id, item])).values()];
      store.clear();
      if (remember) for (const item of current) store.put(item, item.account.id);
      tx.objectStore(SETTINGS).put(remember, "remember");
      result(current);
    };
  });
  memory.clear();
  if (!remember) for (const item of credentials) memory.set(item.account.id, item);
  rememberAccounts = remember;
}

export async function saveCredential(account: DraftAccount, envelope: string): Promise<void> {
  if (!envelope.trim()) throw new Error("同步服务未返回有效的加密授权包，请重新连接账号。");
  const item = { account: { ...account }, envelope };
  // Read the shared preference and write in one transaction. Another tab may
  // have disabled remembering while this page was awaiting a platform result.
  const persisted = await transaction<boolean>([CREDENTIALS, SETTINGS], "readwrite", (tx, result) => {
    const setting = tx.objectStore(SETTINGS).get("remember");
    setting.onsuccess = () => {
      const remember = setting.result === true;
      const store = tx.objectStore(CREDENTIALS);
      if (remember) store.put(item, account.id); else store.delete(account.id);
      result(remember);
    };
  });
  if (persisted) memory.delete(account.id); else memory.set(account.id, item);
}

export async function withPendingAccounts(accounts: DraftAccount[]): Promise<DraftAccount[]> {
  const pending = await readAll<PendingSync>(PENDING);
  const result = accounts.map((account) => {
    const marker = pending.find((item) => identity(item.account) === identity(account));
    return { ...account, syncBlocked: Boolean(account.syncBlocked || marker), ...(marker ? { pendingJobId: marker.requestId } : {}) };
  });
  // A reload without "remember" loses envelopes, but must retain unresolved work.
  for (const item of pending) if (!result.some((account) => identity(account) === identity(item.account))) result.push({ ...item.account, ready: false, syncBlocked: true, pendingJobId: item.requestId });
  return result;
}

/** add() atomically prevents another tab from sending for the same account. */
export async function lockSync(account: DraftAccount, requestId: string): Promise<void> {
  await transaction<void>([PENDING], "readwrite", (tx) => {
    tx.objectStore(PENDING).add({ account: { ...account }, requestId, createdAt: Date.now() } satisfies PendingSync, identity(account));
  });
}

export async function getPendingRequestId(account: DraftAccount): Promise<string | undefined> {
  return (await readAll<PendingSync>(PENDING)).find((item) => identity(item.account) === identity(account))?.requestId;
}

export async function unlockSync(account: DraftAccount, requestId: string | undefined): Promise<void> {
  await transaction<void>([PENDING], "readwrite", (tx) => {
    const store = tx.objectStore(PENDING);
    const request = store.get(identity(account));
    request.onsuccess = () => {
      const pending = request.result as PendingSync | undefined;
      if (pending && pending.requestId !== requestId) { tx.abort(); return; }
      store.delete(identity(account));
    };
  });
}

export async function deleteCredential(accountId: string): Promise<void> {
  await transaction<void>([CREDENTIALS], "readwrite", (tx) => { tx.objectStore(CREDENTIALS).delete(accountId); });
  memory.delete(accountId);
}
