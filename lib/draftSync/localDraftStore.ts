import type { DraftContent, DraftPlatform, LocalDraft, SyncReceipt } from "./types";

const DATABASE = "zhepage-local-draft-sync";
const STORE = "drafts";
const KEY = "current";
// A dialog can close while Blob encoding is still running. Keep writes ordered
// across dialog instances so a late old save cannot replace a new recovery ID.
let pendingWrite: Promise<void> = Promise.resolve();
function queueWrite(operation: () => Promise<void>) {
  const write = pendingWrite.then(operation);
  pendingWrite = write.catch(() => {});
  return write;
}

type StoredDraftImage = Omit<LocalDraft["images"][number], "blob"> & { mime: string; bytes: ArrayBuffer };
type StoredLocalDraft = Omit<LocalDraft, "images" | "receipts"> & { images: StoredDraftImage[]; receipts: Omit<SyncReceipt, "url">[] };

const invalidArchive = () => new Error("本机存档不完整，请清除存档后重新准备素材");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArchive();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw invalidArchive();
  return value;
}
function platform(value: unknown): DraftPlatform {
  if (value !== "xiaohongshu" && value !== "wechat") throw invalidArchive();
  return value;
}
function content(value: unknown): DraftContent {
  const fields = record(value);
  // An unfinished draft may exceed platform limits while the user is editing.
  return { title: text(fields.title, 10000), body: text(fields.body, 100000) };
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw invalidArchive();
  const result = value.map((id) => text(id, 200, true));
  if (new Set(result).size !== result.length) throw invalidArchive();
  return result;
}

/** Restore only draft fields; credentials and unrelated objects are never archived. */
export function normalizeLocalDraft(value: unknown): LocalDraft {
  const draft = record(value);
  if (draft.schemaVersion !== 1 || !Array.isArray(draft.images) || draft.images.length > 250) throw invalidArchive();
  const images = draft.images.map((value) => {
    const image = record(value);
    if (!(image.blob instanceof Blob) || !["image/png", "image/jpeg"].includes(image.blob.type) || !image.blob.size) throw invalidArchive();
    if (![image.width, image.height].every((dimension) => Number.isSafeInteger(dimension) && Number(dimension) > 0 && Number(dimension) <= 20000)) throw invalidArchive();
    return { id: text(image.id, 200, true), name: text(image.name, 500), blob: image.blob, width: Number(image.width), height: Number(image.height) };
  });
  if (new Set(images.map((image) => image.id)).size !== images.length) throw invalidArchive();
  const fields = record(draft.content);
  const updatedAt = text(draft.updatedAt, 40, true);
  if (!Number.isFinite(Date.parse(updatedAt))) throw invalidArchive();
  if (!Array.isArray(draft.receipts) || draft.receipts.length > 100) throw invalidArchive();
  const receipts: SyncReceipt[] = draft.receipts.map((value) => {
    const receipt = record(value);
    if (typeof receipt.status !== "string" || !["saved", "confirmed_by_user", "needs_confirmation", "failed"].includes(receipt.status)) throw invalidArchive();
    const draftId = receipt.draftId === undefined ? undefined : text(receipt.draftId, 512, true);
    if (receipt.publicationAttempted !== undefined && receipt.publicationAttempted !== true) throw invalidArchive();
    const publicationAttempted = receipt.publicationAttempted as true | undefined;
    const contentHash = receipt.contentHash === undefined ? undefined : text(receipt.contentHash, 64, true);
    if (contentHash && !/^[a-f0-9]{64}$/.test(contentHash)) throw invalidArchive();
    const jobId = receipt.jobId === undefined ? undefined : text(receipt.jobId, 36, true);
    if (jobId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) throw invalidArchive();
    if (receipt.status === "saved" && !draftId) throw invalidArchive();
    let url: string | undefined;
    if (receipt.url !== undefined) {
      const parsed = new URL(text(receipt.url, 2048, true));
      if (parsed.protocol !== "https:" || !["mp.weixin.qq.com", "creator.xiaohongshu.com"].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw invalidArchive();
      // Platform navigation never needs credential-bearing query parameters.
      url = `${parsed.origin}${parsed.pathname}`;
    }
    return { accountId: text(receipt.accountId, 200, true), platform: platform(receipt.platform), status: receipt.status as SyncReceipt["status"], message: text(receipt.message, 4000), ...(draftId ? { draftId } : {}), ...(jobId ? { jobId } : {}), ...(contentHash ? { contentHash } : {}), ...(publicationAttempted ? { publicationAttempted } : {}), ...(url ? { url } : {}) };
  });
  if (new Set(receipts.map((receipt) => `${receipt.platform}:${receipt.accountId}`)).size !== receipts.length) throw invalidArchive();
  return {
    schemaVersion: 1, id: text(draft.id, 200, true), updatedAt, sourceFormat: text(draft.sourceFormat, 40, true), images,
    content: { xiaohongshu: content(fields.xiaohongshu), wechat: content(fields.wechat) },
    selectedAccountIds: identifiers(draft.selectedAccountIds), receipts,
  };
}

export async function encodeLocalDraft(draft: LocalDraft): Promise<StoredLocalDraft> {
  const snapshot = normalizeLocalDraft(draft);
  // Private WebKit sessions cannot persist Blob/File values in IndexedDB.
  const images = await Promise.all(snapshot.images.map(async ({ blob, ...metadata }) => ({ ...metadata, mime: blob.type, bytes: await blob.arrayBuffer() })));
  const receipts = snapshot.receipts.map(({ accountId, platform, status, message, draftId, jobId, contentHash, publicationAttempted }) => ({ accountId, platform, status, message, ...(draftId ? { draftId } : {}), ...(jobId ? { jobId } : {}), ...(contentHash ? { contentHash } : {}), ...(publicationAttempted ? { publicationAttempted } : {}) }));
  return { ...snapshot, images, receipts };
}

export function decodeLocalDraft(value: unknown): LocalDraft {
  const draft = record(value);
  if (draft.schemaVersion !== 1 || !Array.isArray(draft.images) || draft.images.length > 250) throw invalidArchive();
  const images = draft.images.map((value) => {
    const image = record(value);
    if (!(image.bytes instanceof ArrayBuffer) || !image.bytes.byteLength || typeof image.mime !== "string" || !["image/png", "image/jpeg"].includes(image.mime)) throw invalidArchive();
    return { id: image.id, name: image.name, width: image.width, height: image.height, blob: new Blob([image.bytes], { type: image.mime }) };
  });
  return normalizeLocalDraft({ ...draft, images });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    let blocked = false;
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(new Error("本机存档不可用，请检查浏览器存储权限"));
    request.onblocked = () => { blocked = true; reject(new Error("另一窗口正在使用本机存档，请关闭后重试")); };
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
  await pendingWrite;
  const draft = await withStore<unknown>("readonly", (store) => store.get(KEY));
  if (draft === undefined) return null;
  try { return decodeLocalDraft(draft); }
  catch { throw invalidArchive(); }
}

export async function saveLocalDraft(draft: LocalDraft): Promise<void> {
  const snapshot = normalizeLocalDraft(draft);
  await queueWrite(async () => {
    // Finish asynchronous reads before creating the single write transaction.
    const encoded = await encodeLocalDraft(snapshot);
    await withStore("readwrite", (store) => store.put(encoded, KEY));
  });
}

export async function clearLocalDraft(): Promise<void> {
  await queueWrite(async () => { await withStore("readwrite", (store) => store.delete(KEY)); });
}
