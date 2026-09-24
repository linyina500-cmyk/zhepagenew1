"use client";

import { useEffect, useEffectEvent, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from "../../lib/draftSync/localDraftStore";
import type { DraftImage, DraftPlatform, LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { countCharacters, countHashtags, DRAFT_LIMITS, imageMetadata, readDraftImage, validateDraft } from "../../lib/draftSync/validation";
import { loadBinding, listAccounts, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";
import { usePlatformImages } from "../hooks/usePlatformImages";
import type { RiskNote } from "../../lib/draftSync/riskPage";
import { PLATFORM_IMAGE_SIZES } from "../../lib/draftSync/adaptImages";
import LocalSyncConnection from "./LocalSyncConnection";
import WechatDraftPanel from "./WechatDraftPanel";
import XiaohongshuDraftPanel from "./XiaohongshuDraftPanel";

type DraftSyncDialogProps = {
  open: boolean;
  openerRef: RefObject<HTMLButtonElement | null>;
  title: string;
  sourceFormat: string;
  canCollect: boolean;
  collectAssets: (options?: { editableRisk?: boolean }) => Promise<DraftImage[]>;
  riskNote?: RiskNote;
  onClose: () => void;
  onReturnToEditor: () => void;
};
type Feedback = { tone: "neutral" | "success" | "error"; text: string };
type OperationScope = DraftPlatform | "local";
const PLATFORMS: DraftPlatform[] = ["xiaohongshu", "wechat"];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";
const withReceipt = (draft: LocalDraft, receipt: SyncReceipt): LocalDraft => ({
  ...draft, updatedAt: new Date().toISOString(), selectedAccountIds: [],
  receipts: [...draft.receipts.filter((item) => (item.accountId !== receipt.accountId || item.platform !== receipt.platform)), receipt],
});

function DraftThumbnail({ image, index }: { image: DraftImage; index: number }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const node = imageRef.current;
    if (!node) return;
    const url = URL.createObjectURL(image.blob);
    node.src = url;
    return () => { node.removeAttribute("src"); URL.revokeObjectURL(url); };
  }, [image.blob]);
  // Preview the exact Blob passed to the selected platform.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imageRef} alt={`草稿图片 ${index + 1}：${image.name}`} width={image.width} height={image.height} />;
}

export default function DraftSyncDialog({ open, openerRef, title, sourceFormat, canCollect, collectAssets, riskNote, onClose, onReturnToEditor }: DraftSyncDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementIdRef = useRef<string | null>(null);
  const operationRef = useRef<Partial<Record<OperationScope, AbortController>>>({});
  const draftRef = useRef<LocalDraft | null>(null);
  const mountedRef = useRef(true);
  const loadStartedRef = useRef(false);
  const preparedForOpenRef = useRef(false);
  const previousSourceRef = useRef<{ title: string; risk?: RiskNote } | null>(null);
  const receiptSnapshotRef = useRef<LocalDraft | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [editingImages, setEditingImages] = useState(false);
  const [sourceReady, setSourceReady] = useState(false);
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedbackByPlatform, setFeedbackByPlatform] = useState<Partial<Record<DraftPlatform, Feedback | null>>>({});
  const [operations, setOperations] = useState<Partial<Record<OperationScope, string>>>({});
  const [platform, setPlatform] = useState<DraftPlatform>("xiaohongshu");
  const [confirmedRisk, setConfirmedRisk] = useState<Partial<Record<DraftPlatform, RiskNote>>>({});
  const [contentChanged, setContentChanged] = useState<Record<DraftPlatform, boolean>>({ xiaohongshu: false, wechat: false });
  const [binding, setBinding] = useState<Binding | null>(null);
  const [accounts, setAccounts] = useState<LocalWechatAccount[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");

  const feedback = feedbackByPlatform[platform];
  const busy = operations.local || operations[platform] || "";
  const anyBusy = Object.values(operations).some(Boolean);
  const xhsImages = usePlatformImages(draft?.images, "xiaohongshu", draft?.risk?.notes.xiaohongshu, confirmedRisk.xiaohongshu === draft?.risk?.notes.xiaohongshu);
  const wechatImages = usePlatformImages(draft?.images, "wechat", draft?.risk?.notes.wechat, confirmedRisk.wechat === draft?.risk?.notes.wechat);
  const preparedByPlatform = { xiaohongshu: xhsImages, wechat: wechatImages };
  const prepared = preparedByPlatform[platform];
  const images = prepared.images || [];
  useEffect(() => { draftRef.current = draft; }, [draft]);
  function setFeedback(next: Feedback | null, target = platform) { setFeedbackByPlatform((current) => ({ ...current, [target]: next })); }
  function abortOperations() { Object.values(operationRef.current).forEach((controller) => controller.abort()); }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setConnectionLoading(true); setConnectionError("");
      try {
        const [savedBinding, savedAccounts] = await Promise.all([loadBinding(), listAccounts()]);
        if (!cancelled) { setBinding(savedBinding); setAccounts(savedAccounts); }
      } catch (error) {
        if (!cancelled) { setBinding(null); setAccounts([]); setConnectionError(errorMessage(error)); }
      } finally { if (!cancelled) setConnectionLoading(false); }
    });
    return () => { cancelled = true; };
  }, [open]);

  function changeConnection(nextBinding: Binding | null, nextAccounts: LocalWechatAccount[]) {
    setBinding(nextBinding); setAccounts(nextAccounts); setConnectionError("");
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortOperations();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const opener = openerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      abortOperations();
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, openerRef]);

  async function readStoredDraft() {
    setStorageState("loading"); setStorageError("");
    try {
      const saved = await loadLocalDraft();
      if (!mountedRef.current) return;
      setStoredDraft(saved); setStorageState("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      setStorageState("error"); setStorageError(errorMessage(error));
    }
  }
  useEffect(() => {
    if (!open || loadStartedRef.current) return;
    loadStartedRef.current = true;
    void Promise.resolve().then(readStoredDraft);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector(".draft-sync-scroll")?.scrollTo({ top: 0 });
  }, [open, platform]);

  function queueSave(snapshot: LocalDraft) {
    const pending = saveChainRef.current.catch(() => {}).then(() => saveLocalDraft(snapshot));
    saveChainRef.current = pending;
    return pending.then(() => {
      if (!mountedRef.current) return;
      setStoredDraft(snapshot); setStorageState("ready"); setStorageError("");
    });
  }
  useEffect(() => {
    if (!autoSave || !draft || anyBusy) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (Object.keys(operationRef.current).length) return;
      queueSave(draft).then(() => {
        if (!cancelled) setArchiveFeedback({ tone: "success", text: "已自动存到本机" });
      }).catch((error) => {
        if (!cancelled) setArchiveFeedback({ tone: "error", text: errorMessage(error) });
      });
    }, 600);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autoSave, draft, anyBusy]);

  async function runOperation(label: string, operation: (signal: AbortSignal) => Promise<void>, scope: OperationScope = "local", target = platform) {
    if (operationRef.current.local || operationRef.current[scope] || (scope === "local" && Object.keys(operationRef.current).length)) return;
    const controller = new AbortController();
    operationRef.current[scope] = controller;
    setOperations((current) => ({ ...current, [scope]: label })); setFeedback(null, target);
    try { await operation(controller.signal); }
    catch (error) {
      if (mountedRef.current && !controller.signal.aborted) setFeedback({ tone: "error", text: errorMessage(error) }, target);
    } finally {
      if (operationRef.current[scope] === controller) {
        delete operationRef.current[scope];
        if (mountedRef.current) setOperations((current) => ({ ...current, [scope]: "" }));
      }
    }
  }
  function updateDraft(update: (current: LocalDraft) => LocalDraft, changedPlatform?: DraftPlatform) {
    if (operationRef.current.local || (changedPlatform ? operationRef.current[changedPlatform] : Object.keys(operationRef.current).length)) return;
    setDraft((current) => current ? { ...update(current), updatedAt: new Date().toISOString() } : null);
    setContentChanged((current) => changedPlatform ? { ...current, [changedPlatform]: true } : { xiaohongshu: true, wechat: true }); setArchiveFeedback(null);
  }
  function useStoredDraft() {
    if (!storedDraft || Object.keys(operationRef.current).length) return;
    preparedForOpenRef.current = true;
    setSourceReady(true);
    setDraft({ ...storedDraft, selectedAccountIds: [], receipts: storedDraft.receipts });
    setFeedbackByPlatform({});
    setContentChanged({ xiaohongshu: false, wechat: false }); setConfirmedRisk({});
    setFeedback({ tone: "success", text: "已恢复本机存档，未重新生成或替换图片" });
  }
  function createDraft() {
    if (Object.keys(operationRef.current).length) return;
    preparedForOpenRef.current = true;
    setSourceReady(false);
    void runOperation("正在生成当前图片…", async (signal) => {
      const images = await collectAssets({ editableRisk: Boolean(riskNote) });
      signal.throwIfAborted();
      const initialTitle = title.replace(/\s*\n\s*/g, " ").trim();
      const current = draftRef.current;
      const previousSource = previousSourceRef.current;
      const content = Object.fromEntries(PLATFORMS.map((target) => [target, {
        ...current?.content[target],
        title: current && current.content[target].title !== previousSource?.title ? current.content[target].title : initialTitle,
        body: current?.content[target].body || "",
      }])) as LocalDraft["content"];
      const notes = riskNote ? Object.fromEntries(PLATFORMS.map((target) => {
        const edited = current?.risk?.notes[target];
        return [target, edited && JSON.stringify(edited) !== JSON.stringify(previousSource?.risk) ? edited : { ...riskNote }];
      })) as Record<DraftPlatform, RiskNote> : undefined;
      setDraft({
        schemaVersion: 1, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), sourceFormat, images,
        ...(notes ? { risk: { notes } } : {}), content,
        selectedAccountIds: [], receipts: (current || storedDraft)?.receipts.filter((item) => item.jobId) || [],
      });
      setSourceReady(true);
      previousSourceRef.current = { title: initialTitle, risk: riskNote ? { ...riskNote } : undefined };
      setContentChanged({ xiaohongshu: Boolean(current), wechat: true });
      setFeedbackByPlatform({}); setConfirmedRisk({}); setArchiveFeedback(null);
    });
  }
  const prepareOnOpen = useEffectEvent(() => createDraft());
  useEffect(() => {
    if (!open) { preparedForOpenRef.current = false; return; }
    // Read durable receipts first. Export updates canCollect and function props;
    // neither should restart or cancel this one export for the current opening.
    if (!canCollect || storageState !== "ready" || anyBusy || Object.keys(operationRef.current).length || preparedForOpenRef.current) return;
    preparedForOpenRef.current = true;
    prepareOnOpen();
  }, [open, canCollect, storageState, anyBusy]);
  function saveDraft() {
    if (!draft) return;
    setArchiveFeedback(null);
    void runOperation("正在存到本机…", async (signal) => {
      await queueSave(draft); signal.throwIfAborted();
      setArchiveFeedback({ tone: "success", text: "图片、独立文案和核对记录已存到当前浏览器" });
    });
  }
  function deleteArchive() {
    setAutoSave(false);
    void runOperation("正在删除本机存档…", async (signal) => {
      await saveChainRef.current.catch(() => {}); signal.throwIfAborted();
      await clearLocalDraft(); signal.throwIfAborted();
      setStoredDraft(null); setStorageState("ready"); setStorageError("");
      setArchiveFeedback({ tone: "success", text: "本机存档已删除。当前窗口中的编辑仍可继续" });
    });
  }
  function selectFiles(replacementId: string | null) {
    if (Object.keys(operationRef.current).length) return;
    replacementIdRef.current = replacementId;
    if (fileInputRef.current) { fileInputRef.current.multiple = replacementId === null; fileInputRef.current.click(); }
  }
  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const replacementId = replacementIdRef.current;
    void runOperation("正在读取本机图片…", async (signal) => {
      const images: DraftImage[] = [];
      for (const file of files) { images.push(await readDraftImage(file)); signal.throwIfAborted(); }
      setDraft((current) => current ? { ...current, updatedAt: new Date().toISOString(), images: replacementId
        ? current.images.map((image) => image.id === replacementId ? images[0] : image) : current.images.at(-1)?.riskTemplate ? [...current.images.slice(0, -1), ...images, current.images.at(-1)!] : [...current.images, ...images] } : null);
      setContentChanged({ xiaohongshu: true, wechat: true }); setArchiveFeedback(null);
      setFeedback({ tone: "success", text: replacementId ? "图片已替换，未裁剪原图" : `已添加 ${images.length} 张图片，未裁剪原图` });
    });
  }
  function moveImage(index: number, direction: -1 | 1) {
    updateDraft((current) => {
      const images = [...current.images]; const next = index + direction;
      if (next < 0 || next >= images.length || images[index].riskTemplate || images[next].riskTemplate) return current;
      [images[index], images[next]] = [images[next], images[index]];
      return { ...current, images };
    });
  }

  const limit = DRAFT_LIMITS[platform];
  const size = PLATFORM_IMAGE_SIZES[platform];
  const risk = draft?.risk?.notes[platform];
  const titleLength = draft ? countCharacters(draft.content[platform].title) : 0;
  const titleError = draft && !draft.content[platform].title.trim() ? "请填写标题" : titleLength > limit.title ? `标题超出 ${titleLength - limit.title} 字，请缩短至 ${limit.title} 字以内` : "";
  const riskReady = !risk || confirmedRisk[platform] === risk;
  const adjustedCount = draft?.images.filter((image) => image.width !== size.width || image.height !== size.height).length || 0;
  function closeDialog(returnToEditor = false) {
    abortOperations();
    setSourceReady(false);
    if (returnToEditor) onReturnToEditor(); else onClose();
  }
  function platformContentCheck(target: DraftPlatform) {
    const ready = preparedByPlatform[target];
    const checks = draft && ready.images ? validateDraft(target, draft.content[target], ready.images.map(imageMetadata)).filter((issue) => !["title-empty", "title-long"].includes(issue.code)) : [];
    if (!sourceReady) return <p className="draft-sync-message neutral" role="status">{operations.local ? "正在更新图片，请稍候…" : "图片尚未更新，请点击“更新当前图片”重试。"}</p>;
    const needsRisk = Boolean(draft?.risk && confirmedRisk[target] !== draft.risk.notes[target]);
    if (!ready.error && !ready.preparing && !checks.length && !needsRisk) return null;
    return <section className="draft-sync-validation" aria-label="同步前检查">
      {ready.preparing ? <p role="status">正在调整图片，请稍候…</p> : needsRisk && <p>请先确认上方的风险提示。</p>}
      {ready.error && <p role="alert">{ready.error}</p>}
      {!!checks.length && <ul>{checks.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>)}</ul>}
    </section>;
  }
  function updateRisk(change: Partial<RiskNote>) {
    updateDraft((current) => current.risk ? { ...current, risk: { ...current.risk, notes: { ...current.risk.notes, [platform]: { ...current.risk.notes[platform], ...change } } } } : current, platform);
  }
  async function persistWechatReceipt(snapshot: LocalDraft, nextReceipt: SyncReceipt, signal: AbortSignal) {
    signal.throwIfAborted();
    const source = draftRef.current;
    if (!source || source.id !== snapshot.id) throw new Error("当前内容已更新，请查看原任务状态");
    const known = receiptSnapshotRef.current;
    const receipts = known?.id === snapshot.id ? known.receipts : source.receipts;
    // Archive source pixels. The operation continues with exactly the adapted
    // snapshot the user confirmed, while other platform state stays intact.
    const next = withReceipt({ ...source, receipts }, nextReceipt);
    receiptSnapshotRef.current = next;
    await queueSave(next); signal.throwIfAborted();
    setDraft((current) => current?.id === next.id ? { ...current, receipts: next.receipts } : current);
    return { ...snapshot, receipts: next.receipts };
  }

  const platformTabs = <div className="draft-sync-platforms" role="group" aria-label="选择同步平台">{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(operations.local)} onClick={() => setPlatform(target)}>{DRAFT_LIMITS[target].label}<span>{target === "wechat" ? "4:5" : "3:4"}{operations[target] && " · 处理中"}</span></button>)}</div>;

  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><h2 id="draft-sync-title">同步到草稿箱</h2><p id="draft-sync-description">确认图片和配文，同步后到平台后台发布。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" onClick={() => closeDialog()}>×</button>
      </header>
      <div className="draft-sync-platform-bar">{platformTabs}</div>
      <div className="draft-sync-scroll">
        <div className="draft-sync-content-toolbar"><p>{sourceReady ? "图片已按所选平台适配，确认下方预览即可同步。" : "正在准备当前内容；同步将在图片更新后可用。"}</p><button type="button" disabled={anyBusy || !canCollect || storageState !== "ready"} onClick={createDraft}>更新当前图片</button></div>
        {storageError && <div className="draft-sync-message error" role="alert">{storageError}<button type="button" disabled={Boolean(busy)} onClick={() => void readStoredDraft()}>重新读取</button></div>}
        {!draft ? <div className="draft-sync-empty"><h3>{busy || storageState === "loading" ? "正在准备当前图片…" : "图片尚未准备好"}</h3><p>{!canCollect ? "海报排版完成后会自动准备。" : "准备完成后，图片和配文会显示在这里。"}</p></div> : <div className="draft-sync-columns">
          <section className="draft-sync-assets" aria-labelledby="draft-sync-assets-title">
            <div className="draft-sync-section-title"><div><h3 id="draft-sync-assets-title">图片预览 <span>{images.length} 张</span></h3></div><button type="button" aria-expanded={editingImages} onClick={() => setEditingImages(!editingImages)}>{editingImages ? "收起调整" : "调整图片"}</button></div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" hidden onChange={onFilesSelected} aria-label="草稿图片文件" />
            <div className="draft-sync-size-summary" role="status"><strong>{limit.label} · {size.width} × {size.height}</strong><span>{prepared.preparing ? "正在自动适配图片…" : adjustedCount ? `已自动调整 ${adjustedCount} 张 · 完整保留内容，空余处留白` : "尺寸已符合默认设置"}</span></div>
            {editingImages && <button type="button" className="draft-sync-add-image" disabled={anyBusy} onClick={() => selectFiles(null)}>＋ 添加图片</button>}
            <ol className="draft-sync-image-list">
              {images.map((image, index) => <li key={image.id} className="draft-sync-image-card" data-image-name={image.name} data-risk-page={image.riskTemplate ? "true" : undefined}>
                <div className="draft-sync-image-preview" style={{ aspectRatio: `${size.width} / ${size.height}` }}><DraftThumbnail image={image} index={index} /><span>{index === 0 ? "01 · 封面" : image.riskTemplate ? (riskReady ? (risk?.enabled ? "末页 · 含风险提示" : "末页") : "末页 · 待确认") : String(index + 1).padStart(2, "0")}</span></div>
                <div className="draft-sync-image-info" hidden={!editingImages}><b title={image.name}>{image.name}</b><small>{image.width} × {image.height} · {(image.blob.size / 1024 / 1024).toFixed(2)} MB</small></div>
                <div className="draft-sync-image-actions" hidden={!editingImages || Boolean(image.riskTemplate)}>
                  <button type="button" disabled={anyBusy || index === 0} onClick={() => moveImage(index, -1)} aria-label={`前移第 ${index + 1} 张图片`}>←</button>
                  <button type="button" disabled={anyBusy || index === draft.images.length - 1 || Boolean(draft.images[index + 1]?.riskTemplate)} onClick={() => moveImage(index, 1)} aria-label={`后移第 ${index + 1} 张图片`}>→</button>
                  <button type="button" disabled={anyBusy} onClick={() => selectFiles(image.id)} aria-label={`替换第 ${index + 1} 张图片`}>替换</button>
                  <button type="button" disabled={anyBusy} onClick={() => updateDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))} aria-label={`删除第 ${index + 1} 张图片`}>删除</button>
                </div>
              </li>)}
            </ol>
            {!draft.images.length && <p className="draft-sync-message neutral">还没有图片，请添加本机图片，或用当前海报新建草稿。</p>}
            <p className="draft-sync-small">按预览顺序同步，原图保持不变。</p>
          </section>

          <section className="draft-sync-editor" aria-label="平台文案">
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} aria-invalid={Boolean(titleError)} aria-describedby="draft-title-help" disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }), platform)} /><small id="draft-title-help" className={titleError ? "draft-sync-field-error" : ""} role={titleError ? "alert" : undefined}>{titleError || `${titleLength} / ${limit.title} 字`}</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={3} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="选填：为图片补充一段说明" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字</small>{platform === "xiaohongshu" && <small>话题 {countHashtags(draft.content[platform].body)} / {limit.topics} 个；以 # 开头，用空格分隔</small>}</div>
            {risk && <section className="draft-sync-risk" aria-label={`${limit.label}风险提示`}>
              <div className="draft-sync-section-title"><div><h3>末页风险提示</h3><p>确认后更新最后一页，不增加页数。</p></div></div>
              <div className="draft-sync-risk-preview">{risk.enabled ? <><strong>{risk.title}</strong><p>{risk.text}</p></> : <p>末页不显示风险提示</p>}</div>
              <details className="draft-sync-risk-edit"><summary>修改风险提示</summary>
              <label className="draft-sync-check"><input type="checkbox" checked={risk.enabled} disabled={Boolean(busy)} onChange={(event) => updateRisk({ enabled: event.target.checked })} /><span>在末页显示风险提示</span></label>
              {risk.enabled && <>
                <div className="field-stack"><label htmlFor="draft-risk-title">风险提示标题</label><input id="draft-risk-title" value={risk.title} disabled={Boolean(busy)} onChange={(event) => updateRisk({ title: event.target.value })} /></div>
                <div className="field-stack"><label htmlFor="draft-risk-text">风险提示内容</label><textarea id="draft-risk-text" rows={5} value={risk.text} disabled={Boolean(busy)} onChange={(event) => updateRisk({ text: event.target.value })} /></div>
              </>}
              </details>
              <label className="draft-sync-check draft-sync-risk-confirm"><input type="checkbox" checked={confirmedRisk[platform] === risk} disabled={Boolean(busy) || prepared.preparing} onChange={(event) => setConfirmedRisk((current) => ({ ...current, [platform]: event.target.checked ? risk : undefined }))} /><span>我已确认{limit.label}的风险提示{!risk.enabled && "（末页不显示风险提示）"}</span></label>
            </section>}
          </section>
          </div>}
        {draft && <div className="draft-sync-destination">
          {connectionLoading && !binding ? <p className="draft-sync-small" role="status">正在恢复这台电脑的连接…</p> : <>
            {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
            <LocalSyncConnection binding={binding} accounts={accounts} busy={anyBusy || connectionLoading} runOperation={runOperation} onChange={changeConnection} />
            {binding && PLATFORMS.map((target) => {
              const prepared = preparedByPlatform[target];
              const snapshot = { ...draft, images: prepared.images || draft.images };
              const ready = sourceReady && Boolean(prepared.images) && !prepared.preparing && !prepared.error && (!draft.risk || confirmedRisk[target] === draft.risk.notes[target]) && !validateDraft(target, draft.content[target], snapshot.images.map(imageMetadata)).some((issue) => issue.severity === "error");
              const props = { draft: snapshot, binding, contentReady: ready, contentCheck: platformContentCheck(target), contentChanged: contentChanged[target], busy: Boolean(connectionLoading || operations.local || operations[target]),
                runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => runOperation(label, operation, target, target),
                persistReceipt: persistWechatReceipt, onSubmitted: () => { setContentChanged((current) => ({ ...current, [target]: false })); } };
              return <div key={target} hidden={platform !== target}>
                {target === "wechat" ? <WechatDraftPanel {...props} view="browser" accounts={accounts} onAccountsChange={changeConnection} /> : <XiaohongshuDraftPanel {...props} />}
              </div>;
            })}
          </>}
        </div>}
        <details className="draft-sync-archive-details">
          <summary>本机存档</summary>
          <section className="draft-sync-archive" aria-label="本机存档">
            <p>{storedDraft ? `${storedDraft.images.length} 张图片 · ${new Date(storedDraft.updatedAt).toLocaleString("zh-CN")}` : "可将当前内容保存在这个浏览器，下次继续编辑。"}</p>
            <div className="draft-sync-inline-actions">
              <button type="button" disabled={anyBusy || !draft} onClick={saveDraft}>存到本机</button>
              {storedDraft && <button type="button" disabled={anyBusy} onClick={useStoredDraft}>继续本机存档</button>}
              {(storedDraft || storageState === "error") && <button type="button" className="draft-sync-danger" disabled={anyBusy} onClick={deleteArchive}>删除本机存档</button>}
            </div>
            {draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}
            {archiveFeedback && <p className={archiveFeedback.tone} role="status">{archiveFeedback.text}</p>}
          </section>
        </details>

      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy}</p> : feedback ? <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : <p>同步只保存草稿，发布请前往平台后台。</p>}</div>
        <div className="draft-sync-footer-actions">
          <button type="button" disabled={anyBusy} onClick={() => closeDialog(true)}>返回编辑海报</button>
          <button type="button" onClick={() => closeDialog()}>完成</button>
        </div>
      </footer>
    </div>
  </dialog>;
}
