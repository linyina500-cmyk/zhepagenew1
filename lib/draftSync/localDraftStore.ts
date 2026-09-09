import type { LocalDraft } from "./types";

const DATABASE = "zhepage-local-draft-sync";
const STORE = "drafts";
const KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("本机存档不可用，请检查浏览器存储权限"));
    request.onblocked = () => reject(new Error("另一窗口正在使用本机存档，请关闭后重试"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(new Error("本机存档失败，可能是存储空间不足；当前编辑仍保留在此窗口"));
      transaction.onabort = () => reject(new Error("本机存档已中断；当前编辑仍保留在此窗口"));
    });
  } finally { database.close(); }
}

export async function loadLocalDraft(): Promise<LocalDraft | null> {
  const draft = await withStore<LocalDraft | undefined>("readonly", (store) => store.get(KEY));
  if (!draft) return null;
  if (draft.schemaVersion !== 1 || !Array.isArray(draft.images) || !draft.images.every((image) => image.blob instanceof Blob) || !draft.content?.xiaohongshu || !draft.content?.wechat) throw new Error("本机存档不完整，请清除存档后重新准备素材");
  return draft;
}

export async function saveLocalDraft(draft: LocalDraft): Promise<void> {
  await withStore("readwrite", (store) => store.put(draft, KEY));
}

export async function clearLocalDraft(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(KEY));
}
