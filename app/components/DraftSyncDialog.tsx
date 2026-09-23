"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from "../../lib/draftSync/localDraftStore";
import type { DraftImage, DraftPlatform, LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { countCharacters, countHashtags, DRAFT_LIMITS, imageMetadata, readDraftImage, validateDraft } from "../../lib/draftSync/validation";
import { loadBinding, listAccounts, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";
import LocalSyncConnection from "./LocalSyncConnection";
import WechatDraftPanel from "./WechatDraftPanel";
import XiaohongshuDraftPanel from "./XiaohongshuDraftPanel";

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
  // Generated local Blobs retain their original dimensions and bytes.
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imageRef} alt={`草稿图片 ${index + 1}：${image.name}`} width={image.width} height={image.height} />;
}

export default function DraftSyncDialog({ open, openerRef, title, sourceFormat, canCollect, collectAssets, onClose, onReturnToEditor }: DraftSyncDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replacementIdRef = useRef<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const loadStartedRef = useRef(false);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const receiptSnapshotRef = useRef<LocalDraft | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [step, setStep] = useState<DraftStep>("content");
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState("");
  const [platform, setPlatform] = useState<DraftPlatform>("xiaohongshu");
  const [acceptedWarnings, setAcceptedWarnings] = useState("");
  const [contentChanged, setContentChanged] = useState<Record<DraftPlatform, boolean>>({ xiaohongshu: false, wechat: false });
  const [binding, setBinding] = useState<Binding | null>(null);
  const [accounts, setAccounts] = useState<LocalWechatAccount[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");

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
      operationRef.current?.abort();
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
    setDraft({ ...storedDraft, selectedAccountIds: [], receipts: storedDraft.receipts });
    setContentChanged({ xiaohongshu: false, wechat: false }); setAcceptedWarnings(""); setStep("content");
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
        selectedAccountIds: [], receipts: (draft || storedDraft)?.receipts.filter((item) => item.jobId) || [],
      });
      setContentChanged({ xiaohongshu: false, wechat: true }); setStep("content"); setAcceptedWarnings(""); setArchiveFeedback(null);
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
  const ratioWarnings = warnings.filter((issue) => issue.code === "image-ratio");
  const displayIssues = issues.filter((issue) => issue.code !== "image-ratio");
  if (ratioWarnings.length) displayIssues.push({ severity: "warning", code: "image-ratio-summary", message: `${ratioWarnings.length} 张图片与建议比例 ${limit.sizeLabel} 不同，可确认沿用。这只是排版建议，并非平台强制要求。` });
  const warningsKey = JSON.stringify({ platform, metadata, warnings: warnings.map(({ code, imageId }) => ({ code, imageId })) });
  const contentReady = Boolean(draft && !errors.length && (!warnings.length || acceptedWarnings === warningsKey));
  function closeDialog(returnToEditor = false) {
    operationRef.current?.abort();
    if (returnToEditor) onReturnToEditor(); else onClose();
  }
  function goToStep(next: DraftStep) {
    if (operationRef.current) return;
    setFeedback(null); setStep(next);
  }
  const contentCheck = draft && issues.length > 0 ? <section className="draft-sync-validation" aria-label="同步前检查">
    <h3>{contentReady ? "图片提示" : "请先完成以下检查"}</h3>
    <ul>{displayIssues.map((issue, index) => <li key={`${issue.code}-${issue.imageId || index}`} className={issue.severity}><b>{limit.label}：</b>{issue.message}</li>)}</ul>
    {!!warnings.length && <label className="draft-sync-check"><input type="checkbox" checked={acceptedWarnings === warningsKey} disabled={Boolean(busy)} onChange={(event) => setAcceptedWarnings(event.target.checked ? warningsKey : "")} /><span>我已核对图片，沿用当前尺寸和比例</span></label>}
    {step !== "content" && errors.length > 0 && <button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回修改内容</button>}
  </section> : null;
  async function persistWechatReceipt(snapshot: LocalDraft, nextReceipt: SyncReceipt, signal: AbortSignal) {
    signal.throwIfAborted();
    const known = receiptSnapshotRef.current;
    const base = known?.id === snapshot.id ? { ...snapshot, receipts: [...snapshot.receipts.filter((item) => !known.receipts.some((recent) => recent.platform === item.platform && recent.accountId === item.accountId)), ...known.receipts] } : snapshot;
    const next = withReceipt(base, nextReceipt);
    await queueSave(next); signal.throwIfAborted(); receiptSnapshotRef.current = next; setDraft(next);
    return next;
  }
  const steps = STEPS.map((item) => platform === "wechat" && item.id === "browser" ? { ...item, label: "选择公众号", hint: "勾选目标公众号，选择同步到草稿箱或立即发布。" } : platform === "wechat" && item.id === "results" ? { ...item, hint: "查看每个公众号的处理结果。存草稿后，可去后台检查图片或设置定时发布。" } : item);
  const stepInfo = steps.find((item) => item.id === step)!;
  const nextHint = step === "content" ? !draft ? "先用当前海报开始，或继续已有的本机存档。" : contentReady ? `图片和文案已准备好，可以继续选择账号。` : "请先处理下方检查提示，再继续。"
    : !binding ? "首次连接后，小红书和公众号都可以在这里同步。"
    : platform === "wechat" ? "草稿保留在所选公众号；立即发布会另行确认目标和内容。" : step === "browser" ? "保存后可在小红书专用窗口查看草稿。" : "以草稿箱中重新打开的内容为准；结果待核对时请勿重复创建。";
  const platformTabs = <div className="draft-sync-platforms" role="group" aria-label="选择同步平台">{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(busy)} onClick={() => { setPlatform(target); setFeedback(null); }}>{DRAFT_LIMITS[target].label}<span>{step === "content" ? "独立填写标题与文案" : target === "wechat" ? "存草稿或立即发布" : "保存到草稿箱"}</span></button>)}</div>;


  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><span className="eyebrow">海报已就绪，继续下一步</span><h2 id="draft-sync-title">同步与发布</h2><p id="draft-sync-description">小红书存草稿；公众号可存草稿或立即发布。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" onClick={() => closeDialog()}>×</button>
      </header>
      <nav className="draft-sync-steps" aria-label="草稿保存步骤">{steps.map((item, index) => <button type="button" key={item.id} aria-current={step === item.id ? "step" : undefined} disabled={Boolean(busy) || (item.id === "browser" && !draft?.images.length) || (item.id === "results" && !draft)} onClick={() => goToStep(item.id)}><span aria-hidden="true">{index + 1}</span>{item.label}</button>)}</nav>
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
          {!draft ? <div className="draft-sync-empty"><span aria-hidden="true">01</span><h3>先把当前海报带进来</h3><p>点击“用当前海报开始”，生成全部海报的图片副本。你可以替换图片、调整顺序，再给两个平台分别写文案。</p></div> : <div className="draft-sync-columns">
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
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].title)} / {limit.title} 字（本工具上限）</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={6} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="为这个平台写一段配文" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }), platform)} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字；平台文案分别保存</small>{platform === "xiaohongshu" && <small>话题 {countHashtags(draft.content[platform].body)} / {limit.topics} 个；以 # 开头，用空格分隔</small>}</div>
            <p className="draft-sync-small">切换平台后，可分别填写标题和配文。</p>
          </section>
          </div>}
        </>}
        {step === "browser" && draft && <>
          {platformTabs}
          <section className="draft-sync-selection-summary" aria-label="本次传入内容">
            <h3>{limit.label} · {draft.content[platform].title || "未填写标题"}</h3>
            <p className="draft-sync-small">共 {draft.images.length} 张图片，按已确认的顺序同步。</p>
            <details><summary>查看本次配文</summary><p className="draft-sync-summary-body">{draft.content[platform].body || "未填写配文"}</p></details>
            <button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button>
          </section>
        </>}
        {step === "results" && platformTabs}
        {open && draft && step !== "content" && <>
          {connectionLoading ? <p className="draft-sync-small" role="status">正在恢复这台电脑的连接…</p> : <>
            {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
            <LocalSyncConnection binding={binding} accounts={accounts} busy={Boolean(busy)} runOperation={runOperation} onChange={changeConnection} />
            {binding && platform === "wechat" && <WechatDraftPanel key={draft.id} draft={draft} binding={binding} accounts={accounts} onAccountsChange={changeConnection} view={step} contentReady={contentReady} contentCheck={contentCheck} contentChanged={contentChanged.wechat} busy={Boolean(busy)} runOperation={runOperation} persistReceipt={persistWechatReceipt} onSubmitted={() => { setStep("results"); setContentChanged((current) => ({ ...current, wechat: false })); }} />}
            {binding && platform === "xiaohongshu" && <XiaohongshuDraftPanel key={draft.id} draft={draft} binding={binding} contentReady={contentReady} contentCheck={contentCheck} contentChanged={contentChanged.xiaohongshu} busy={Boolean(busy)} runOperation={runOperation} persistReceipt={persistWechatReceipt} onSubmitted={() => { setStep("results"); setContentChanged((current) => ({ ...current, xiaohongshu: false })); }} />}
          </>}
        </>}
        {step === "content" && contentCheck}

      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy} 关闭窗口可停止等待；已经提交的任务仍需读取状态和核对结果。</p> : <>{feedback && <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}<p>{nextHint}</p></>}{archiveFeedback && <p className={archiveFeedback.tone} role="status">{archiveFeedback.text}</p>}{draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}</div>
        <div className="draft-sync-footer-actions">
          <button type="button" disabled={Boolean(busy) || !draft} onClick={saveDraft}>存到本机</button>
          {step === "content" ? <button type="button" className="primary" disabled={Boolean(busy) || (draft ? !contentReady : !canCollect || storageState === "loading")} onClick={() => draft ? goToStep("browser") : createDraft()}>{draft ? platform === "wechat" ? "下一步：选择公众号" : "下一步：连接小红书" : "用当前海报开始"}</button> : step === "browser" ? <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>上一步</button></> : <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button><button type="button" className="primary" onClick={() => closeDialog()}>完成</button></>}
        </div>
      </footer>
    </div>
  </dialog>;
}
