import type { DraftAccount, DraftContent, DraftImage, SyncReceipt } from "./types";
import { deleteCredential, getCredential, getCredentials, getPendingRequestId, lockSync, saveCredential, setRememberAccounts, unlockSync, withPendingAccounts } from "./credentialStore";

export type CloudConnection = { csrf: string };
export type CloudSession = { authenticated: boolean; csrf?: string; configured: true };
export type JobPreview = { image?: string; expiresAt?: number };
export const UNCONFIGURED_MESSAGE = "网页同步服务尚未部署，请联系站点管理员完成配置";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const screenshot = (value: unknown): value is string => typeof value === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value);
class CloudRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function readAccount(value: unknown): DraftAccount {
  if (!record(value) || !text(value.id) || !text(value.displayName) || !text(value.remoteId) || (value.platform !== "xiaohongshu" && value.platform !== "wechat") || typeof value.ready !== "boolean" || (value.syncBlocked !== undefined && typeof value.syncBlocked !== "boolean")) throw new Error("同步服务返回的账号信息不完整，请重新连接账号。");
  return { id: value.id, platform: value.platform, displayName: value.displayName, remoteId: value.remoteId, ready: value.ready, syncBlocked: value.syncBlocked as boolean | undefined, ...(text(value.pendingJobId) ? { pendingJobId: value.pendingJobId } : {}) };
}

function readReceipt(value: unknown, account: DraftAccount): SyncReceipt | null {
  if (!record(value) || value.accountId !== account.id || value.platform !== account.platform || !["saved", "needs_confirmation", "failed"].includes(String(value.status)) || !text(value.message) || (value.draftId !== undefined && !text(value.draftId)) || (value.status === "saved" && !text(value.draftId))) return null;
  return { accountId: account.id, platform: account.platform, status: value.status as SyncReceipt["status"], message: value.message, ...(text(value.draftId) ? { draftId: value.draftId } : {}) };
}

