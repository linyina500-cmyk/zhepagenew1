"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";
import { acknowledgeUnconfirmed, addWechatAccount, addXiaohongshuAccount, listAccounts, removeAccount, syncDraft, type CompanionConnection } from "../../lib/draftSync/companionClient";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from "../../lib/draftSync/localDraftStore";
import type { DraftAccount, DraftImage, DraftPlatform, LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { countCharacters, DRAFT_LIMITS, imageMetadata, readDraftImage, validateDraft } from "../../lib/draftSync/validation";

type DraftSyncDialogProps = {
  open: boolean;
  openerRef: RefObject<HTMLButtonElement | null>;
  title: string;
  sourceFormat: string;
  canCollect: boolean;
  collectAssets: () => Promise<DraftImage[]>;
  onClose: () => void;
  onReturnToEditor: () => void;
};
type Feedback = { tone: "neutral" | "success" | "error"; text: string };
const PLATFORMS: DraftPlatform[] = ["xiaohongshu", "wechat"];
const RECEIPT_LABELS: Record<SyncReceipt["status"], string> = { saved: "已保存平台草稿", confirmed_by_user: "用户确认已保存", needs_confirmation: "待核实", failed: "未保存" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";

function DraftThumbnail({ image, index }: { image: DraftImage; index: number }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const node = imageRef.current;
    if (!node) return;
    const url = URL.createObjectURL(image.blob);
    node.src = url;
    return () => { node.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [image.blob]);
  // Generated local Blobs need their exact dimensions, without an image proxy.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imageRef} alt={`草稿图片 ${index + 1}：${image.name}`} width={image.width} height={image.height} />;
}

export default function DraftSyncDialog({ open, openerRef, title, sourceFormat, canCollect, collectAssets, onClose, onReturnToEditor }: DraftSyncDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementIdRef = useRef<string | null>(null);
  const operationRef = useRef(false);
  const loadStartedRef = useRef(false);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState("");
  const [platform, setPlatform] = useState<DraftPlatform>("xiaohongshu");
  const [pairingCode, setPairingCode] = useState("");
  const [connection, setConnection] = useState<CompanionConnection | null>(null);
  const [accounts, setAccounts] = useState<DraftAccount[]>([]);
  const [accountName, setAccountName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [pendingChecks, setPendingChecks] = useState<Record<string, SyncReceipt>>({});
  const [acceptedWarnings, setAcceptedWarnings] = useState("");
  const [contentChanged, setContentChanged] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    // Pointer activation does not focus buttons in every browser. Retain the
    // explicit trigger instead of guessing it from document.activeElement.
    const opener = openerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, openerRef]);

  async function readStoredDraft() {
    setStorageState("loading");
    setStorageError("");
    try {
      const saved = await loadLocalDraft();
      setStoredDraft(saved);
      setStorageState("ready");
    } catch (error) {
      setStorageState("error");
      setStorageError(errorMessage(error));
    }
  }

  useEffect(() => {
    if (!open || loadStartedRef.current) return;
    loadStartedRef.current = true;
    // Storage is loaded only on the first user-opened dialog, never written here.
    void Promise.resolve().then(readStoredDraft);
  }, [open]);

  function queueSave(snapshot: LocalDraft) {
    const pending = saveChainRef.current.catch(() => {}).then(() => saveLocalDraft(snapshot));
    saveChainRef.current = pending;
    return pending.then(() => { setStoredDraft(snapshot); setStorageState("ready"); setStorageError(""); });
  }

  useEffect(() => {
    if (!autoSave || !draft) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      queueSave(draft).then(() => {
        if (!cancelled) setArchiveFeedback({ tone: "success", text: "已自动存到本机" });
      }).catch((error) => {
        if (!cancelled) setArchiveFeedback({ tone: "error", text: errorMessage(error) });
      });
    }, 600);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autoSave, draft]);

  async function runOperation(label: string, operation: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(label);
    setFeedback(null);
    try { await operation(); }
    catch (error) { setFeedback({ tone: "error", text: errorMessage(error) }); }
    finally { operationRef.current = false; setBusy(""); }
  }

  function updateDraft(update: (current: LocalDraft) => LocalDraft) {
    setDraft((current) => current ? { ...update(current), updatedAt: new Date().toISOString() } : null);
    setContentChanged(true);
    setArchiveFeedback(null);
  }

  function applyAccounts(next: DraftAccount[]) {
    setAccounts(next);
    // An old local receipt cannot restore a lock already resolved in the
    // companion. Keep its historical outcome unknown and never retry here.
    setPendingChecks((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !next.some((account) => account.id === id && account.syncBlocked === false))));
  }

  function useStoredDraft() {
    if (!storedDraft) return;
    setDraft(storedDraft);
    setContentChanged(false);
    setAcceptedWarnings("");
    setFeedback({ tone: "success", text: "已恢复本机存档，未重新生成或替换图片" });
  }

  function createDraft() {
    void runOperation("正在生成当前图片…", async () => {
      const images = await collectAssets();
      const initialTitle = title.replace(/\s*\n\s*/g, " ").trim();
      setDraft({
        schemaVersion: 1, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), sourceFormat, images,
        content: { xiaohongshu: { title: initialTitle, body: "" }, wechat: { title: initialTitle, body: "" } },
        selectedAccountIds: [], receipts: [],
      });
      setContentChanged(false);
      setAcceptedWarnings("");
      setArchiveFeedback(null);
      setFeedback({ tone: "success", text: `已准备 ${images.length} 张图片。请分别检查平台标题、文案和账号` });
    });
  }

  function saveDraft() {
    if (!draft) return;
    setArchiveFeedback(null);
    void runOperation("正在存到本机…", async () => {
      await queueSave(draft);
      setArchiveFeedback({ tone: "success", text: "图片、文案和账号选择已存到当前浏览器" });
    });
  }

  function deleteArchive() {
    setAutoSave(false);
    void runOperation("正在删除本机存档…", async () => {
      await saveChainRef.current.catch(() => {});
      await clearLocalDraft();
      setStoredDraft(null);
      setStorageState("ready");
      setStorageError("");
      setArchiveFeedback({ tone: "success", text: "本机存档已删除。当前窗口中的编辑仍可继续" });
    });
  }

  async function connectAssistant(event: FormEvent) {
    event.preventDefault();
    if (!pairingCode.trim()) return;
    const next = { token: pairingCode.trim() };
    await runOperation("正在连接本机助手…", async () => {
      const nextAccounts = await listAccounts(next);
      setConnection(next);
      applyAccounts(nextAccounts);
      setPairingCode("");
      setFeedback({ tone: "success", text: "已连接本机助手，配对码仅保留在当前窗口内存" });
    });
  }

  function addAccount() {
    if (!connection) return;
    const label = accountName.trim();
    const credentials = { appId: appId.trim(), appSecret: appSecret.trim() };
    setAppSecret("");
    void runOperation(platform === "wechat" ? "正在验证公众号…" : "请在独立登录窗口扫码…", async () => {
      try {
        const account = platform === "wechat"
          ? await addWechatAccount(connection, { displayName: label, ...credentials })
          : await addXiaohongshuAccount(connection, label);
        setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
        setAccountName("");
        setAppId("");
        setFeedback({ tone: "success", text: `${account.displayName} 已添加，请勾选需要同步的账号` });
      } finally { setAppSecret(""); }
    });
  }

  function deleteAccount(account: DraftAccount) {
    if (!connection) return;
    void runOperation("正在移除账号…", async () => {
      await removeAccount(connection, account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
      updateDraft((current) => ({ ...current, selectedAccountIds: current.selectedAccountIds.filter((id) => id !== account.id) }));
      setFeedback({ tone: "success", text: `${account.displayName} 已从本机助手移除` });
    });
  }

  function selectFiles(replacementId: string | null) {
    replacementIdRef.current = replacementId;
    if (fileInputRef.current) {
      fileInputRef.current.multiple = replacementId === null;
      fileInputRef.current.click();
    }
  }

  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const replacementId = replacementIdRef.current;
    void runOperation("正在读取本机图片…", async () => {
      const images: DraftImage[] = [];
      for (const file of files) images.push(await readDraftImage(file));
      updateDraft((current) => ({
        ...current,
        images: replacementId
          ? current.images.map((image) => image.id === replacementId ? images[0] : image)
          : [...current.images, ...images],
      }));
      setFeedback({ tone: "success", text: replacementId ? "图片已替换，未裁剪原图" : `已添加 ${images.length} 张图片，未裁剪原图` });
    });
  }

  function moveImage(index: number, direction: -1 | 1) {
    updateDraft((current) => {
      const images = [...current.images];
      const next = index + direction;
      if (next < 0 || next >= images.length) return current;
      [images[index], images[next]] = [images[next], images[index]];
      return { ...current, images };
    });
  }

  const selectedAccounts = accounts.filter((account) => draft?.selectedAccountIds.includes(account.id));
  const selectedPlatforms = PLATFORMS.filter((target) => selectedAccounts.some((account) => account.platform === target));
  const checkedPlatforms = selectedPlatforms.length ? selectedPlatforms : [platform];
  const metadata = useMemo(() => draft?.images.map(imageMetadata) || [], [draft?.images]);
  const issues = draft ? checkedPlatforms.flatMap((target) => validateDraft(target, draft.content[target], metadata).map((issue) => ({ ...issue, platform: target }))) : [];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const warningsKey = JSON.stringify({ metadata, warnings: warnings.map(({ platform, code, imageId }) => ({ platform, code, imageId })) });
  const unknownAccounts = draft?.selectedAccountIds.filter((id) => !accounts.some((account) => account.id === id)) || [];
  const unresolvedSelection = selectedAccounts.some((account) => pendingChecks[account.id] || account.syncBlocked);
  const canSync = Boolean(connection && draft && selectedAccounts.length && !unknownAccounts.length && selectedAccounts.every((account) => account.ready) && !errors.length && (!warnings.length || acceptedWarnings === warningsKey) && !unresolvedSelection && !busy);

  function submitDraft() {
    if (!connection || !draft || !canSync) return;
    const snapshot = draft;
    const connectionSnapshot = connection;
    void runOperation("正在核对所选账号…", async () => {
      const currentAccounts = await listAccounts(connectionSnapshot);
      applyAccounts(currentAccounts);
      const targets = snapshot.selectedAccountIds.map((id) => currentAccounts.find((account) => account.id === id));
      if (targets.some((account) => !account?.ready || account.syncBlocked || pendingChecks[account.id])) throw new Error("部分所选账号不可用或仍待核实，请检查账号后重试");
      setContentChanged(false);
      for (const target of targets) {
        if (!target) continue;
        const before = selectedAccounts.find((account) => account.id === target.id);
        if (!before || before.remoteId !== target.remoteId || before.platform !== target.platform) throw new Error("账号身份已变化，已停止剩余同步。请重新核对所选账号");
        setBusy(`正在同步到 ${target.displayName}…`);
        let receipt: SyncReceipt;
        try { receipt = await syncDraft(connectionSnapshot, target, snapshot.content[target.platform], snapshot.images); }
        catch (error) { receipt = { accountId: target.id, platform: target.platform, status: "needs_confirmation", message: `同步未完成确认：${errorMessage(error)}。请先在平台核对草稿。` }; }
        if (receipt.accountId !== target.id || receipt.platform !== target.platform || !["saved", "confirmed_by_user", "needs_confirmation", "failed"].includes(receipt.status) || (receipt.status === "saved" && !receipt.draftId)) {
          receipt = { accountId: target.id, platform: target.platform, status: "needs_confirmation", message: "收到的结果缺少匹配的账号或草稿凭据，请先在平台核对" };
        }
        if (receipt.status === "needs_confirmation") setPendingChecks((current) => ({ ...current, [target.id]: receipt }));
        const result = receipt;
        setDraft((current) => current && current.id === snapshot.id ? {
          ...current, updatedAt: new Date().toISOString(),
          selectedAccountIds: result.status === "saved" || result.status === "confirmed_by_user" ? current.selectedAccountIds.filter((id) => id !== target.id) : current.selectedAccountIds,
          receipts: [...current.receipts.filter((item) => item.accountId !== target.id), result],
        } : current);
      }
      setFeedback({ tone: "neutral", text: "所选账号已处理，已保存的账号已取消勾选。请查看逐个结果，待核实项目先到平台检查" });
    });
  }

  function confirmOutcome(accountId: string, outcome: "saved" | "not_saved") {
    const account = accounts.find((item) => item.id === accountId);
    if (!connection || !account || (!pendingChecks[accountId] && !account.syncBlocked)) return;
    void runOperation("正在记录核对结果…", async () => {
      await acknowledgeUnconfirmed(connection, accountId, outcome);
      // A successful acknowledgement resolves the lock. An unrelated account
      // refresh must not turn that recorded outcome back into an uncertain save.
      setAccounts((current) => current.map((item) => item.id === accountId ? { ...item, syncBlocked: false } : item));
      setPendingChecks((current) => { const next = { ...current }; delete next[accountId]; return next; });
      const receipt: SyncReceipt = {
        accountId, platform: account.platform,
        status: outcome === "saved" ? "confirmed_by_user" : "failed",
        message: outcome === "saved" ? "你已在对应平台账号检查并确认草稿已保存。这是你的人工确认，本机助手未自动验证。" : "你已在对应平台账号检查并确认草稿未保存。现已解除该账号的重试限制，尚未再次发送。",
      };
      setDraft((current) => current ? {
        ...current, updatedAt: new Date().toISOString(),
        selectedAccountIds: outcome === "saved" ? current.selectedAccountIds.filter((id) => id !== accountId) : current.selectedAccountIds,
        receipts: [...current.receipts.filter((item) => item.accountId !== accountId), receipt],
      } : current);
      setFeedback({ tone: "neutral", text: outcome === "saved" ? `已记录你确认 ${account.displayName} 的草稿已保存，并取消该账号勾选。` : `已记录你确认 ${account.displayName} 的草稿未保存。需要重试时，请检查所选账号后点击同步。` });
    });
  }

  const limit = DRAFT_LIMITS[platform];
  const platformAccounts = accounts.filter((account) => account.platform === platform);
  const serverPending = accounts.filter((account) => account.syncBlocked && !pendingChecks[account.id]).map((account): SyncReceipt => ({ accountId: account.id, platform: account.platform, status: "needs_confirmation", message: "本机助手记录了一次未确认的同步。请先在对应平台账号检查草稿，再如实选择已保存或未保存；核对前不能再次同步。" }));
  const allReceipts = [...(draft?.receipts.filter((receipt) => !pendingChecks[receipt.accountId] && !serverPending.some((item) => item.accountId === receipt.accountId)) || []), ...Object.values(pendingChecks), ...serverPending];

  function closeDialog(returnToEditor = false) {
    if (operationRef.current) return;
    setAppSecret("");
    setPairingCode("");
    if (returnToEditor) onReturnToEditor(); else onClose();
  }

  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><span className="eyebrow">贴图准备完成后的下一步</span><h2 id="draft-sync-title">同步到平台草稿</h2><p id="draft-sync-description">图片和文案先在当前窗口编辑，确认后发往所选账号。平台发布仍由你完成。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" disabled={Boolean(busy)} onClick={() => closeDialog()}>×</button>
      </header>
      <div className="draft-sync-scroll">
        <section className="draft-sync-archive" aria-label="本机存档">
          <div><strong>{storedDraft ? "当前浏览器有一份本机存档" : "本机草稿"}</strong><p>{storedDraft ? `${storedDraft.images.length} 张图片 · ${new Date(storedDraft.updatedAt).toLocaleString("zh-CN")}` : "只有点击“存到本机”或开启自动存档后，才保存这份平台草稿。"}</p></div>
          <div className="draft-sync-inline-actions">
            {storedDraft && <button type="button" disabled={Boolean(busy)} onClick={useStoredDraft}>继续本机存档</button>}
            <button type="button" disabled={Boolean(busy) || !canCollect || storageState === "loading"} onClick={createDraft}>{draft ? "用当前图片新建" : "用当前图片新建草稿"}</button>
            {(storedDraft || storageState === "error") && <button type="button" className="draft-sync-danger" disabled={Boolean(busy)} onClick={deleteArchive}>删除本机存档</button>}
          </div>
          {storageState === "loading" && <p role="status">正在检查本机存档…</p>}
          {storageError && <div className="draft-sync-message error" role="alert">{storageError}<button type="button" disabled={Boolean(busy)} onClick={() => void readStoredDraft()}>重新读取</button></div>}
          {!canCollect && <p>当前海报正在处理，排版完成后可生成新草稿；仍可继续已有存档。</p>}
          {archiveFeedback && <p className={`draft-sync-message ${archiveFeedback.tone}`} role="status">{archiveFeedback.text}</p>}
        </section>

        {!draft ? <div className="draft-sync-empty"><span aria-hidden="true">01 → 02</span><h3>选择要继续编辑的图片</h3><p>新建时会生成当前海报的独立副本。已有存档由你选择是否继续，不会自动覆盖。</p></div> : <div className="draft-sync-columns">
          <section className="draft-sync-assets" aria-labelledby="draft-sync-assets-title">
            <div className="draft-sync-section-title"><div><h3 id="draft-sync-assets-title">图片素材 <span>{draft.images.length} 张</span></h3><p>首图作为封面，两平台使用同一组图片。可替换、增删和调整顺序。</p></div><button type="button" disabled={Boolean(busy)} onClick={() => selectFiles(null)}>＋ 添加图片</button></div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" hidden onChange={onFilesSelected} aria-label="草稿图片文件" />
            <ol className="draft-sync-image-list">
              {draft.images.map((image, index) => <li key={image.id} className="draft-sync-image-card" data-image-name={image.name}>
                <div className="draft-sync-image-preview"><DraftThumbnail image={image} index={index} /><span>{index === 0 ? "01 · 封面" : String(index + 1).padStart(2, "0")}</span></div>
                <div className="draft-sync-image-info"><b title={image.name}>{image.name}</b><small>{image.width} × {image.height} · {(image.blob.size / 1024 / 1024).toFixed(2)} MB</small></div>
                <div className="draft-sync-image-actions">
                  <button type="button" disabled={Boolean(busy) || index === 0} onClick={() => moveImage(index, -1)} aria-label={`前移第 ${index + 1} 张图片`}>←</button>
                  <button type="button" disabled={Boolean(busy) || index === draft.images.length - 1} onClick={() => moveImage(index, 1)} aria-label={`后移第 ${index + 1} 张图片`}>→</button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => selectFiles(image.id)} aria-label={`替换第 ${index + 1} 张图片`}>替换</button>
                  <button type="button" disabled={Boolean(busy)} onClick={() => updateDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))} aria-label={`删除第 ${index + 1} 张图片`}>删除</button>
                </div>
              </li>)}
            </ol>
            {!draft.images.length && <p className="draft-sync-message neutral">还没有图片，请添加本机图片，或用当前海报新建草稿。</p>}
            <button type="button" className="draft-sync-return" disabled={Boolean(busy)} onClick={() => closeDialog(true)}>返回工作台调整海报尺寸</button>
            <p className="draft-sync-small">此处修改只影响草稿副本；重新排版后，可选择“用当前图片新建”更新整组素材。</p>
          </section>

          <section className="draft-sync-editor" aria-label="平台文案和账号">
            <div className="draft-sync-platforms" role="group" aria-label="选择文案平台">{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(busy)} onClick={() => { setPlatform(target); setAppSecret(""); }}>{DRAFT_LIMITS[target].label}<span>{accounts.filter((account) => account.platform === target && draft.selectedAccountIds.includes(account.id)).length} 个账号</span></button>)}</div>
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }))} /><small>{countCharacters(draft.content[platform].title)} / {limit.title} 字（本工具上限）</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={6} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="为这个平台写一段配文" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }))} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字{platform === "wechat" ? ` · ${new TextEncoder().encode(draft.content.wechat.body).length} / 2,048 字节` : ""}；两个平台分别保存文案</small></div>
            <div className="draft-sync-account-heading"><h3>选择同步账号</h3>{connection && <button type="button" disabled={Boolean(busy)} onClick={() => void runOperation("正在刷新账号…", async () => { applyAccounts(await listAccounts(connection)); })}>刷新账号</button>}</div>
            {!connection ? <p className="draft-sync-small">连接下方本机助手后，可添加并选择账号。</p> : !platformAccounts.length ? <p className="draft-sync-small">尚未添加{limit.label}账号，可在下方添加。</p> : <div className="draft-sync-accounts">{platformAccounts.map((account) => <div key={account.id} className="draft-sync-account-row"><label htmlFor={`draft-account-${account.id}`} aria-label={`选择同步账号 ${account.displayName}`}><input id={`draft-account-${account.id}`} type="checkbox" checked={draft.selectedAccountIds.includes(account.id)} disabled={Boolean(busy) || ((!account.ready || Boolean(pendingChecks[account.id]) || account.syncBlocked) && !draft.selectedAccountIds.includes(account.id))} onChange={(event) => updateDraft((current) => ({ ...current, selectedAccountIds: event.target.checked ? [...new Set([...current.selectedAccountIds, account.id])] : current.selectedAccountIds.filter((id) => id !== account.id) }))} /><span><b>{account.displayName}</b><small>{pendingChecks[account.id] || account.syncBlocked ? "上次结果待核实" : account.ready ? account.remoteId : "需要重新登录"}</small></span></label><button type="button" className="draft-sync-text-button" disabled={Boolean(busy) || Boolean(pendingChecks[account.id]) || account.syncBlocked} onClick={() => deleteAccount(account)} aria-label={`移除账号并删除本机登录状态 ${account.displayName}`} title="移除账号并删除本机登录状态">移除</button></div>)}</div>}
            {!!unknownAccounts.length && <div className="draft-sync-message error">存档中有 {unknownAccounts.length} 个账号尚未连接，请重新连接对应账号或清除选择。<button type="button" disabled={Boolean(busy)} onClick={() => updateDraft((current) => ({ ...current, selectedAccountIds: current.selectedAccountIds.filter((id) => !unknownAccounts.includes(id)) }))}>清除不可用账号选择</button></div>}
          </section>
        </div>}

        <details className="draft-sync-connection" open={!connection || accounts.length === 0}>
          <summary>{connection ? "本机助手已连接 · 管理账号" : "连接本机助手"}<span>凭证保留在本机</span></summary>
          <div className="draft-sync-connection-content">
            <p className="draft-sync-small">本机助手是在电脑上运行的同步程序，负责连接平台账号；登录资料留在本机。</p>
            <details className="draft-sync-start-help">
              <summary>开发版如何启动</summary>
              <ol><li>在项目目录打开终端，运行 <code>npm run draft:helper</code>。</li><li>保持该窗口打开，复制启动时显示的配对码，粘贴到下方并连接。</li></ol>
              <p>当前开发版只允许本机开发页连接。需要时允许浏览器访问本地网络。</p>
            </details>
            <form onSubmit={connectAssistant} className="draft-sync-connect-form"><label htmlFor="draft-pairing-code">本机助手配对码</label><div><input id="draft-pairing-code" type="password" autoComplete="off" value={pairingCode} disabled={Boolean(busy)} onChange={(event) => setPairingCode(event.target.value)} placeholder="仅在当前窗口使用" /><button type="submit" disabled={Boolean(busy) || !pairingCode.trim()}>{connection ? "重新连接" : "连接助手"}</button></div></form>
            {connection && <div className="draft-sync-add-account"><h3>添加{limit.label}账号</h3><div className="field-stack"><label htmlFor="draft-account-name">账号备注</label><input id="draft-account-name" value={accountName} disabled={Boolean(busy)} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：品牌主账号" /></div>{platform === "wechat" ? <><div className="field-stack"><label htmlFor="draft-wechat-app-id">公众号 AppID</label><input id="draft-wechat-app-id" autoComplete="off" value={appId} disabled={Boolean(busy)} onChange={(event) => setAppId(event.target.value)} /></div><div className="field-stack"><label htmlFor="draft-wechat-secret">公众号 AppSecret</label><input id="draft-wechat-secret" type="password" autoComplete="new-password" value={appSecret} disabled={Boolean(busy)} onChange={(event) => setAppSecret(event.target.value)} /><small>仅交给本机助手进程使用，提交后清空输入框；助手重启后需重新添加。</small></div></> : <p className="draft-sync-small">会打开独立的小红书登录窗口，请在窗口内扫码。每个账号使用独立会话。</p>}<button type="button" disabled={Boolean(busy) || !accountName.trim() || (platform === "wechat" && (!appId.trim() || !appSecret.trim()))} onClick={addAccount}>{platform === "wechat" ? "验证并添加公众号" : "扫码添加小红书账号"}</button></div>}
          </div>
        </details>

        {draft && !!issues.length && <section className="draft-sync-validation" aria-label="同步前检查"><h3>同步前检查</h3><ul>{issues.map((issue, index) => <li key={`${issue.platform}-${issue.code}-${issue.imageId || index}`} className={issue.severity}><b>{DRAFT_LIMITS[issue.platform].label}：</b>{issue.message}</li>)}</ul>{!!warnings.length && <label className="draft-sync-check"><input type="checkbox" checked={acceptedWarnings === warningsKey} disabled={Boolean(busy)} onChange={(event) => setAcceptedWarnings(event.target.checked ? warningsKey : "")} /><span>我已核对图片，沿用当前尺寸和比例</span></label>}</section>}

        {!!allReceipts.length && <section className="draft-sync-results" aria-label="账号同步结果">
          <h3>{contentChanged ? "上次同步结果（当前编辑尚未同步）" : "账号同步结果"}</h3>
          {allReceipts.map((receipt) => {
            const account = accounts.find((item) => item.id === receipt.accountId);
            const accountLabel = account?.displayName || `${DRAFT_LIMITS[receipt.platform].label}账号`;
            const needsCheck = receipt.status === "needs_confirmation" && Boolean(pendingChecks[receipt.accountId] || account?.syncBlocked);
            const historical = receipt.status === "needs_confirmation" && account?.syncBlocked === false && !needsCheck;
            return <article key={receipt.accountId} className={`draft-sync-receipt ${receipt.status}`} data-account-id={receipt.accountId} aria-label={`${accountLabel}的同步结果`}>
              <div><strong>{accountLabel}</strong><b>{historical ? "历史回执" : RECEIPT_LABELS[receipt.status]}</b></div>
              <p>{historical ? `存档中的记录：${receipt.message}` : receipt.message}</p>
              {receipt.draftId && <small>草稿编号：{receipt.draftId}</small>}
              <a className="draft-sync-platform-link" href={receipt.platform === "wechat" ? "https://mp.weixin.qq.com/" : "https://creator.xiaohongshu.com/"} target="_blank" rel="noopener noreferrer">{receipt.platform === "wechat" ? "打开公众号后台" : "打开小红书创作平台"}</a>
              {historical && <p>历史回执，助手当前已解除锁定。本工具无法确认当时是否保存，请在平台检查；未自动重试。</p>}
              {needsCheck && <>
                <p>请先打开 {accountLabel} 的平台草稿列表，检查此次标题和图片。只有完成核对后，才选择与实际情况一致的结果。</p>
                <div className="draft-sync-confirm-actions">
                  <button type="button" disabled={Boolean(busy) || !connection || !account} onClick={() => confirmOutcome(receipt.accountId, "saved")}>已在平台核对，确认已保存</button>
                  <button type="button" disabled={Boolean(busy) || !connection || !account} onClick={() => confirmOutcome(receipt.accountId, "not_saved")}>已在平台核对，确认未保存</button>
                </div>
              </>}
            </article>;
          })}
        </section>}
      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy} 完成后可关闭窗口。</p> : feedback ? <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : <p>尚未同步到任何平台</p>}{draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}</div>
        <div className="draft-sync-footer-actions"><button type="button" disabled={Boolean(busy) || !draft} onClick={saveDraft}>存到本机</button><button type="button" className="primary" disabled={!canSync} onClick={submitDraft}>同步到 {selectedAccounts.length} 个账号草稿</button></div>
      </footer>
    </div>
  </dialog>;
}
