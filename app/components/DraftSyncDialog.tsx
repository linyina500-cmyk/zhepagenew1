"use client";

import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
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
type DraftStep = "content" | "browser" | "results";
const STEPS: { id: DraftStep; label: string; hint: string }[] = [
  { id: "content", label: "确认内容", hint: "检查图片顺序，填写所选平台的标题和配文。" },
  { id: "browser", label: "连接小红书", hint: "登录并确认账号，然后保存到小红书草稿箱。" },
  { id: "results", label: "查看结果", hint: "查看保存结果，打开平台草稿箱检查图片。" },
];
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
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const receiptSnapshotRef = useRef<LocalDraft | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [stepsByPlatform, setStepsByPlatform] = useState<Record<DraftPlatform, DraftStep>>({ xiaohongshu: "content", wechat: "content" });
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedbackByPlatform, setFeedbackByPlatform] = useState<Partial<Record<DraftPlatform, Feedback | null>>>({});
  const [operations, setOperations] = useState<Partial<Record<OperationScope, string>>>({});
  const [platform, setPlatform] = useState<DraftPlatform>("xiaohongshu");
  const [confirmedImages, setConfirmedImages] = useState<Partial<Record<DraftPlatform, DraftImage[]>>>({});
  const [confirmedRisk, setConfirmedRisk] = useState<Partial<Record<DraftPlatform, RiskNote>>>({});
  const [contentChanged, setContentChanged] = useState<Record<DraftPlatform, boolean>>({ xiaohongshu: false, wechat: false });
  const [binding, setBinding] = useState<Binding | null>(null);
  const [accounts, setAccounts] = useState<LocalWechatAccount[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");

  const step = stepsByPlatform[platform];
  const feedback = feedbackByPlatform[platform];
  const busy = operations.local || operations[platform] || "";
  const anyBusy = Object.values(operations).some(Boolean);
  const xhsImages = usePlatformImages(draft?.images, "xiaohongshu", draft?.risk?.notes.xiaohongshu, confirmedRisk.xiaohongshu === draft?.risk?.notes.xiaohongshu);
  const wechatImages = usePlatformImages(draft?.images, "wechat", draft?.risk?.notes.wechat, confirmedRisk.wechat === draft?.risk?.notes.wechat);
  const preparedByPlatform = { xiaohongshu: xhsImages, wechat: wechatImages };
  const prepared = preparedByPlatform[platform];
  const images = prepared.images || [];
  useEffect(() => { draftRef.current = draft; }, [draft]);
  function setStep(next: DraftStep, target = platform) { setStepsByPlatform((current) => ({ ...current, [target]: next })); }
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
    stepHeadingRef.current?.focus({ preventScroll: true });
    dialogRef.current?.querySelector(".draft-sync-scroll")?.scrollTo({ top: 0 });
  }, [open, step, platform]);

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
    setDraft({ ...storedDraft, selectedAccountIds: [], receipts: storedDraft.receipts });
    setStepsByPlatform({ xiaohongshu: "content", wechat: "content" }); setFeedbackByPlatform({});
    setContentChanged({ xiaohongshu: false, wechat: false }); setConfirmedImages({}); setConfirmedRisk({}); setStep("content");
    setFeedback({ tone: "success", text: "已恢复本机存档，未重新生成或替换图片" });
  }
  function createDraft() {
    void runOperation("正在生成当前图片…", async (signal) => {
      const images = await collectAssets({ editableRisk: Boolean(riskNote) });
      signal.throwIfAborted();
      const initialTitle = title.replace(/\s*\n\s*/g, " ").trim();
      setDraft({
        schemaVersion: 1, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), sourceFormat, images,
        ...(riskNote ? { risk: { notes: { xiaohongshu: { ...riskNote }, wechat: { ...riskNote } } } } : {}),
        content: { xiaohongshu: { title: initialTitle, body: "" }, wechat: { title: initialTitle, body: "" } },
        selectedAccountIds: [], receipts: (draft || storedDraft)?.receipts.filter((item) => item.jobId) || [],
      });
      setContentChanged({ xiaohongshu: false, wechat: true }); setStepsByPlatform({ xiaohongshu: "content", wechat: "content" }); setFeedbackByPlatform({}); setConfirmedImages({}); setConfirmedRisk({}); setArchiveFeedback(null);
      setFeedback({ tone: "success", text: `已准备全部 ${images.length} 张真实图片。请检查顺序，并为所选平台填写标题和文案。` });
    });
  }
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
  const issues = draft && prepared.images ? validateDraft(platform, draft.content[platform], images.map(imageMetadata)) : [];
  const contentReady = Boolean(draft && prepared.images && riskReady && !issues.some((issue) => issue.severity === "error"));
  const adjustedCount = draft?.images.filter((image) => image.width !== size.width || image.height !== size.height).length || 0;
  function closeDialog(returnToEditor = false) {
    abortOperations();
    if (returnToEditor) onReturnToEditor(); else onClose();
  }
  function goToStep(next: DraftStep) {
    if (operationRef.current.local || operationRef.current[platform]) return;
    setFeedback(null); setStep(next);
  }
  function confirmContent() {
    if (!contentReady || !prepared.images) return;
    setConfirmedImages((current) => ({ ...current, [platform]: prepared.images! }));
    goToStep("browser");
  }
  function platformContentCheck(target: DraftPlatform) {
    const ready = preparedByPlatform[target];
    const checks = draft && ready.images ? validateDraft(target, draft.content[target], ready.images.map(imageMetadata)).filter((issue) => stepsByPlatform[target] !== "content" || !["title-empty", "title-long"].includes(issue.code)) : [];
    const needsConfirmation = ready.images !== confirmedImages[target] || Boolean(draft?.risk && confirmedRisk[target] !== draft.risk.notes[target]);
    if (!ready.error && !ready.preparing && !checks.length && (!needsConfirmation || step === "content")) return null;
    return <section className="draft-sync-validation" aria-label="同步前检查">
      <h3>{ready.preparing ? "正在自动调整图片…" : "请先确认内容"}</h3>
      {ready.error && <p role="alert">{ready.error}</p>}
      {!!checks.length && <ul>{checks.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}>{issue.message}</li>)}</ul>}
      {step !== "content" && (needsConfirmation || checks.length > 0 || ready.error) && <button type="button" disabled={Boolean(operations.local || operations[target])} onClick={() => setStep("content", target)}>查看并确认图片</button>}
    </section>;
  }
  const contentCheck = platformContentCheck(platform);
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

  const steps = STEPS.map((item) => platform === "wechat" && item.id === "browser" ? { ...item, label: "选择公众号", hint: "勾选目标公众号，选择同步到草稿箱或立即发布。" } : platform === "wechat" && item.id === "results" ? { ...item, hint: "查看每个公众号的处理结果。存草稿后，可去后台检查图片或设置定时发布。" } : item);
  const stepInfo = steps.find((item) => item.id === step)!;
  const nextHint = step === "content" ? prepared.preparing ? "正在按所选平台调整图片，请稍候。" : !draft ? "先用当前海报开始，或继续已有的本机存档。" : contentReady ? `确认预览中的图片和配文后，继续选择账号。` : !riskReady ? `请单独确认${limit.label}的风险提示，再继续。` : "请先处理内容中的提示，再继续。"
    : !binding ? "首次连接后，小红书和公众号都可以在这里同步。"
    : platform === "wechat" ? "草稿保留在所选公众号；立即发布会另行确认目标和内容。" : step === "browser" ? "保存后可在小红书专用窗口查看草稿。" : "以草稿箱中重新打开的内容为准；结果待核对时请勿重复创建。";
  const platformTabs = <div className="draft-sync-platforms" role="group" aria-label="选择同步平台">{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(operations.local)} onClick={() => setPlatform(target)}>{DRAFT_LIMITS[target].label}<span>{target === "wechat" ? "4:5 · 存草稿或发布" : "3:4 · 保存到草稿箱"}{operations[target] && " · 处理中"}</span></button>)}</div>;


  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><span className="eyebrow">海报已就绪，继续下一步</span><h2 id="draft-sync-title">同步与发布</h2><p id="draft-sync-description">小红书存草稿；公众号可存草稿或立即发布。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" onClick={() => closeDialog()}>×</button>
      </header>
      <div className="draft-sync-platform-bar">{platformTabs}</div>
      <nav className="draft-sync-steps" aria-label="草稿保存步骤">{steps.map((item, index) => <button type="button" key={item.id} aria-current={step === item.id ? "step" : undefined} disabled={Boolean(busy) || (item.id === "browser" && !draft?.images.length) || (item.id === "results" && !draft)} onClick={() => goToStep(item.id)}><span aria-hidden="true">{index + 1}</span>{item.label}</button>)}</nav>
      <div className="draft-sync-scroll">
        <div className="draft-sync-step-heading"><h3 ref={stepHeadingRef} tabIndex={-1}>{stepInfo.label}</h3><p>{stepInfo.hint}</p></div>
        {step === "content" && <>
          <section className="draft-sync-archive" aria-label="本机存档">
            <div><strong>{storedDraft ? "可继续上次的本机草稿" : "当前内容可存到本机"}</strong>{(storedDraft || !draft) && <p>{storedDraft ? `${storedDraft.images.length} 张图片 · ${new Date(storedDraft.updatedAt).toLocaleString("zh-CN")}` : "点击下方“存到本机”后，下次在同一浏览器、同一网址打开可继续。"}</p>}</div>
            <div className="draft-sync-inline-actions">
              {storedDraft && <button type="button" disabled={anyBusy} onClick={useStoredDraft}>继续本机存档</button>}
              {draft && <button type="button" disabled={anyBusy || !canCollect || storageState === "loading"} onClick={createDraft}>用当前图片新建</button>}
              {(storedDraft || storageState === "error") && <button type="button" className="draft-sync-danger" disabled={anyBusy} onClick={deleteArchive}>删除本机存档</button>}
            </div>
            {storageState === "loading" && <p role="status">正在检查本机存档…</p>}
            {storageError && <div className="draft-sync-message error" role="alert">{storageError}<button type="button" disabled={Boolean(busy)} onClick={() => void readStoredDraft()}>重新读取</button></div>}
            {!canCollect && <p>海报正在处理，排版完成后即可开始；也可继续已有存档。</p>}
          </section>
          {!draft ? <div className="draft-sync-empty"><span aria-hidden="true">01</span><h3>先把当前海报带进来</h3><p>点击“用当前海报开始”，生成全部海报的图片副本。你可以替换图片、调整顺序，再给两个平台分别写文案。</p></div> : <div className="draft-sync-columns">
          <section className="draft-sync-assets" aria-labelledby="draft-sync-assets-title">
            <div className="draft-sync-section-title"><div><h3 id="draft-sync-assets-title">确认图片 <span>{images.length} 张</span></h3><p>首图作为封面，切换平台会自动调整尺寸。</p></div><button type="button" disabled={anyBusy} onClick={() => selectFiles(null)}>＋ 添加图片</button></div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" hidden onChange={onFilesSelected} aria-label="草稿图片文件" />
            <div className="draft-sync-size-summary" role="status"><strong>{limit.label} · {size.width} × {size.height}</strong><span>{prepared.preparing ? "正在自动适配图片…" : adjustedCount ? `已自动调整 ${adjustedCount} 张 · 完整保留内容，空余处留白` : "尺寸已符合默认设置"}</span></div>
            <ol className="draft-sync-image-list">
              {images.map((image, index) => <li key={image.id} className="draft-sync-image-card" data-image-name={image.name}>
                <div className="draft-sync-image-preview" style={{ aspectRatio: `${size.width} / ${size.height}` }}><DraftThumbnail image={image} index={index} /><span>{index === 0 ? "01 · 封面" : image.riskTemplate ? (riskReady ? (risk?.enabled ? "末页 · 含风险提示" : "末页") : "末页 · 待确认") : String(index + 1).padStart(2, "0")}</span></div>
                <div className="draft-sync-image-info"><b title={image.name}>{image.name}</b><small>{image.width} × {image.height} · {(image.blob.size / 1024 / 1024).toFixed(2)} MB</small></div>
                <div className="draft-sync-image-actions" hidden={Boolean(image.riskTemplate)}>
                  <button type="button" disabled={anyBusy || index === 0} onClick={() => moveImage(index, -1)} aria-label={`前移第 ${index + 1} 张图片`}>←</button>
                  <button type="button" disabled={anyBusy || index === draft.images.length - 1 || Boolean(draft.images[index + 1]?.riskTemplate)} onClick={() => moveImage(index, 1)} aria-label={`后移第 ${index + 1} 张图片`}>→</button>
                  <button type="button" disabled={anyBusy} onClick={() => selectFiles(image.id)} aria-label={`替换第 ${index + 1} 张图片`}>替换</button>
                  <button type="button" disabled={anyBusy} onClick={() => updateDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))} aria-label={`删除第 ${index + 1} 张图片`}>删除</button>
                </div>
              </li>)}
            </ol>
            {!draft.images.length && <p className="draft-sync-message neutral">还没有图片，请添加本机图片，或用当前海报新建草稿。</p>}
            <button type="button" className="draft-sync-return" disabled={anyBusy} onClick={() => closeDialog(true)}>返回编辑海报</button>
            <p className="draft-sync-small">适配不会修改原图；确认后按此预览同步。</p>
          </section>

          <section className="draft-sync-editor" aria-label="平台文案">
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} aria-invalid={Boolean(titleError)} aria-describedby="draft-title-help" disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }), platform)} /><small id="draft-title-help" className={titleError ? "draft-sync-field-error" : ""} role={titleError ? "alert" : undefined}>{titleError || `${titleLength} / ${limit.title} 字`}</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={6} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="为这个平台写一段配文" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字；平台文案分别保存</small>{platform === "xiaohongshu" && <small>话题 {countHashtags(draft.content[platform].body)} / {limit.topics} 个；以 # 开头，用空格分隔</small>}</div>
            {risk && <section className="draft-sync-risk" aria-label={`${limit.label}风险提示`}>
              <div className="draft-sync-section-title"><div><h3>单独确认风险提示</h3><p>仅用于{limit.label}。确认后更新原来的最后一页，不增加页数。</p></div></div>
              <label className="draft-sync-check"><input type="checkbox" checked={risk.enabled} disabled={Boolean(busy)} onChange={(event) => updateRisk({ enabled: event.target.checked })} /><span>在末页显示风险提示</span></label>
              {risk.enabled && <>
                <div className="field-stack"><label htmlFor="draft-risk-title">风险提示标题</label><input id="draft-risk-title" value={risk.title} disabled={Boolean(busy)} onChange={(event) => updateRisk({ title: event.target.value })} /></div>
                <div className="field-stack"><label htmlFor="draft-risk-text">风险提示内容</label><textarea id="draft-risk-text" rows={5} value={risk.text} disabled={Boolean(busy)} onChange={(event) => updateRisk({ text: event.target.value })} /></div>
              </>}
              <label className="draft-sync-check draft-sync-risk-confirm"><input type="checkbox" checked={confirmedRisk[platform] === risk} disabled={Boolean(busy) || prepared.preparing} onChange={(event) => setConfirmedRisk((current) => ({ ...current, [platform]: event.target.checked ? risk : undefined }))} /><span>我已确认{limit.label}的风险提示{!risk.enabled && "（末页不显示风险提示）"}</span></label>
            </section>}
            {!risk && <p className="draft-sync-small">此存档为已生成的图片。需要分平台编辑风险提示时，请用当前图片新建。</p>}
          </section>
          </div>}
        </>}
        {step === "browser" && draft && <>
          <section className="draft-sync-selection-summary" aria-label="本次传入内容">
            <h3>{limit.label} · {draft.content[platform].title || "未填写标题"}</h3>
            <p className="draft-sync-small">共 {images.length} 张 · {size.width} × {size.height} · 按已确认的顺序同步。</p>
            <details><summary>查看本次配文</summary><p className="draft-sync-summary-body">{draft.content[platform].body || "未填写配文"}</p></details>
            <button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button>
          </section>
        </>}
        {open && draft && <div hidden={step === "content"}>
          {connectionLoading ? <p className="draft-sync-small" role="status">正在恢复这台电脑的连接…</p> : <>
            {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
            <LocalSyncConnection binding={binding} accounts={accounts} busy={anyBusy} runOperation={runOperation} onChange={changeConnection} />
            {binding && PLATFORMS.map((target) => {
              const prepared = preparedByPlatform[target];
              const snapshot = { ...draft, images: prepared.images || draft.images };
              const ready = Boolean(prepared.images) && confirmedImages[target] === prepared.images && (!draft.risk || confirmedRisk[target] === draft.risk.notes[target]) && !validateDraft(target, draft.content[target], snapshot.images.map(imageMetadata)).some((issue) => issue.severity === "error");
              const props = { draft: snapshot, binding, contentReady: ready, contentCheck: platformContentCheck(target), contentChanged: contentChanged[target], busy: Boolean(operations.local || operations[target]),
                runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => runOperation(label, operation, target, target),
                persistReceipt: persistWechatReceipt, onSubmitted: () => { setStep("results", target); setContentChanged((current) => ({ ...current, [target]: false })); } };
              return <div key={`${draft.id}:${target}`} hidden={platform !== target}>
                {target === "wechat" ? <WechatDraftPanel {...props} view={stepsByPlatform.wechat === "results" ? "results" : "browser"} accounts={accounts} onAccountsChange={changeConnection} /> : <XiaohongshuDraftPanel {...props} />}
              </div>;
            })}
          </>}
        </div>}
        {step === "content" && contentCheck}

      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy} 关闭窗口可停止等待；已经提交的任务仍需读取状态和核对结果。</p> : <>{feedback && <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}<p>{nextHint}</p></>}{archiveFeedback && <p className={archiveFeedback.tone} role="status">{archiveFeedback.text}</p>}{draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}</div>
        <div className="draft-sync-footer-actions">
          <button type="button" disabled={anyBusy || !draft} onClick={saveDraft}>存到本机</button>
          {step === "content" ? <button type="button" className="primary" disabled={Boolean(busy) || (draft ? !contentReady : !canCollect || storageState === "loading")} onClick={() => draft ? confirmContent() : createDraft()}>{draft ? platform === "wechat" ? "确认图片，选择公众号" : "确认图片，连接小红书" : "用当前海报开始"}</button> : step === "browser" ? <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>上一步</button></> : <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button><button type="button" className="primary" onClick={() => closeDialog()}>完成</button></>}
        </div>
      </footer>
    </div>
  </dialog>;
}
