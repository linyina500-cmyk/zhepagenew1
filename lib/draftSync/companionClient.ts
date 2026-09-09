import type { DraftAccount, DraftContent, DraftImage, SyncReceipt } from "./types";

export const COMPANION_URL = "http://127.0.0.1:47831";
export type CompanionConnection = { token: string };
class CompanionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());

function readAccount(value: unknown): DraftAccount {
  if (!isRecord(value) || !isText(value.id) || !isText(value.displayName) || !isText(value.remoteId) || (value.platform !== "xiaohongshu" && value.platform !== "wechat") || typeof value.ready !== "boolean" || (value.syncBlocked !== undefined && typeof value.syncBlocked !== "boolean")) {
    throw new Error("本机助手返回的账号信息不完整，请刷新账号或重新连接");
  }
  return { id: value.id, platform: value.platform as DraftAccount["platform"], displayName: value.displayName, remoteId: value.remoteId, ready: value.ready, ...(value.syncBlocked === undefined ? {} : { syncBlocked: value.syncBlocked }) };
}

function readReceipt(value: unknown, account: DraftAccount): SyncReceipt | null {
  if (!isRecord(value) || value.accountId !== account.id || value.platform !== account.platform || typeof value.status !== "string" || !["saved", "confirmed_by_user", "needs_confirmation", "failed"].includes(value.status) || !isText(value.message) || (value.draftId !== undefined && !isText(value.draftId)) || (value.status === "saved" && !isText(value.draftId))) return null;
  return { accountId: account.id, platform: account.platform, status: value.status as SyncReceipt["status"], message: value.message, ...(isText(value.draftId) ? { draftId: value.draftId } : {}) };
}

async function request<T>(connection: CompanionConnection, path: string, body?: unknown, timeout = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${COMPANION_URL}/api${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${connection.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new CompanionRequestError(isRecord(data) && typeof data.error === "string" ? data.error : "本机助手请求失败", response.status);
    return data as T;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) throw new Error("未收到本机助手响应。请确认助手正在运行、配对码正确，并允许浏览器访问本地网络");
    throw error;
  } finally { window.clearTimeout(timer); }
}

export async function listAccounts(connection: CompanionConnection): Promise<DraftAccount[]> {
  const data = await request<unknown>(connection, "/accounts");
  if (!isRecord(data) || !Array.isArray(data.accounts)) throw new Error("本机助手返回的账号列表无效，请重新连接");
  const accounts = data.accounts.map(readAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error("本机助手返回了重复账号，请刷新账号后重试");
  return accounts;
}

export async function addWechatAccount(connection: CompanionConnection, input: { displayName: string; appId: string; appSecret: string }): Promise<DraftAccount> {
  const data = await request<{ account?: unknown }>(connection, "/accounts/wechat", input, 90000);
  const account = readAccount(data?.account);
  if (account.platform !== "wechat") throw new Error("本机助手返回了不匹配的平台账号，请刷新账号后重试");
  return account;
}

export async function addXiaohongshuAccount(connection: CompanionConnection, displayName: string): Promise<DraftAccount> {
  const data = await request<{ account?: unknown }>(connection, "/accounts/xiaohongshu", { displayName }, 300000);
  const account = readAccount(data?.account);
  if (account.platform !== "xiaohongshu") throw new Error("本机助手返回了不匹配的平台账号，请刷新账号后重试");
  return account;
}

export async function removeAccount(connection: CompanionConnection, accountId: string): Promise<void> {
  await request(connection, "/accounts/remove", { accountId });
}

export async function acknowledgeUnconfirmed(connection: CompanionConnection, accountId: string, outcome: "saved" | "not_saved"): Promise<void> {
  await request(connection, "/jobs/acknowledge", { accountId, outcome });
}

async function encodeImage(image: DraftImage) {
  const bytes = new Uint8Array(await image.blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return { id: image.id, name: image.name, mime: image.blob.type, width: image.width, height: image.height, base64: btoa(binary) };
}

export async function syncDraft(connection: CompanionConnection, account: DraftAccount, content: DraftContent, images: DraftImage[]): Promise<SyncReceipt> {
  const requestId = crypto.randomUUID();
  const uncertain = (): SyncReceipt => ({ accountId: account.id, platform: account.platform, status: "needs_confirmation", message: "请求已发出，但未收到完整结果。请先在对应平台账号检查草稿，再如实确认已保存或未保存；核对前不能再次同步。" });
  const payload = { requestId, accountId: account.id, content, images: await Promise.all(images.map(encodeImage)) };
  try {
    await request(connection, "/jobs", payload, 90000);
  } catch (error) {
    if (error instanceof CompanionRequestError && error.status >= 400 && error.status < 500) return { accountId: account.id, platform: account.platform, status: "failed", message: error.message };
    // A timeout does not prove that the platform write failed. Reconcile the same job.
    try { const job = await request<{ state: string; receipt?: unknown }>(connection, `/jobs/${requestId}`); if (job.receipt) return readReceipt(job.receipt, account) || uncertain(); }
    catch { return uncertain(); }
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const job = await request<{ state: string; receipt?: unknown }>(connection, `/jobs/${requestId}`);
      if (job.receipt) return readReceipt(job.receipt, account) || uncertain();
      if (!["queued", "running"].includes(job.state)) return uncertain();
    } catch { return uncertain(); }
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }
  return uncertain();
}