async function request(connection: CloudConnection | null, path: string, body?: unknown, timeout = 30000, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(abort, timeout);
  try {
    const response = await fetch(`/api/sync${path}`, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(connection ? { "X-CSRF-Token": connection.csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 && path !== "/session") window.dispatchEvent(new window.Event("zhepage-sync-session-expired"));
      const message = response.status === 503 || (response.status === 404 && path === "/session") || !record(data) ? UNCONFIGURED_MESSAGE : response.status === 401 && path !== "/session" ? "同步服务登录已过期，请重新输入服务口令。待核对结果仍保留，不会自动重试。" : text(data.error) ? data.error : "网页同步请求未完成，请稍后再试。";
      throw new CloudRequestError(message, response.status);
    }
    if (!record(data)) throw new Error(UNCONFIGURED_MESSAGE);
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("已结束本次登录等待", "AbortError");
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) throw new Error("与网页同步服务的连接中断。已发送的保存请求不会自动重试，请先核对结果。");
    throw error;
  } finally { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function getCloudSession(): Promise<CloudSession> {
  const data = await request(null, "/session");
  if (!record(data) || data.configured !== true || typeof data.authenticated !== "boolean" || (data.authenticated && !text(data.csrf))) throw new Error(UNCONFIGURED_MESSAGE);
  return { authenticated: data.authenticated, ...(text(data.csrf) ? { csrf: data.csrf } : {}), configured: true };
}

export async function connectCloudService(password: string, remember: boolean): Promise<CloudConnection> {
  const data = await request(null, "/session", { password, remember });
  if (!record(data) || data.authenticated !== true || !text(data.csrf)) throw new Error("同步服务未确认登录成功，请重新连接。");
  await setRememberAccounts(remember);
  return { csrf: data.csrf };
}

export async function listAccounts(connection: CloudConnection): Promise<DraftAccount[]> {
  const stored = await getCredentials();
  const data = await request(connection, "/accounts/inspect", { envelopes: stored.map((item) => item.envelope) });
  if (!record(data) || !Array.isArray(data.accounts)) throw new Error("同步服务返回的账号列表无效。");
  const accounts = data.accounts.map(readAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error("同步服务返回了重复账号。");
  // Expired envelopes stay visible so their owner can reconnect or remove them.
  for (const item of stored) if (!accounts.some((account) => account.id === item.account.id)) accounts.push({ ...item.account, ready: false });
  return withPendingAccounts(accounts);
}

async function saveAccountResult(data: unknown, platform: DraftAccount["platform"]): Promise<DraftAccount> {
  if (!record(data) || !text(data.envelope)) throw new Error("同步服务未返回加密授权包，请重新连接账号。");
  const account = readAccount(data.account);
  if (account.platform !== platform) throw new Error("同步服务返回的账号与所选平台不匹配。");
  await saveCredential(account, data.envelope);
  return (await withPendingAccounts([account])).find((item) => item.id === account.id)!;
}

export async function addWechatAccount(connection: CloudConnection, input: { displayName: string; appId: string; appSecret: string }): Promise<DraftAccount> {
  return saveAccountResult(await request(connection, "/accounts/wechat", input, 90000), "wechat");
}

const loginOutcomes = new Map<string, { account?: DraftAccount; rejected?: boolean }>();
function waitForPoll(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("已结束本次登录等待", "AbortError")); };
    const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 1500);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function addXiaohongshuAccount(connection: CloudConnection, displayName: string, loginRequestId: string, signal?: AbortSignal, onImage?: (image: string) => void): Promise<DraftAccount> {
  try {
    const started = await request(connection, "/logins", { displayName, loginRequestId }, 90000, signal);
    if (!record(started) || started.id !== loginRequestId) throw new Error("同步服务未返回匹配的登录编号。");
  } catch (error) {
    if (error instanceof CloudRequestError && error.status >= 400 && error.status < 500) loginOutcomes.set(loginRequestId, { rejected: true });
    throw error;
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const data = await request(connection, `/logins/${encodeURIComponent(loginRequestId)}`, undefined, 30000, signal);
    if (!record(data)) throw new Error("未能核对登录状态。");
    if (data.state === "complete") {
      const account = await saveAccountResult(data, "xiaohongshu");
      loginOutcomes.set(loginRequestId, { account });
      return account;
    }
    if (data.state === "failed") throw new Error(text(data.error) ? data.error : "登录未完成，请重新扫码。");
    if (data.state !== "waiting") throw new Error("未能核对登录状态。");
    if (screenshot(data.image)) onImage?.(data.image);
    await waitForPoll(signal);
  }
  throw new Error("扫码等待已超时，请取消本次登录后重新开始。");
}

export async function cancelXiaohongshuLogin(connection: CloudConnection, loginRequestId: string): Promise<boolean> {
  // An explicitly rejected create never owns a remote login to cancel.
  if (loginOutcomes.get(loginRequestId)?.rejected) return true;
  const data = await request(connection, `/logins/${encodeURIComponent(loginRequestId)}/cancel`, {});
  if (!record(data) || typeof data.cancelled !== "boolean") throw new Error("尚未确认登录是否结束，请再次取消登录。");
  if (!data.cancelled && !loginOutcomes.get(loginRequestId)?.account) {
    try {
      const latest = await request(connection, `/logins/${encodeURIComponent(loginRequestId)}`);
      if (record(latest) && latest.state === "complete") await saveAccountResult(latest, "xiaohongshu");
      else if (record(latest) && latest.state === "waiting") throw new Error("登录仍在等待，请再次取消登录。");
    } catch (error) { if (!(error instanceof CloudRequestError && error.status === 404)) throw error; }
  }
  loginOutcomes.delete(loginRequestId);
  return data.cancelled;
}

export async function removeAccount(connection: CloudConnection, accountId: string): Promise<void> {
  const credential = await getCredential(accountId);
  if (!credential) return;
  if ((await withPendingAccounts([credential.account])).some((account) => account.id === accountId && account.syncBlocked)) throw new Error("此账号还有待核对的同步，请先记录实际结果。");
  const data = await request(connection, "/accounts/remove", { envelope: credential.envelope });
  if (!record(data) || data.removed !== true) throw new Error("尚未确认账号移除完成。");
  await deleteCredential(accountId);
}

export async function acknowledgeUnconfirmed(connection: CloudConnection, accountId: string, outcome: "saved" | "not_saved", serverRequestId?: string): Promise<void> {
  const credential = await getCredential(accountId);
  if (!credential) throw new Error("请先重新连接此平台账号，再记录核对结果。上次同步仍保持锁定。");
  const pendingRequestId = await getPendingRequestId(credential.account);
  const requestId = pendingRequestId || serverRequestId || credential.account.pendingJobId;
  if (!requestId) throw new Error("无法确定待核对的任务，请刷新账号后重新核对。");
  const data = await request(connection, "/jobs/acknowledge", { envelope: credential.envelope, outcome, requestId });
  if (!record(data) || data.acknowledged !== true) throw new Error("尚未确认核对结果已记录，账号仍保持锁定。");
  await saveCredential({ ...credential.account, syncBlocked: false, pendingJobId: undefined }, text(data.envelope) ? data.envelope : credential.envelope);
  await unlockSync(credential.account, pendingRequestId);
}

async function encodeImage(image: DraftImage) {
  const bytes = new Uint8Array(await image.blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return { id: image.id, name: image.name, mime: image.blob.type, width: image.width, height: image.height, base64: btoa(binary) };
}

export async function syncDraft(connection: CloudConnection, account: DraftAccount, content: DraftContent, images: DraftImage[], onPreview?: (preview: JobPreview) => void): Promise<SyncReceipt> {
  const uncertain = (message = "保存结果尚未确认。请先检查平台草稿与临时核对页面，再如实确认已保存或未保存；核对前不能再次同步。"): SyncReceipt => ({ accountId: account.id, platform: account.platform, status: "needs_confirmation", message });
  const requestId = crypto.randomUUID();
  const credential = await getCredential(account.id);
  if (!credential) return { accountId: account.id, platform: account.platform, status: "failed", message: "浏览器未保留此账号的加密授权包。此次未发送，请重新连接账号。" };
  const payload = { requestId, envelope: credential.envelope, content, images: await Promise.all(images.map(encodeImage)) };
  // A durable marker is required even when the envelope itself is memory-only.
  try { await lockSync(account, requestId); }
  catch { return uncertain("浏览器未能建立同步记录，或另一页面已有待核对的同步。此次未发送，请刷新账号并核对已有结果。"); }
  let jobId = requestId;
  try {
    const started = await request(connection, "/jobs", payload, 90000);
    if (record(started) && text(started.id)) jobId = started.id;
  } catch (error) {
    if (error instanceof CloudRequestError && error.status >= 400 && error.status < 500) {
      // The API rejects these before creating a job. Persist the usable package
      // before clearing only this request's marker; another tab may have moved on.
      try {
        await saveCredential(account, credential.envelope);
        await unlockSync(account, requestId);
        return { accountId: account.id, platform: account.platform, status: "failed", message: `同步服务未接受此次保存：${error.message}` };
      } catch { return uncertain("同步服务未接受此次保存，但浏览器未能完成记录更新。请刷新账号核对，暂不重试。"); }
    }
    // Reconcile this identifier with GET; never repeat the POST.
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const job = await request(connection, `/jobs/${encodeURIComponent(jobId)}`);
      if (!record(job)) return uncertain();
      const preview = { ...(screenshot(job.image) ? { image: job.image } : {}), ...(typeof job.expiresAt === "number" && Number.isFinite(job.expiresAt) ? { expiresAt: job.expiresAt } : {}) };
      if (preview.image || preview.expiresAt) onPreview?.(preview);
      if (text(job.envelope)) await saveCredential(account, job.envelope);
      if (job.state === "finished") {
        const receipt = readReceipt(job.receipt, account);
        if (!receipt) return uncertain();
        if (receipt.status === "saved" || receipt.status === "failed") {
          if (!text(job.envelope)) return uncertain("已收到平台结果，但未取得更新后的授权包。请先核对结果，账号暂时保持锁定。");
          await unlockSync(account, requestId);
        }
        return receipt;
      }
      if (job.state !== "running") return uncertain();
    } catch { return uncertain(); }
    await waitForPoll();
  }
  return uncertain();
}
