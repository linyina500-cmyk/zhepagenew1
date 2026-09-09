"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";
import { acknowledgeUnconfirmed, addWechatAccount, addXiaohongshuAccount, cancelXiaohongshuLogin, getStartupConnection, listAccounts, removeAccount, syncDraft, type CompanionConnection } from "../../lib/draftSync/companionClient";
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
type DraftStep = "content" | "accounts" | "results";
type AccountProgress = { platform: DraftPlatform; phase: "waiting" | "cancelling" | "unconfirmed"; error?: string };
type AccountAttempt = {
  connection: CompanionConnection;
  controller: AbortController;
  cancelling: boolean;
  cancellationAttempted: boolean;
  closeAfter?: "dialog" | "editor";
} & ({ platform: "xiaohongshu"; loginRequestId: string } | { platform: "wechat" });
const STEPS: { id: DraftStep; label: string; hint: string }[] = [
  { id: "content", label: "确认内容", hint: "检查图片，为两个平台分别填写标题和文案。" },
  { id: "accounts", label: "选择账号", hint: "连接要使用的账号，勾选后保存到平台草稿。" },
  { id: "results", label: "保存结果", hint: "逐个查看账号结果，再到对应平台检查和发布。" },
];
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
  const accountAttemptRef = useRef<AccountAttempt | null>(null);
  const loadStartedRef = useRef(false);
  const startupAttemptRef = useRef<{ token: string; version: number } | null>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [step, setStep] = useState<DraftStep>("content");
  const [isLocalPage] = useState(() => typeof window !== "undefined" && window.location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(window.location.hostname));
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [startupVersion, setStartupVersion] = useState(0);
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [storedDraft, setStoredDraft] = useState<LocalDraft | null>(null);
  const [storageState, setStorageState] = useState<"loading" | "ready" | "error">("loading");
  const [storageError, setStorageError] = useState("");
  const [autoSave, setAutoSave] = useState(false);
  const [archiveFeedback, setArchiveFeedback] = useState<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState("");
  const [accountProgress, setAccountProgress] = useState<AccountProgress | null>(null);
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

  useEffect(() => {
    const onStartupConnection = () => setStartupVersion((current) => current + 1);
    window.addEventListener("zhepage-startup-connection", onStartupConnection);
    return () => window.removeEventListener("zhepage-startup-connection", onStartupConnection);
  }, []);

  useEffect(() => {
    if (!open || busy || operationRef.current) return;
    const startup = getStartupConnection();
    if (!startup) return;
    const interrupted = accountAttemptRef.current;
    const recoveringLogin = accountProgress?.phase === "unconfirmed" && interrupted && startup.token !== interrupted.connection.token;
    if ((accountProgress || interrupted) && !recoveringLogin) return;
    const previous = startupAttemptRef.current;
    if (previous?.token === startup.token && previous.version === startupVersion) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || operationRef.current || (recoveringLogin ? accountAttemptRef.current !== interrupted || interrupted.cancelling : Boolean(accountAttemptRef.current))) return;
      // A launcher event arriving during another operation waits for idle.
      // Record only a started attempt; failures need a new launcher event.
      startupAttemptRef.current = { token: startup.token, version: startupVersion };
      return runOperation("正在自动连接…", async () => {
        // A helper's token is fixed for its process lifetime. Verify the new
        // helper before releasing a failed wait from the previous process.
        if (recoveringLogin) interrupted.cancelling = true;
        setConnection(null);
        setConnectionState("connecting");
        try {
          const currentAccounts = await listAccounts(startup);
          if (recoveringLogin && accountAttemptRef.current === interrupted) {
            accountAttemptRef.current = null;
            setAccountProgress(null);
            interrupted.controller.abort();
          }
          applyAccounts(currentAccounts);
          setConnection(startup);
          setConnectionState("connected");
          if (recoveringLogin) setFeedback({ tone: "neutral", text: "本机同步已重新连接，请核对账号后继续。上次登录未在本页确认。" });
        } catch (error) {
          if (recoveringLogin && accountAttemptRef.current === interrupted) interrupted.cancelling = false;
          setConnectionState("error");
          throw error;
        }
      });
    });
    return () => { cancelled = true; };
  }, [open, busy, accountProgress, startupVersion]);

  useEffect(() => {
    if (!open) return;
    stepHeadingRef.current?.focus({ preventScroll: true });
    dialogRef.current?.querySelector(".draft-sync-scroll")?.scrollTo({ top: 0 });
  }, [open, step]);

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
    setStep("content");
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
      setStep("content");
      setAcceptedWarnings("");
      setArchiveFeedback(null);
      setFeedback({ tone: "success", text: `已准备 ${images.length} 张图片。检查标题和文案后，进入下一步选择账号。` });
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
    if (!isLocalPage || !pairingCode.trim() || accountAttemptRef.current) return;
    const next = { token: pairingCode.trim() };
    await runOperation("正在连接本机助手…", async () => {
      setConnectionState("connecting");
      try {
        applyAccounts(await listAccounts(next));
        setConnection(next);
        setPairingCode("");
        setConnectionState("connected");
        setFeedback({ tone: "success", text: "已连接，可以添加并选择平台账号。" });
      } catch (error) {
        setConnectionState("error");
        throw error;
      }
    });
  }

  function addAccount() {
    if (!connection || operationRef.current || accountAttemptRef.current) return;
    const label = accountName.trim() || (platform === "wechat" ? "公众号账号" : "小红书账号");
    const credentials = { appId: appId.trim(), appSecret: appSecret.trim() };
    const attempt: AccountAttempt = {
      connection, controller: new AbortController(), cancelling: false, cancellationAttempted: false,
      ...(platform === "xiaohongshu" ? { platform, loginRequestId: crypto.randomUUID() } : { platform }),
    };
    accountAttemptRef.current = attempt;
    setAccountProgress({ platform, phase: "waiting" });
    setFeedback(null);
    setAppSecret("");
    void (async () => {
      try {
        const account = attempt.platform === "wechat"
          ? await addWechatAccount(attempt.connection, { displayName: label, ...credentials })
          : await addXiaohongshuAccount(attempt.connection, label, attempt.loginRequestId, attempt.controller.signal);
        // A cancellation response, followed by a fresh account list if the
        // save already finished, owns the outcome once cancellation starts.
        if (accountAttemptRef.current !== attempt || attempt.cancelling) return;
        setAccounts((current) => [...current.filter((item) => item.id !== account.id), account]);
        setAccountName("");
        setAppId("");
        accountAttemptRef.current = null;
        setAccountProgress(null);
        setFeedback({ tone: "success", text: `${account.displayName} 已添加，请勾选需要同步的账号` });
      } catch (error) {
        if (accountAttemptRef.current !== attempt || attempt.cancelling) return;
        if (attempt.platform === "xiaohongshu") {
          // Losing the HTTP response does not prove that the login stopped.
          // Resolve the server operation before allowing another account task.
          if (!attempt.cancellationAttempted) await cancelAccountLogin(undefined, errorMessage(error));
          else setAccountProgress({ platform: attempt.platform, phase: "unconfirmed", error: errorMessage(error) });
        } else {
          accountAttemptRef.current = null;
          setAccountProgress(null);
          setFeedback({ tone: "error", text: errorMessage(error) });
        }
      }
    })();
  }

  async function cancelAccountLogin(closeAfter?: "dialog" | "editor", originalError?: string) {
    const attempt = accountAttemptRef.current;
    if (!attempt || attempt.platform !== "xiaohongshu") return;
    if (closeAfter) attempt.closeAfter = closeAfter;
    if (attempt.cancelling) return;
    attempt.cancelling = true;
    attempt.cancellationAttempted = true;
    setAccountProgress({ platform: "xiaohongshu", phase: "cancelling" });
    try {
      const cancelled = await cancelXiaohongshuLogin(attempt.connection, attempt.loginRequestId);
      if (accountAttemptRef.current !== attempt) return;
      // false means this login has finished or is no longer the active one.
      // Refresh its actual outcome without cancelling a later login.
      if (!cancelled) applyAccounts(await listAccounts(attempt.connection));
      if (accountAttemptRef.current !== attempt) return;
      accountAttemptRef.current = null;
      setAccountProgress(null);
      attempt.controller.abort();
      setFeedback({ tone: originalError ? "error" : "neutral", text: originalError ? `${originalError} 已结束这次登录检查，可以重新尝试。` : cancelled ? "已取消小红书登录，可以继续编辑或重新添加账号。" : "这次登录已经结束，已刷新账号列表。请核对账号是否已添加。" });
      if (attempt.closeAfter) closeDialog(attempt.closeAfter === "editor");
    } catch (error) {
      if (accountAttemptRef.current !== attempt) return;
      attempt.cancelling = false;
      attempt.closeAfter = undefined;
      setAccountProgress({ platform: "xiaohongshu", phase: "unconfirmed", error: errorMessage(error) });
    }
  }

  function refreshAccounts() {
    if (!connection || accountAttemptRef.current) return;
    void runOperation("正在刷新账号…", async () => { applyAccounts(await listAccounts(connection)); });
  }

  function deleteAccount(account: DraftAccount) {
    if (!connection || accountAttemptRef.current) return;
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
  const canSync = Boolean(connection && draft && selectedAccounts.length && !unknownAccounts.length && selectedAccounts.every((account) => account.ready) && !errors.length && (!warnings.length || acceptedWarnings === warningsKey) && !unresolvedSelection && !busy && !accountProgress);

  function submitDraft() {
    if (!connection || !draft || !canSync || accountAttemptRef.current) return;
    const snapshot = draft;
    const connectionSnapshot = connection;
    void runOperation("正在核对所选账号…", async () => {
      const currentAccounts = await listAccounts(connectionSnapshot);
      applyAccounts(currentAccounts);
      const targets = snapshot.selectedAccountIds.map((id) => currentAccounts.find((account) => account.id === id));
      if (targets.some((account) => !account?.ready || account.syncBlocked || pendingChecks[account.id])) throw new Error("部分所选账号不可用或仍待核实，请检查账号后重试");
      setStep("results");
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
    if (!connection || !account || accountAttemptRef.current || (!pendingChecks[accountId] && !account.syncBlocked)) return;
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
      setFeedback({ tone: "neutral", text: outcome === "saved" ? `已记录你确认 ${account.displayName} 的草稿已保存，并取消该账号勾选。` : `已记录你确认 ${account.displayName} 的草稿未保存。需要重试时，点击“返回选择账号”检查后再保存。` });
    });
  }

  const limit = DRAFT_LIMITS[platform];
  const platformAccounts = accounts.filter((account) => account.platform === platform);
  const serverPending = accounts.filter((account) => account.syncBlocked && !pendingChecks[account.id]).map((account): SyncReceipt => ({ accountId: account.id, platform: account.platform, status: "needs_confirmation", message: "本机助手记录了一次未确认的同步。请先在对应平台账号检查草稿，再如实选择已保存或未保存；核对前不能再次同步。" }));
  const allReceipts = [...(draft?.receipts.filter((receipt) => !pendingChecks[receipt.accountId] && !serverPending.some((item) => item.accountId === receipt.accountId)) || []), ...Object.values(pendingChecks), ...serverPending];

  function closeDialog(returnToEditor = false) {
    if (operationRef.current) return;
    if (accountAttemptRef.current?.platform === "xiaohongshu") {
      void cancelAccountLogin(returnToEditor ? "editor" : "dialog");
      return;
    }
    setAppSecret("");
    setPairingCode("");
    if (returnToEditor) onReturnToEditor(); else onClose();
  }

  function goToStep(next: DraftStep) {
    if (operationRef.current) return;
    setFeedback(null);
    setAppSecret("");
    setStep(next);
  }

  const stepInfo = STEPS.find((item) => item.id === step)!;
  const nextHint = step === "content"
    ? !draft ? "先用当前海报开始，或继续已有的本机存档。" : !draft.images.length ? "请先添加至少一张图片。" : "检查完内容后，下一步选择账号。"
    : step === "accounts"
      ? accountProgress ? "账号连接尚未结束。你可以继续编辑；添加、移除和保存到平台草稿需等本次连接结束。" : !connection ? "请先用 Mac 启动工具打开本机版。" : unknownAccounts.length ? "请重新连接存档中的账号，或清除不可用选择。" : unresolvedSelection ? "所选账号有待核实结果，请先查看并核对。" : !selectedAccounts.length ? "请至少勾选一个要保存的账号。" : selectedAccounts.some((account) => !account.ready) ? "所选账号需要重新登录。" : errors.length ? "请返回确认内容，修改检查中提示的问题。" : warnings.length && acceptedWarnings !== warningsKey ? "请先核对下方图片尺寸提示。" : `将 ${draft?.images.length || 0} 张图片保存到 ${selectedAccounts.length} 个账号草稿，之后仍需到平台发布。`
      : allReceipts.some((receipt) => receipt.status === "needs_confirmation" && (pendingChecks[receipt.accountId] || accounts.find((account) => account.id === receipt.accountId)?.syncBlocked)) ? "待核实的账号请先到平台检查，再记录实际结果。" : "已保存的草稿可在对应平台继续编辑和发布。未保存的账号可返回选择后重试。";
  const platformTabs = <div className="draft-sync-platforms" role="group" aria-label={step === "content" ? "选择文案平台" : "选择账号平台"}>{PLATFORMS.map((target) => <button type="button" key={target} aria-pressed={platform === target} disabled={Boolean(busy)} onClick={() => { setPlatform(target); setAppSecret(""); }}>{DRAFT_LIMITS[target].label}<span>{step === "content" ? "独立填写标题与文案" : `已选 ${selectedAccounts.filter((account) => account.platform === target).length} 个账号`}</span></button>)}</div>;

  return <dialog ref={dialogRef} className="draft-sync-dialog" aria-labelledby="draft-sync-title" aria-describedby="draft-sync-description" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
    <div className="draft-sync-frame">
      <header className="draft-sync-header">
        <div><span className="eyebrow">图片完成后，继续这三步</span><h2 id="draft-sync-title">同步到平台草稿</h2><p id="draft-sync-description">先确认内容，再选账号，最后查看保存结果。平台发布由你完成。</p></div>
        <button type="button" className="modal-close" aria-label="关闭草稿同步" disabled={Boolean(busy)} onClick={() => closeDialog()}>×</button>
      </header>
      <nav className="draft-sync-steps" aria-label="草稿保存步骤">{STEPS.map((item, index) => <button type="button" key={item.id} aria-current={step === item.id ? "step" : undefined} disabled={Boolean(busy) || (item.id === "accounts" && !draft?.images.length) || (item.id === "results" && !allReceipts.length)} onClick={() => goToStep(item.id)}><span aria-hidden="true">{index + 1}</span>{item.label}</button>)}</nav>
      {accountProgress && <section className="draft-sync-login-progress" aria-label="账号连接进度" aria-live="polite">
        <div><strong>{accountProgress.platform === "wechat" ? "正在验证公众号" : accountProgress.phase === "cancelling" ? "正在取消登录…" : accountProgress.phase === "unconfirmed" ? "登录状态尚未确认" : "请在新窗口扫码"}</strong><p>{accountProgress.platform === "wechat" ? "验证期间可以继续编辑。关闭此窗口后，验证仍会继续；稍后回来查看结果。" : accountProgress.phase === "cancelling" ? "正在确认本次登录已经结束。期间仍可继续编辑，完成前暂不能添加账号或保存平台草稿。" : accountProgress.phase === "unconfirmed" ? "尚未确认登录已经停止。可以继续编辑，请点击“取消登录”重新核对。" : "请在打开的新窗口中用小红书扫码。等待时可编辑内容或存到本机；添加、移除账号及保存平台草稿需等登录结束。"}</p>{accountProgress.error && <p className="error" role="alert">{accountProgress.error}</p>}</div>
        {accountProgress.platform === "xiaohongshu" && <button type="button" disabled={accountProgress.phase === "cancelling"} onClick={() => void cancelAccountLogin()}>取消登录</button>}
      </section>}
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
          {!draft ? <div className="draft-sync-empty"><span aria-hidden="true">01</span><h3>先把当前海报带进来</h3><p>点击“用当前海报开始”，生成可单独编辑的图片副本。你可以替换图片、调整顺序，再给两个平台分别写文案。</p>{!connection && <div className="draft-sync-initial-start"><p>首次连接平台账号，需要先下载工具，在本机版继续操作。</p><div className="draft-sync-inline-actions"><a className="draft-sync-startup-link" href="/downloads/zhepage-draft-helper.zip" download>下载 Mac 启动工具</a><a className="draft-sync-startup-link secondary" href="http://127.0.0.1:5173/" target="_blank" rel="noopener noreferrer">打开本机版</a></div><p>下载解压后双击“启动折页.command”，按提示完成准备；本网页内容不会自动带入本机版。</p></div>}</div> : <div className="draft-sync-columns">
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
            <div className="field-stack"><label htmlFor="draft-platform-title">{limit.label}标题</label><input id="draft-platform-title" value={draft.content[platform].title} disabled={Boolean(busy)} onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], title: event.target.value } } }))} /><small>{countCharacters(draft.content[platform].title)} / {limit.title} 字（本工具上限）</small></div>
            <div className="field-stack"><label htmlFor="draft-platform-body">{limit.label}文案</label><textarea id="draft-platform-body" rows={6} value={draft.content[platform].body} disabled={Boolean(busy)} placeholder="为这个平台写一段配文" onChange={(event) => updateDraft((current) => ({ ...current, content: { ...current.content, [platform]: { ...current.content[platform], body: event.target.value } } }))} /><small>{countCharacters(draft.content[platform].body)} / {limit.body} 字{platform === "wechat" ? " · 约680个汉字以内（表情也占用长度）" : ""}；两个平台分别保存文案</small></div>
            <p className="draft-sync-small">只用一个平台时，检查对应平台的内容即可。账号在下一步选择。</p>
          </section>
          </div>}
        </>}

        {step === "accounts" && draft && <>
          <section className={`draft-sync-startup ${connection ? "connected" : ""}`} aria-label="本机同步连接">
            {connection ? <><div className="draft-sync-connection-status"><span aria-hidden="true">✓</span><div><strong>本机同步已就绪</strong><p>账号登录资料保存在这台电脑上。可添加多个账号，勾选本次要保存的账号。</p></div></div></> : <>
              <h3>{connectionState === "connecting" ? "正在自动连接本机版…" : connectionState === "error" ? "暂时没有连接成功" : "先打开本机版，才能连接账号"}</h3>
              <p>本机版是在你的电脑上运行的排版和同步工具，负责打开平台登录窗口、保存草稿。下载后双击启动即可。</p>
              <ol className="draft-sync-startup-instructions"><li>下载并解压 Mac 启动工具。</li><li>双击“启动折页.command”，按窗口提示完成首次准备。</li><li>工具会自动打开本机版；在打开的页面继续这三步。</li></ol>
              <div className="draft-sync-inline-actions"><a className="draft-sync-startup-link" href="/downloads/zhepage-draft-helper.zip" download>下载 Mac 启动工具</a><a className="draft-sync-startup-link secondary" href="http://127.0.0.1:5173/" target="_blank" rel="noopener noreferrer">打开本机版</a></div>
              <p className="draft-sync-small">首次准备需要联网，请保持启动窗口打开。“打开本机版”适用于已启动的电脑。</p>
              {!isLocalPage && <p className="draft-sync-transfer-note">此网页中准备的内容不会自动带到本机版。请在本机版重新导入原文或图片，再继续保存草稿。</p>}
              {isLocalPage && <p className="draft-sync-small">已经启动但未连接时，请重新双击启动工具，并使用它自动打开的页面。</p>}
            </>}
            {isLocalPage && <details className="draft-sync-troubleshooting"><summary>连接有问题？</summary><p>日常使用请重新双击启动工具，并允许浏览器访问本地网络。如果已有本次连接码，可在此手动连接。</p><form onSubmit={connectAssistant} className="draft-sync-connect-form"><label htmlFor="draft-pairing-code">本机助手配对码</label><div><input id="draft-pairing-code" type="password" autoComplete="off" value={pairingCode} disabled={Boolean(busy) || Boolean(accountProgress)} onChange={(event) => setPairingCode(event.target.value)} placeholder="粘贴已有的本次连接码" /><button type="submit" disabled={Boolean(busy) || Boolean(accountProgress) || !pairingCode.trim()}>{connection ? "重新连接" : "连接助手"}</button></div></form></details>}
          </section>
          {connection && <div className="draft-sync-account-workspace">
            <section className="draft-sync-editor" aria-label="平台账号">
              {platformTabs}
            <div className="draft-sync-account-heading"><h3>选择要保存的账号</h3>{connection && <button type="button" disabled={Boolean(busy) || Boolean(accountProgress)} onClick={refreshAccounts}>刷新账号</button>}</div>
            {!connection ? <p className="draft-sync-small">启动本机版后，即可连接平台账号。</p> : !platformAccounts.length ? <p className="draft-sync-small">尚未添加{limit.label}账号。添加后，即可勾选要使用的账号。</p> : <div className="draft-sync-accounts">{platformAccounts.map((account) => <div key={account.id} className="draft-sync-account-row"><label htmlFor={`draft-account-${account.id}`} aria-label={`选择同步账号 ${account.displayName}`}><input id={`draft-account-${account.id}`} type="checkbox" checked={draft.selectedAccountIds.includes(account.id)} disabled={Boolean(busy) || ((!account.ready || Boolean(pendingChecks[account.id]) || account.syncBlocked) && !draft.selectedAccountIds.includes(account.id))} onChange={(event) => updateDraft((current) => ({ ...current, selectedAccountIds: event.target.checked ? [...new Set([...current.selectedAccountIds, account.id])] : current.selectedAccountIds.filter((id) => id !== account.id) }))} /><span><b>{account.displayName}</b><small>{pendingChecks[account.id] || account.syncBlocked ? "上次结果待核实" : account.ready ? account.remoteId : "需要重新登录"}</small></span></label><button type="button" className="draft-sync-text-button" disabled={Boolean(busy) || Boolean(accountProgress) || Boolean(pendingChecks[account.id]) || account.syncBlocked} onClick={() => deleteAccount(account)} aria-label={`移除账号并删除本机登录状态 ${account.displayName}`} title="移除账号并删除本机登录状态">移除</button></div>)}</div>}
            {!!unknownAccounts.length && <div className="draft-sync-message error">存档中有 {unknownAccounts.length} 个账号尚未连接，请重新连接对应账号或清除选择。<button type="button" disabled={Boolean(busy)} onClick={() => updateDraft((current) => ({ ...current, selectedAccountIds: current.selectedAccountIds.filter((id) => !unknownAccounts.includes(id)) }))}>清除不可用账号选择</button></div>}

              {!!allReceipts.length && <button type="button" className="draft-sync-review-results" disabled={Boolean(busy)} onClick={() => goToStep("results")}>查看保存结果</button>}
            </section>
            <section className="draft-sync-add-account" aria-label="添加平台账号">
              <h3>{platform === "wechat" ? "添加公众号" : "添加小红书账号"}</h3>
              {platform === "xiaohongshu" ? <><p className="draft-sync-small">在弹出的独立登录窗口扫码。完成后回到本页勾选账号，也可继续添加其他账号。</p><div className="field-stack"><label htmlFor="draft-account-name">账号备注（选填）</label><input id="draft-account-name" value={accountName} disabled={Boolean(busy) || Boolean(accountProgress)} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：品牌主账号" /></div><button type="button" disabled={Boolean(busy) || Boolean(accountProgress)} onClick={addAccount}>打开小红书登录窗口</button></> : <><p className="draft-sync-small">公众号需要管理员先连接一次，完成后即可勾选账号保存草稿。</p><details className="draft-sync-wechat-setup"><summary>需公众号管理员完成首次配置</summary><p>这里使用公众号后台的 AppID 和 AppSecret，不是微信账号和密码。请让管理员确认账号具有草稿接口权限后填写。</p><div className="field-stack"><label htmlFor="draft-account-name">账号备注（选填）</label><input id="draft-account-name" value={accountName} disabled={Boolean(busy) || Boolean(accountProgress)} onChange={(event) => setAccountName(event.target.value)} placeholder="例如：品牌公众号" /></div><div className="field-stack"><label htmlFor="draft-wechat-app-id">公众号 AppID</label><input id="draft-wechat-app-id" autoComplete="off" value={appId} disabled={Boolean(busy) || Boolean(accountProgress)} onChange={(event) => setAppId(event.target.value)} /></div><div className="field-stack"><label htmlFor="draft-wechat-secret">公众号 AppSecret</label><input id="draft-wechat-secret" type="password" autoComplete="new-password" value={appSecret} disabled={Boolean(busy) || Boolean(accountProgress)} onChange={(event) => setAppSecret(event.target.value)} /><small>提交后清空；同步工具重启后需重新添加。</small></div><button type="button" disabled={Boolean(busy) || Boolean(accountProgress) || !appId.trim() || !appSecret.trim()} onClick={addAccount}>验证并添加公众号</button></details></>}
            </section>
          </div>}
          {!!selectedAccounts.length && <section className="draft-sync-selection-summary" aria-label="本次保存内容"><h3>本次将保存到 {selectedAccounts.length} 个账号</h3><ul>{selectedPlatforms.map((target) => <li key={target}><strong>{DRAFT_LIMITS[target].label} · {draft.content[target].title || "未填写标题"}</strong><span>{selectedAccounts.filter((account) => account.platform === target).map((account) => account.displayName).join("、")} · {draft.images.length} 张图片</span></li>)}</ul><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>返回确认内容</button></section>}
        {draft && !!issues.length && <section className="draft-sync-validation" aria-label="同步前检查"><h3>同步前检查</h3><ul>{issues.map((issue, index) => <li key={`${issue.platform}-${issue.code}-${issue.imageId || index}`} className={issue.severity}><b>{DRAFT_LIMITS[issue.platform].label}：</b>{issue.message}</li>)}</ul>{!!warnings.length && <label className="draft-sync-check"><input type="checkbox" checked={acceptedWarnings === warningsKey} disabled={Boolean(busy)} onChange={(event) => setAcceptedWarnings(event.target.checked ? warningsKey : "")} /><span>我已核对图片，沿用当前尺寸和比例</span></label>}</section>}

        </>}
        {step === "results" && <><p className="draft-sync-result-guidance">保存成功的账号已取消勾选。需要重试时，返回选择账号并检查；待核实的账号须先到平台核对。</p>{busy && <p className="draft-sync-message neutral" role="status">{busy}</p>}{!allReceipts.length && <p className="draft-sync-small">正在等待第一个账号的保存结果…</p>}</>}
        {step === "results" && !!allReceipts.length && <section className="draft-sync-results" aria-label="账号同步结果">
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
                  <button type="button" disabled={Boolean(busy) || Boolean(accountProgress) || !connection || !account} onClick={() => confirmOutcome(receipt.accountId, "saved")}>已在平台核对，确认已保存</button>
                  <button type="button" disabled={Boolean(busy) || Boolean(accountProgress) || !connection || !account} onClick={() => confirmOutcome(receipt.accountId, "not_saved")}>已在平台核对，确认未保存</button>
                </div>
              </>}
            </article>;
          })}
        </section>}
      </div>
      <footer className="draft-sync-footer">
        <div className="draft-sync-footer-status" aria-live="polite">{busy ? <p role="status">{busy} 完成后可关闭窗口。</p> : <>{feedback && <p className={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}<p>{nextHint}</p></>}{archiveFeedback && <p className={archiveFeedback.tone} role="status">{archiveFeedback.text}</p>}{draft && <label className="draft-sync-check"><input type="checkbox" checked={autoSave} disabled={Boolean(busy)} onChange={(event) => setAutoSave(event.target.checked)} /><span>自动存到当前浏览器</span></label>}</div>
        <div className="draft-sync-footer-actions">
          <button type="button" disabled={Boolean(busy) || !draft} onClick={saveDraft}>存到本机</button>
          {step === "content" ? <button type="button" className="primary" disabled={Boolean(busy) || (draft ? !draft.images.length : !canCollect || storageState === "loading")} onClick={() => draft ? goToStep("accounts") : createDraft()}>{draft ? "下一步：选择账号" : "用当前海报开始"}</button> : step === "accounts" ? <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("content")}>上一步</button><button type="button" className="primary" disabled={!canSync} onClick={submitDraft}>存到 {selectedAccounts.length} 个账号草稿</button></> : <><button type="button" disabled={Boolean(busy)} onClick={() => goToStep("accounts")}>返回选择账号</button><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => closeDialog()}>完成</button></>}
        </div>
      </footer>
    </div>
  </dialog>;
}
