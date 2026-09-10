"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { BROWSER_SYNC_VERSION, BrowserSyncUnconfirmedError, createBrowserSyncClient, type BrowserSyncJob } from "../../lib/browserSync/client";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from "../../lib/draftSync/localDraftStore";
import type { DraftImage, DraftPlatform, LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { countCharacters, countHashtags, DRAFT_LIMITS, imageMetadata, readDraftImage, validateDraft } from "../../lib/draftSync/validation";

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
type DraftStep = "content" | "browser" | "results";
type Readback = { job: BrowserSyncJob | null; checked: boolean };
const STEPS: { id: DraftStep; label: string; hint: string }[] = [
  { id: "content", label: "确认内容", hint: "检查完整图片和顺序，为两个平台分别填写标题与文案。" },
  { id: "browser", label: "交给浏览器", hint: "把真实内容留在当前浏览器，再到平台原生编辑器导入。" },
  { id: "results", label: "核对草稿", hint: "使用平台当前登录的账号，核对导入内容并在草稿箱确认保存结果。" },
];
const PLATFORMS: DraftPlatform[] = ["xiaohongshu", "wechat"];
const EDITOR_URLS: Record<DraftPlatform, string> = {
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image",
  wechat: "https://mp.weixin.qq.com/",
};
const JOB_LABELS: Record<BrowserSyncJob["status"], string> = {
  ready: "已存入扩展，尚未导入", filling: "正在导入，请勿重复操作", filled: "已填入编辑器，草稿尚待核对", needs_confirmation: "导入或保存结果待核对",
};
const receiptKey = (platform: DraftPlatform) => `browser-sync:${platform}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";
const withReceipt = (draft: LocalDraft, receipt: SyncReceipt): LocalDraft => ({
  ...draft, updatedAt: new Date().toISOString(), selectedAccountIds: [],
  receipts: [...draft.receipts.filter((item) => item.accountId !== receipt.accountId), receipt],
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
  // Generated local Blobs retain their original dimensions and bytes.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imageRef} alt={`草稿图片 ${index + 1}：${image.name}`} width={image.width} height={image.height} />;
}

export default function DraftSyncDialog({ open, openerRef, title, sourceFormat, canCollect, collectAssets, onClose, onReturnToEditor }: DraftSyncDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementIdRef = useRef<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const clientRef = useRef<ReturnType<typeof createBrowserSyncClient> | null>(null);
  const mountedRef = useRef(true);
  const loadStartedRef = useRef(false);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [step, setStep] = useState<DraftStep>("content");
  const [connectionState, setConnectionState] = useState<"idle" | "checking" | "connected" | "error">("idle");
  const [connectionError, setConnectionError] = useState("");
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState("");
  const [platform, setPlatform] = useState<DraftPlatform>("xiaohongshu");
  const [readbacks, setReadbacks] = useState<Partial<Record<DraftPlatform, Readback>>>({});
  const [acceptedWarnings, setAcceptedWarnings] = useState("");
  const [contentChanged, setContentChanged] = useState<Record<DraftPlatform, boolean>>({ xiaohongshu: false, wechat: false });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.abort();
      clientRef.current?.dispose();
      clientRef.current = null;
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
      operationRef.current?.abort();
      clientRef.current?.dispose();
      clientRef.current = null;
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
  }, [open, step]);

  function queueSave(snapshot: LocalDraft) {
    const pending = saveChainRef.current.catch(() => {}).then(() => saveLocalDraft(snapshot));
    saveChainRef.current = pending;
    return pending.then(() => {
      if (!mountedRef.current) return;
      setStoredDraft(snapshot); setStorageState("ready"); setStorageError("");
    });
  }
  useEffect(() => {
    if (!autoSave || !draft || busy) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (operationRef.current) return;
      queueSave(draft).then(() => {
        if (!cancelled) setArchiveFeedback({ tone: "success", text: "已自动存到本机" });
      }).catch((error) => {
        if (!cancelled) setArchiveFeedback({ tone: "error", text: errorMessage(error) });
      });
    }, 600);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autoSave, draft, busy]);

  function client() {
    if (!clientRef.current) clientRef.current = createBrowserSyncClient(window);
    return clientRef.current;
  }
  async function runOperation(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (operationRef.current) return;
    const controller = new AbortController();
    operationRef.current = controller;
    setBusy(label); setFeedback(null);
    try { await operation(controller.signal); }
    catch (error) {
      if (mountedRef.current && !controller.signal.aborted) setFeedback({ tone: "error", text: errorMessage(error) });
    } finally {
      if (operationRef.current === controller) {
        operationRef.current = null;
        if (mountedRef.current) setBusy("");
      }
    }
  }
  function updateDraft(update: (current: LocalDraft) => LocalDraft, changedPlatform?: DraftPlatform) {
    if (operationRef.current) return;
    setDraft((current) => current ? { ...update(current), updatedAt: new Date().toISOString() } : null);
    setContentChanged((current) => changedPlatform ? { ...current, [changedPlatform]: true } : { xiaohongshu: true, wechat: true }); setArchiveFeedback(null);
  }
  function useStoredDraft() {
    if (!storedDraft || operationRef.current) return;
    setDraft({ ...storedDraft, selectedAccountIds: [], receipts: storedDraft.receipts.filter((item) => item.accountId === receiptKey(item.platform)) });
    setContentChanged({ xiaohongshu: false, wechat: false }); setAcceptedWarnings(""); setReadbacks({}); setStep("content");
    setFeedback({ tone: "success", text: "已恢复本机存档，未重新生成或替换图片" });
  }
  function createDraft() {
    void runOperation("正在生成当前图片…", async (signal) => {
      const images = await collectAssets();
      signal.throwIfAborted();
      const initialTitle = title.replace(/\s*\n\s*/g, " ").trim();
      setDraft({
        schemaVersion: 1, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), sourceFormat, images,
        content: { xiaohongshu: { title: initialTitle, body: "" }, wechat: { title: initialTitle, body: "" } },
        selectedAccountIds: [], receipts: [],
      });
      setContentChanged({ xiaohongshu: false, wechat: false }); setStep("content"); setReadbacks({}); setAcceptedWarnings(""); setArchiveFeedback(null);
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
    if (operationRef.current) return;
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
        ? current.images.map((image) => image.id === replacementId ? images[0] : image) : [...current.images, ...images] } : null);
      setContentChanged({ xiaohongshu: true, wechat: true }); setArchiveFeedback(null);
      setFeedback({ tone: "success", text: replacementId ? "图片已替换，未裁剪原图" : `已添加 ${images.length} 张图片，未裁剪原图` });
    });
  }
  function moveImage(index: number, direction: -1 | 1) {
    updateDraft((current) => {
      const images = [...current.images]; const next = index + direction;
      if (next < 0 || next >= images.length) return current;
      [images[index], images[next]] = [images[next], images[index]];
      return { ...current, images };
    });
  }

  const limit = DRAFT_LIMITS[platform];
  const metadata = useMemo(() => draft?.images.map(imageMetadata) || [], [draft?.images]);
  const issues = draft ? validateDraft(platform, draft.content[platform], metadata) : [];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const warningsKey = JSON.stringify({ platform, metadata, warnings: warnings.map(({ code, imageId }) => ({ code, imageId })) });
  const contentReady = Boolean(draft && !errors.length && (!warnings.length || acceptedWarnings === warningsKey));
  const receipt = draft?.receipts.find((item) => item.accountId === receiptKey(platform));
  const readback = readbacks[platform];
  const job = readback?.job;
  const matchingJob = job && receipt?.draftId === job.id;
  const canPrepare = Boolean(contentReady && connectionState === "connected" && !busy);

  function checkExtension() {
    void runOperation("正在检查浏览器扩展…", async (signal) => {
      setConnectionState("checking"); setConnectionError("");
      try {
        await client().ping(signal); signal.throwIfAborted();
        setConnectionState("connected");
        setFeedback({ tone: "success", text: "浏览器扩展已连接，可以传入当前图片与文案。" });
      } catch (error) {
        if (!signal.aborted) { setConnectionState("error"); setConnectionError(errorMessage(error)); }
        throw error;
      }
    });
  }

  function submitDraft() {
    if (!draft || !canPrepare) return;
    const snapshot = draft; const target = platform;
    void runOperation("正在核对浏览器中的上一组内容…", async (signal) => {
      const bridge = client();
      const existing = await bridge.getStatus(target, signal); signal.throwIfAborted();
      setReadbacks((current) => ({ ...current, [target]: { job: existing, checked: true } }));
      if (existing) {
        setStep("results");
        setFeedback({ tone: "neutral", text: "扩展里仍有上一组内容。请先在平台核对编辑器和草稿箱，并在折页面板点击“结束本次传图”，再返回传入下一组。" });
        return;
      }
      // Persist the request identity before sending so a refresh cannot turn an
      // uncertain response into a blind second preparation of the same content.
      const transferId = crypto.randomUUID();
      const pendingReceipt: SyncReceipt = { accountId: receiptKey(target), platform: target, draftId: transferId, status: "needs_confirmation", message: "正在传入浏览器扩展，尚未确认导入或保存。中断后请先读取传图状态。" };
      const staged = withReceipt(snapshot, pendingReceipt);
      await queueSave(staged); signal.throwIfAborted();
      setDraft(staged); setReadbacks((current) => ({ ...current, [target]: { job: null, checked: false } }));
      setContentChanged((current) => ({ ...current, [target]: false })); setStep("results"); setBusy(`正在完整传入 ${snapshot.images.length} 张图片并读回核对…`);
      let next: LocalDraft;
      try {
        const stored = await bridge.prepare({ id: transferId, platform: target, content: snapshot.content[target], images: snapshot.images }, signal);
        next = withReceipt(staged, { ...pendingReceipt, message: stored.message });
        if (mountedRef.current && !signal.aborted) {
          setReadbacks((current) => ({ ...current, [target]: { job: stored, checked: true } }));
          setFeedback({ tone: "success", text: `全部 ${stored.imageCount} 张图片及文案已存入扩展并读回核对。请到 ${DRAFT_LIMITS[target].label} 当前登录账号的编辑器导入。` });
        }
      } catch (error) {
        const uncertain = error instanceof BrowserSyncUnconfirmedError;
        next = withReceipt(staged, { ...pendingReceipt, status: uncertain ? "needs_confirmation" : "failed", message: uncertain ? errorMessage(error) : `内容尚未交给扩展：${errorMessage(error)}` });
        if (mountedRef.current && !signal.aborted) setFeedback({ tone: "error", text: next.receipts.find((item) => item.accountId === receiptKey(target))!.message });
      }
      if (mountedRef.current) setDraft(next);
      try { await queueSave(next); }
      catch (error) {
        if (mountedRef.current) setStorageError(`素材仍在当前窗口，本次结果未能更新到本机存档：${errorMessage(error)}`);
      }
    });
  }

  function readTransfer() {
    const target = platform; const snapshot = draft;
    void runOperation("正在读取传图状态…", async (signal) => {
      const stored = await client().getStatus(target, signal); signal.throwIfAborted();
      setReadbacks((current) => ({ ...current, [target]: { job: stored, checked: true } }));
      const previous = snapshot?.receipts.find((item) => item.accountId === receiptKey(target));
      if (snapshot && previous?.status === "needs_confirmation" && stored && stored.id === previous.draftId) {
        const next = withReceipt(snapshot, { ...previous, message: stored.message });
        setDraft(next); await queueSave(next); signal.throwIfAborted();
      }
      setFeedback({ tone: "neutral", text: stored ? "已读回扩展记录。请以平台编辑器和草稿箱中的实际内容为准。" : "扩展中当前没有待传内容；这不能证明草稿已保存。核对平台后，可返回确认内容并传入下一组。" });
    });
  }

  function confirmOutcome(outcome: "saved" | "not_saved") {
    if (!draft || !receipt || !readback?.checked || (job && !matchingJob)) return;
    const confirmed: SyncReceipt = { ...receipt, status: outcome === "saved" ? "confirmed_by_user" : "failed", message: outcome === "saved"
      ? `你已在${limit.label}当前账号的草稿箱核对标题、文案与全部图片，并确认草稿已保存。这是人工确认。`
      : `你已在${limit.label}核对，草稿尚未保存。请先处理当前编辑器中的内容，再在平台折页面板结束本次传图。` };
    const next = withReceipt(draft, confirmed);
    void runOperation("正在记录人工核对结果…", async (signal) => {
      await queueSave(next); signal.throwIfAborted(); setDraft(next);
      setFeedback({ tone: "neutral", text: "已记录你的核对结果。要传下一组或更换账号，请先在平台折页面板结束本次传图。" });
    });
  }

  function closeDialog(returnToEditor = false) {
    operationRef.current?.abort();
    clientRef.current?.dispose(); clientRef.current = null;
    setConnectionState("idle");
    if (returnToEditor) onReturnToEditor(); else onClose();
  }
  function goToStep(next: DraftStep) {
    if (operationRef.current) return;
    setFeedback(null); setStep(next);
    if (next === "browser" && connectionState !== "connected") checkExtension();
  }
  const stepInfo = STEPS.find((item) => item.id === step)!;
  const nextHint = step === "content" ? !draft ? "先用当前海报开始，或继续已有的本机存档。" : contentReady ? "确认当前平台的完整内容后，下一步交给浏览器。" : "请先处理下方检查提示，再继续。"
    : step === "browser" ? "每次只传当前平台；换账号时，请在平台自行切换并结束上一组传图。" : "“已填入编辑器”不代表草稿已保存，请在平台草稿箱核对。";
  const platformTabs = <div className="draft-sync-platforms" role="group" aria-label="选择同步平台">{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(busy)} onClick={() => { setPlatform(target); setFeedback(null); }}>{DRAFT_LIMITS[target].label}<span>{step === "content" ? "独立填写标题与文案" : "使用平台当前登录账号"}</span></button>)}</div>;
  const openPlatform = <a className="draft-sync-platform-link" href={EDITOR_URLS[platform]} target="_blank" rel="noopener noreferrer">{platform === "wechat" ? "打开公众号后台" : "打开小红书图文编辑器"}</a>;

  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><span className="eyebrow">图片完成后，继续这三步</span><h2 id="draft-sync-title">同步到平台草稿</h2><p id="draft-sync-description">把你的完整图片和文案交给浏览器，在平台当前账号的编辑器导入、保存，再核对草稿。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" onClick={() => closeDialog()}>×</button>
      </header>
      <nav className="draft-sync-steps" aria-label="草稿保存步骤">{STEPS.map((item, index) => <button type="button" key={item.id} aria-current={step === item.id ? "step" : undefined} disabled={Boolean(busy) || (item.id === "browser" && !draft?.images.length) || (item.id === "results" && !draft)} onClick={() => goToStep(item.id)}><span aria-hidden="true">{index + 1}</span>{item.label}</button>)}</nav>
      <div className="draft-sync-scroll">
        <div className="draft-sync-step-heading"><h3 ref={stepHeadingRef} tabIndex={-1}>{stepInfo.label}</h3><p>{stepInfo.hint}</p></div>
        {step === "content" && <>
          <section className="draft-sync-archive" aria-label="本机存档">
            <div><strong>{storedDraft ? "可继续上次的本机草稿" : "需要稍后继续？可以存到本机"}</strong><p>{storedDraft ? `${storedDraft.images.length} 张图片 · ${new Date(storedDraft.updatedAt).toLocaleString("zh-CN")}` : "点击下方“存到本机”后，下次在同一浏览器、同一网址打开可继续。"}</p></div>
            <div className="draft-sync-inline-actions">
              {storedDraft && <button type="button" disabled={Boolean(busy)} onClick={useStoredDraft}>继续本机存档</button>}
              {draft && <button type="button" disabled={Boolean(busy) || !canCollect || storageState === "loading"} onClick={createDraft}>用当前图片新建</button>}
              {(storedDraft || storageState === "error") && <button type="button" className="draft-sync-danger" disabled={Boolean(busy)} onClick={deleteArchive}>删除本机存档</button>}
            </div>
            {storageState === "loading" && <p role="status">正在检查本机存档…</p>}
            {storageError && <div className="draft-sync-message error" role="alert">{storageError}<button type="button" disabled={Boolean(busy)} onClick={() => void readStoredDraft()}>重新读取</button></div>}
            {!canCollect && <p>海报正在处理，排版完成后即可开始；也可继续已有存档。</p>}
          </section>
          {!draft ? <div className="draft-sync-empty"><span aria-hidden="true">01</span><h3>先把当前海报带进来</h3><p>点击“用当前海报开始”，生成全部海报的图片副本。你可以替换图片、调整顺序，再给两个平台分别写文案。</p><p className="draft-sync-small">下一步通过浏览器扩展传入这些真实内容。</p></div> : <div className="draft-sync-columns">
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

          <section className="draft-sync-editor" aria-label="平台文案">
            {platformTabs}
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].title)} / {limit.title} 个字符（本工具上限）</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={6} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="为这个平台写一段配文" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字；两个平台分别保存文案</small><small>话题 {countHashtags(draft.content[platform].body)} / {limit.topics} 个；每个话题以 # 开头，用空格分隔</small></div>
            <p className="draft-sync-small">两个平台的标题与文案互不覆盖。每次只传入当前选择的平台。</p>
          </section>
          </div>}
        </>}
        {step === "browser" && draft && <>
          {platformTabs}
          <section className={`draft-sync-service ${connectionState === "connected" ? "connected" : ""}`} aria-label="浏览器扩展连接">
            <h3>{connectionState === "connected" ? "浏览器扩展已连接" : connectionState === "checking" ? "正在检查浏览器扩展…" : "连接浏览器扩展"}</h3>
            <p>请在已登录平台的同一个 Chrome 中使用 Tampermonkey，并安装折页传图脚本 {BROWSER_SYNC_VERSION}。扩展只在你点击平台面板的导入按钮后上传内容。</p>
            <div className="draft-sync-extension-actions"><a href="https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo" target="_blank" rel="noopener noreferrer">打开 Tampermonkey 商店</a><a href="/zhepage-browser-sync.user.js" target="_blank" rel="noopener noreferrer">安装或更新折页传图脚本</a><button type="button" disabled={Boolean(busy)} onClick={checkExtension}>检查浏览器扩展</button></div>
            <p className="draft-sync-small">首次安装后，在扩展详情打开“允许用户脚本”，并允许在折页和所用平台运行；更新脚本后刷新此页，再继续本机存档。</p>
            {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
          </section>
          <section className="draft-sync-selection-summary" aria-label="本次传入内容">
            <h3>{limit.label} · {draft.content[platform].title || "未填写标题"}</h3>
            <p className="draft-sync-small">完整传入 {draft.images.length} 张图片，顺序与“确认内容”一致 · {(draft.images.reduce((sum, image) => sum + image.blob.size, 0) / 1024 / 1024).toFixed(2)} MiB</p>
            <p className="draft-sync-summary-body">{draft.content[platform].body || "本平台未填写配文"}</p>
            <p className="draft-sync-small">图片、双平台文案和核对记录同时保留一份本机副本。这里不会替你选择、切换账号或公开发布。</p>
            {openPlatform}
            <button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button>
          </section>
        </>}
        {draft && step !== "results" && !!issues.length && <section className="draft-sync-validation" aria-label="同步前检查"><h3>同步前检查</h3><ul>{issues.map((issue, index) => <li key={`${issue.code}-${issue.imageId || index}`} className={issue.severity}><b>{limit.label}：</b>{issue.message}</li>)}</ul>{!!warnings.length && <label className="draft-sync-check"><input type="checkbox" checked={acceptedWarnings === warningsKey} disabled={Boolean(busy)} onChange={(event) => setAcceptedWarnings(event.target.checked ? warningsKey : "")} /><span>我已核对图片，沿用当前尺寸和比例</span></label>}</section>}
        {step === "results" && <>
          {platformTabs}
          <section className="draft-sync-service" aria-label="平台核对步骤">
            <h3>在当前登录账号的编辑器中完成</h3>
            <ol className="draft-sync-browser-steps"><li>打开平台，确认当前账号。小红书进入“图文”，公众号进入“贴图”，使用空白编辑器。</li><li>在折页面板点击“检查待传内容”，核对标题和图片总数，再点击“填入当前编辑器”。</li><li>核对全部图片的顺序、标题与正文，再保存草稿；打开平台草稿箱确认实际结果。</li></ol>
            {openPlatform}
            <p className="draft-sync-small">如果只上传了一部分，先核对编辑器中的实际图片；不要再次导入同一组。完成或放弃本组后，在平台折页面板点击“结束本次传图”。下一组仍可从本窗口继续。</p>
          </section>
          <section className="draft-sync-results" aria-label="当前平台传图结果">
            <div className="draft-sync-section-title"><h3>{contentChanged[platform] ? "上次传图结果（当前编辑尚未传入）" : "传图与草稿状态"}</h3><button type="button" disabled={Boolean(busy)} onClick={readTransfer}>读取传图状态</button></div>
            {job && <article className="draft-sync-receipt needs_confirmation"><div><strong>{job.title} · {job.imageCount} 张图片</strong><b>{JOB_LABELS[job.status]}</b></div><p>{job.message}</p>{!matchingJob && <p>这是扩展中现有的一组内容，尚未与本机草稿记录匹配。请到平台核对并结束该组，再传入当前内容。</p>}</article>}
            {!job && <p className="draft-sync-message neutral">{readback?.checked ? "扩展中当前没有待传内容。平台草稿是否存在，需要到平台草稿箱核对。" : "尚未读回当前平台的完整状态，请点击“读取传图状态”。"}</p>}
            {receipt && <article className={`draft-sync-receipt ${receipt.status}`} aria-label="本次草稿人工核对记录"><div><strong>{limit.label} · 人工核对记录</strong><b>{receipt.status === "confirmed_by_user" ? "用户确认已保存" : receipt.status === "failed" ? "尚未确认保存" : "草稿结果待核对"}</b></div><p>{receipt.message}</p>
              {receipt.status !== "confirmed_by_user" && <><p>只有在平台草稿箱核对本次标题、文案和全部图片后，才记录实际结果。</p><div className="draft-sync-confirm-actions"><button type="button" disabled={Boolean(busy) || !readback?.checked || Boolean(job && !matchingJob)} onClick={() => confirmOutcome("saved")}>已在草稿箱核对，确认已保存</button><button type="button" disabled={Boolean(busy) || !readback?.checked || Boolean(job && !matchingJob)} onClick={() => confirmOutcome("not_saved")}>已核对，尚未保存</button></div></>}
            </article>}
            {storageError && <p className="draft-sync-message error" role="alert">{storageError}</p>}
          </section>
        </>}
      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy} 关闭窗口可停止等待；已经传给扩展的内容仍需核对。</p> : <>{feedback && <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}<p>{nextHint}</p></>}{archiveFeedback && <p className={archiveFeedback.tone} role="status">{archiveFeedback.text}</p>}{draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}</div>
        <div className="draft-sync-footer-actions">
          <button type="button" disabled={Boolean(busy) || !draft} onClick={saveDraft}>存到本机</button>
          {step === "content" ? <button type="button" className="primary" disabled={Boolean(busy) || (draft ? !contentReady : !canCollect || storageState === "loading")} onClick={() => draft ? goToStep("browser") : createDraft()}>{draft ? "下一步：交给浏览器" : "用当前海报开始"}</button> : step === "browser" ? <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>上一步</button><button type="button" className="primary" disabled={!canPrepare} onClick={submitDraft}>存入浏览器扩展</button></> : <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button><button type="button" className="primary" onClick={() => closeDialog()}>完成</button></>}
        </div>
      </footer>
    </div>
  </dialog>;
}
