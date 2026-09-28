import { SELECTORS, readAccountEvidence, readLoginEvidence, readPageEvidence, readImageFingerprints,
  saveNativeDraft, draftPageCommand, compareDraftEvidence, validDraftRef } from "./xhs-dom.mjs";

export const XHS_ORIGIN = "https://creator.xiaohongshu.com";
const HOME = `${XHS_ORIGIN}/new/home`;
const EDITOR = `${XHS_ORIGIN}/publish/publish?from=menu_left&target=image`;
const IMAGE_KEY = /^pixels:[1-9]\d*x[1-9]\d*:[a-f0-9]{64}$/u;
const SESSION_OWNERS = "zhepage:xhs:owned-tabs";
export class XhsError extends Error {
  constructor(message, status = 409) { super(message); this.name = "XhsError"; this.status = status; }
}
const hexHash = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export function createXhsBrowser({ store, chromeApi = globalThis.chrome, timeoutMs = 60_000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!store || !chromeApi?.tabs || !chromeApi?.scripting || !chromeApi?.storage?.session) throw new TypeError("小红书扩展配置不完整");
  async function newTab(url, active = false) {
    const tab = await chromeApi.tabs.create({ url, active });
    if (!Number.isInteger(tab.id)) throw new XhsError("小红书标签页未能打开，请重新点击登录。", 503);
    const owners = (await chromeApi.storage.session.get(SESSION_OWNERS))[SESSION_OWNERS] || {};
    const owner = crypto.randomUUID(); owners[tab.id] = owner;
    await chromeApi.storage.session.set({ [SESSION_OWNERS]: owners });
    const ref = { id: tab.id, owner };
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    while (Date.now() < deadline) {
      const current = await chromeApi.tabs.get(tab.id);
      if (current.url && new URL(current.url).origin === XHS_ORIGIN) return ref;
      if (current.url && current.url !== "about:blank" && !current.pendingUrl?.startsWith(`${XHS_ORIGIN}/`)) break;
      await pause(100);
    }
    throw new XhsError("小红书标签页暂时打不开，请检查网络后重试。", 503);
  }
  async function owned(ref) {
    const owners = (await chromeApi.storage.session.get(SESSION_OWNERS))[SESSION_OWNERS] || {};
    if (!ref || owners[ref.id] !== ref.owner) throw new XhsError("原同步标签页已关闭或浏览器已重启，请先核对草稿箱。");
    let tab;
    try { tab = await chromeApi.tabs.get(ref.id); } catch { throw new XhsError("小红书同步标签页已关闭，请重新打开登录页。"); }
    if (!tab.url || new URL(tab.url).origin !== XHS_ORIGIN) throw new XhsError("小红书标签页未正常加载，请检查网络和登录状态。");
    return tab;
  }
  async function close(ref) {
    // Only close a tab created by this extension in this browser session.
    try {
      await owned(ref); await chromeApi.tabs.remove(ref.id);
      const owners = (await chromeApi.storage.session.get(SESSION_OWNERS))[SESSION_OWNERS] || {};
      if (owners[ref.id] === ref.owner) { delete owners[ref.id]; await chromeApi.storage.session.set({ [SESSION_OWNERS]: owners }); }
    } catch { /* Preserve unrelated/replaced tabs. */ }
  }
  async function inject(ref, func, arg, world = "ISOLATED") {
    await owned(ref);
    try {
      const results = await chromeApi.scripting.executeScript({ target: { tabId: ref.id, frameIds: [0] }, world, func, args: arg === undefined ? [] : [arg] });
      if (results.length !== 1 || results[0].frameId !== 0 || results[0].error) throw new Error("missing frame result");
      return results[0].result;
    } catch { throw new XhsError("小红书页面未能完成操作，请检查同步标签页；本次不会重复上传或保存。"); }
  }
  async function readAccount(ref) {
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    while (Date.now() < deadline) {
      try {
        const tab = await owned(ref), url = new URL(tab.url);
        if (url.pathname.startsWith("/login")) {
          const login = await inject(ref, readLoginEvidence);
          if (login?.loginVisible) return { status: "login_required", message: "请在打开的小红书标签页扫码，完成后点击“我已登录”。" };
        } else if (url.pathname === "/new/home") {
          const value = await inject(ref, readAccountEvidence);
          const after = new URL((await owned(ref)).url);
          if (value && after.pathname === "/new/home") return { status: "connected", account: { id: (await hexHash(`xiaohongshu-account:${value.identifier}`)).slice(0, 20), name: value.name } };
        }
      } catch { /* Read-only navigation races can be retried within the deadline. */ }
      await pause(250);
    }
    return { status: "needs_attention", message: "小红书页面尚未正常加载，请检查刚打开的标签页后重试。当前没有上传图片。" };
  }
  async function accountState() {
    const ref = await newTab(HOME);
    try { return await readAccount(ref); } finally { await close(ref); }
  }
  async function requireAccount(account) {
    const state = await accountState();
    if (state.status !== "connected" || state.account.id !== account.id) throw new XhsError("小红书登录账号发生变化或尚未确认，请先核对账号。内容已保留。");
  }
  async function state(ref, pixels = true) {
    const before = await inject(ref, readPageEvidence, { selectors: SELECTORS });
    if (pixels && before.images.length && before.images.every((image) => image.loaded && !image.processing && !image.failed)) {
      const keys = await inject(ref, readImageFingerprints, { selectors: SELECTORS });
      const after = await inject(ref, readPageEvidence, { selectors: SELECTORS });
      if (JSON.stringify(before) !== JSON.stringify(after)) { after.images.forEach((image) => { image.key = null; image.processing = true; }); return after; }
      if (Array.isArray(keys) && keys.length === before.images.length) before.images.forEach((image, index) => { image.key = keys[index]; });
    }
    return before;
  }
  const hasContent = (value) => value.images.length > 0 || Boolean(value.title?.trim()) || Boolean(value.body?.trim()) || value.blocked;
  async function command(ref, action, args = {}) {
    const result = await inject(ref, draftPageCommand, { action, selectors: SELECTORS, ...args });
    if (!result?.ok) throw new XhsError("小红书编辑区发生变化或有待处理提示，请核对同步标签页。原内容已保留。");
    return result;
  }
  async function navigateEmptyEditor(ref) {
    await owned(ref);
    const before = await state(ref, false);
    if (hasContent(before)) throw new XhsError("小红书恢复了已有编辑内容，请先处理该页面。原内容已保留。");
    await chromeApi.tabs.update(ref.id, { url: EDITOR });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await owned(ref);
        if (tab.status === "complete" && new URL(tab.url).pathname === "/publish/publish") {
          const current = await state(ref, false);
          if (hasContent(current)) throw new XhsError("小红书恢复了已有编辑内容，请先处理该页面。原内容已保留。");
          const meta = await command(ref, "list-state");
          if (meta.entryCount === 1 || meta.tabCount === 1) return;
        }
      } catch (error) { if (error instanceof XhsError && /已有编辑内容/u.test(error.message)) throw error; }
      await pause(250);
    }
    throw new XhsError("小红书图文编辑页未正常加载，请检查同步标签页。");
  }
  async function draftList(ref, prepared) {
    const deadline = Date.now() + timeoutMs;
    let opened = false, selected = false;
    while (Date.now() < deadline) {
      let meta;
      try { meta = await command(ref, "list-state"); } catch { await pause(250); continue; }
      if (meta.tabCount === 0 && meta.entryCount === 1 && !opened) { await command(ref, "open-drafts"); opened = true; }
      if (meta.tabCount === 1 && !selected) { await command(ref, "image-tab"); selected = true; }
      if (selected) {
        const current = await state(ref, false), drafts = current.drafts;
        const fresh = prepared ? drafts.filter((item) => !prepared.beforeIds.includes(item.id) && item.text === prepared.title.trim()) : [];
        if (Number.isSafeInteger(meta.count) && drafts.length === meta.count && new Set(drafts.map((item) => item.id)).size === meta.count && (!prepared || fresh.length === 1)) return drafts;
      }
      await pause(250);
    }
    throw new XhsError("小红书草稿列表尚未完整加载，请核对原任务，不要重复同步。");
  }
  async function waitImages(ref, count) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await owned(ref), url = new URL(tab.url);
      if (url.pathname !== "/publish/publish" || url.searchParams.get("target") !== "image") throw new XhsError("页面已离开图文编辑器，请核对同步标签页。");
      const current = await state(ref);
      if (current.images.some((image) => image.failed) || current.images.length > count) throw new XhsError("图片上传失败或数量发生变化，请检查同步标签页。不要重复提交。");
      if (!current.blocked && current.images.length === count && current.images.every((image) => image.ready && !image.processing)) return current;
      await pause(250);
    }
    throw new XhsError("小红书图片尚未处理完成，请核对同步标签页。原图已保留。");
  }
  async function refFor(record, create = false) {
    if (record.tab) { await owned(record.tab); return record.tab; }
    if (!create) throw new XhsError("此任务没有可核对的同步标签页，请先在小红书检查。");
    return newTab(EDITOR, true);
  }
  return {
    accountState,
    async openLogin() {
      // Always create a new tab. Never navigate the user's existing editor or
      // an old extension tab that might now contain unsaved manual changes.
      const ref = await newTab(HOME, true); await store.set("xhs:login-tab", ref);
      return readAccount(ref);
    },
    async prepare(record, update) {
      const account = { id: record.accountId, name: record.accountName };
      await requireAccount(account);
      const ref = await refFor(record, true); record.tab = ref; await update();
      await navigateEmptyEditor(ref);
      const before = await draftList(ref);
      await navigateEmptyEditor(ref);
      const keys = [];
      for (let index = 0; index < record.images.length; index++) {
        await requireAccount(account);
        const current = await state(ref);
        if (hasContent({ ...current, images: [] }) || current.images.length !== index || current.images.some((image, offset) => image.key !== keys[offset])) throw new XhsError("编辑内容或图片顺序发生变化，已停止本次导入。请核对同步标签页。");
        const image = record.images[index], bytes = new Uint8Array(await image.blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        // Mark every append boundary before the page sees it. A worker restart
        // must leave an uncertain job, never retry this DataTransfer dispatch.
        record.appendAttempted = index; await update();
        await command(ref, "upload", { image: { base64: btoa(binary), mime: image.mime, name: image.name }, expectedCount: index });
        const after = await waitImages(ref, index + 1);
        if (after.title?.trim() || after.body?.trim()) throw new XhsError("上传期间有人修改了文案，已保留该内容并停止导入。");
        if (after.images.slice(0, index).some((item, offset) => item.key !== keys[offset]) || !IMAGE_KEY.test(after.images[index].key ?? "")) throw new XhsError("图片内容或顺序未能核对，请检查同步标签页。");
        keys.push(after.images[index].key); record.uploadedCount = index + 1;
        record.message = `已导入 ${index + 1} / ${record.imageCount} 张图片`; await update();
      }
      await command(ref, "fill", { title: record.title, body: record.body });
      const final = await waitImages(ref, record.imageCount);
      if (final.title !== record.title || final.body !== record.body || final.images.some((image, index) => image.key !== keys[index])) throw new XhsError("填写后的标题、配文或图片未能核对一致，请检查同步标签页。");
      return { jobId: record.id, title: record.title, beforeIds: before.map((draft) => draft.id), images: keys };
    },
    async save(record, update) {
      if (record.saveAttempted) throw new XhsError("此任务已尝试暂存，不会重复保存。");
      await requireAccount({ id: record.accountId });
      const ref = await refFor(record), current = await waitImages(ref, record.imageCount);
      if (!compareDraftEvidence(current, { title: record.title, body: record.body, draftRef: record.prepared })) throw new XhsError("保存前内容发生变化，请核对同步标签页。");
      record.saveAttempted = true; await update();
      // MAIN is restricted to this fixed, audited native save function. The
      // closed-shadow element method cannot be accessed from ISOLATED.
      const result = await inject(ref, saveNativeDraft, undefined, "MAIN");
      if (result !== "invoked") throw new XhsError("暂存草稿按钮尚不可用，请核对同步标签页。本次不会重复点击。");
      const drafts = await draftList(ref, record.prepared);
      const created = drafts.filter((draft) => !record.prepared.beforeIds.includes(draft.id) && draft.text === record.title.trim());
      if (created.length !== 1) throw new XhsError("尚未确认唯一的新草稿，请在草稿箱核对。");
      return { draftId: created[0].id, draftRef: { kind: "local", id: created[0].id, images: record.prepared.images } };
    },
    async verify(record, update) {
      await requireAccount({ id: record.accountId });
      let ref;
      try { ref = await refFor(record); } catch (error) {
        // Session ownership deliberately expires when Chrome restarts. A known
        // durable draft can be read back in a new extension-owned editor; an
        // uncertain save without a draft reference must never be replayed.
        if (!validDraftRef(record.draftRef, record.imageCount) || typeof update !== "function") throw error;
        ref = await newTab(EDITOR, true);
        record.tab = ref; await update();
        await navigateEmptyEditor(ref);
      }
      const before = await state(ref, false);
      if (hasContent(before)) return { verified: false, message: "同步标签页中有编辑内容，请先核对并退出编辑，再重新核对。原内容已保留。" };
      let reference = record.draftRef;
      const drafts = await draftList(ref, !reference && record.saveAttempted ? record.prepared : undefined);
      if (!reference && record.saveAttempted && record.prepared) {
        const candidates = drafts.filter((draft) => !record.prepared.beforeIds.includes(draft.id) && draft.text === record.title.trim());
        if (candidates.length === 1) reference = { kind: "local", id: candidates[0].id, images: record.prepared.images };
      }
      if (!validDraftRef(reference, record.imageCount) || drafts.filter((draft) => draft.id === reference.id).length !== 1) return { verified: false, message: "尚未找到可核对的原草稿，请检查小红书草稿箱。不会重新上传或保存。" };
      await command(ref, "edit-draft", { draftId: reference.id });
      await requireAccount({ id: record.accountId });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = await state(ref);
        if (compareDraftEvidence(current, { title: record.title, body: record.body, draftRef: reference })) {
          // Content has been read back and is already durable. Clear only our
          // own verified editor view, leaving all user-created tabs untouched.
          await chromeApi.tabs.update(ref.id, { url: EDITOR });
          return { verified: true, draftId: reference.id, draftRef: reference, message: "已存入草稿箱，标题、配文和图片顺序已核对。" };
        }
        if (current.images.some((image) => image.failed) || current.images.length > record.imageCount) break;
        await pause(250);
      }
      return { verified: false, message: "草稿已暂存，但图片显示或内容尚未通过核对，请在同步标签页检查。" };
    },
  };
}
