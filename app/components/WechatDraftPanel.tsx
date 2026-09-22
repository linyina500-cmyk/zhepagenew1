"use client";

import { useRef, useState } from "react";
import type { LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { createWechatClient, type WechatAccount, type WechatJob } from "../../lib/wechat/client";

type Props = {
  draft: LocalDraft;
  view: "browser" | "results";
  contentReady: boolean;
  contentChanged: boolean;
  busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  persistReceipt: (snapshot: LocalDraft, receipt: SyncReceipt, signal: AbortSignal) => Promise<LocalDraft>;
  onSubmitted: () => void;
};
const LABELS: Record<WechatJob["status"], string> = {
  uploading: "正在上传图片", creating: "正在创建草稿", saved: "接口已核对草稿内容", needs_confirmation: "结果待核对", failed: "本次同步未完成",
};
const message = (error: unknown) => error instanceof Error ? error.message : "结果暂未确认，请读取状态并核对公众号草稿箱。";
function receiptFor(job: WechatJob, previous: SyncReceipt): SyncReceipt {
  return {
    ...previous, draftId: job.draftId,
    status: previous.status === "confirmed_by_user" ? "confirmed_by_user" : job.status === "saved" ? "saved" : job.status === "failed" ? "failed" : "needs_confirmation",
    message: previous.status === "confirmed_by_user" ? previous.message : job.message,
  };
}

export default function WechatDraftPanel({ draft, view, contentReady, contentChanged, busy, runOperation, persistReceipt, onSubmitted }: Props) {
  // This component is removed on close or platform switch. The password is
  // intentionally absent from every parent state and durable draft record.
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState<WechatAccount | null>(null);
  const [job, setJob] = useState<WechatJob | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [allowNew, setAllowNew] = useState(false);
  const requestRef = useRef(false);
  const receipts = draft.receipts.filter((item) => item.platform === "wechat" && item.jobId);
  const receipt = account ? receipts.find((item) => item.accountId === account.id) : receipts.at(-1);
  const otherAccountPending = receipts.find((item) => item.accountId !== account?.id && item.status === "needs_confirmation");
  const matchesAccount = Boolean(account && receipt?.accountId === account.id);
  const matchingJob = job && receipt?.jobId === job.id ? job : null;

  function connect() {
    if (!password.trim() || busy) return;
    void runOperation("正在检查公众号连接…", async (signal) => {
      setFeedback(null); setAccount(null); setJob(null); setAllowNew(false);
      const target = await createWechatClient(password).getAccount(signal);
      signal.throwIfAborted(); setAccount(target);
      setFeedback({ error: false, text: "连接已确认。请核对下方公众号名称和标识，再同步当前图片。" });
    });
  }

  function submit() {
    if (!account || !contentReady || busy || requestRef.current || otherAccountPending || (receipt && !allowNew)) return;
    const target = account;
    const client = createWechatClient(password);
    const pending: SyncReceipt = {
      platform: "wechat", accountId: target.id, jobId: crypto.randomUUID(), status: "needs_confirmation",
      message: "本次同步尚待确认。关闭或刷新后请先读取这次任务的状态，不要重复创建。",
    };
    requestRef.current = true;
    void runOperation("正在同步到公众号草稿箱…", async (signal) => {
      setFeedback(null); setJob(null); setAllowNew(false);
      const staged = await persistReceipt(draft, pending, signal);
      signal.throwIfAborted(); onSubmitted();
      let lastJob: WechatJob | null = null;
      try {
        const initial = await client.createJob({ id: pending.jobId!, accountId: target.id, content: staged.content.wechat, images: staged.images }, signal);
        signal.throwIfAborted(); lastJob = initial; setJob(initial);
        const latest = await client.waitForJob(initial, signal, (progress) => { lastJob = progress; setJob(progress); });
        signal.throwIfAborted();
        await persistReceipt(staged, receiptFor(latest, pending), signal);
        setFeedback({ error: latest.status === "failed" || latest.status === "needs_confirmation", text: latest.status === "saved"
          ? "草稿内容已由接口读回核对。请打开公众号草稿箱，检查每张图片的实际显示。"
          : ["uploading", "creating"].includes(latest.status) ? "服务器仍在处理，任务编号已保存在本机。可稍后点击“读取同步状态”，无需再次上传。" : latest.message });
      } catch (error) {
        // Closing stops only this wait. The pending receipt already survives a
        // refresh, and no late result may overwrite another editing session.
        if (signal.aborted) return;
        const text = message(error);
        await persistReceipt(staged, { ...pending, draftId: lastJob?.draftId, status: "needs_confirmation", message: text }, signal);
        signal.throwIfAborted(); setFeedback({ error: true, text });
      }
    }).finally(() => { requestRef.current = false; });
  }

  function read(verify = false) {
    if (!account || !receipt?.jobId || !matchesAccount || busy) return;
    const target = account, previous = receipt, snapshot = draft;
    void runOperation(verify ? "正在重新核对公众号草稿内容…" : "正在读取公众号同步状态…", async (signal) => {
      setFeedback(null);
      const client = createWechatClient(password);
      const latest = verify ? await client.verifyJob(previous.jobId!, target.id, signal) : await client.getJob(previous.jobId!, target.id, signal);
      signal.throwIfAborted(); setJob(latest);
      await persistReceipt(snapshot, receiptFor(latest, previous), signal);
      signal.throwIfAborted();
      setFeedback({ error: latest.status === "failed" || latest.status === "needs_confirmation", text: latest.status === "saved"
        ? "接口已核对草稿内容；图片是否正常显示，仍请在公众号草稿箱检查。" : latest.message });
    });
  }

  function confirmVisual() {
    if (!receipt || !matchesAccount || busy) return;
    void runOperation("正在记录图片核对结果…", async (signal) => {
      await persistReceipt(draft, { ...receipt, status: "confirmed_by_user", message: "你已在目标公众号草稿箱核对标题、文案、全部图片及顺序，并确认图片显示正常。这是人工确认。" }, signal);
      signal.throwIfAborted(); setFeedback({ error: false, text: "已记录你的人工核对结果。" });
    });
  }

  return <div className="draft-sync-wechat">
    <section className={`draft-sync-service ${account ? "connected" : ""}`} aria-label="公众号服务连接">
      <h3>{account ? "公众号已连接" : "连接公众号"}</h3>
      <p>公众号通过官方接口同步为“多图＋短文”贴图草稿。连接检查只读取草稿接口，不会上传图片；点击同步后才上传图片。</p>
      <div className="field-stack"><label htmlFor="wechat-connection-password">公众号连接口令</label><input id="wechat-connection-password" type="password" autoComplete="off" spellCheck={false} value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value); setAccount(null); setJob(null); setFeedback(null); setAllowNew(false); }} /><small>填写服务器设置的连接口令，不是公众号 AppSecret。口令仅在当前窗口使用，关闭后清除。</small></div>
      <button type="button" disabled={busy || !password.trim()} onClick={connect}>检查公众号连接</button>
      {account && <p className="draft-sync-wechat-account" role="status"><strong>同步目标：{account.name}</strong><span>账号标识：{account.id}</span></p>}
    </section>
    {(receipt || view === "results") && <section className="draft-sync-results" aria-label="公众号同步结果">
      <h3>{contentChanged ? "上次同步记录（当前编辑尚未同步）" : "公众号草稿状态"}</h3>
      {!receipt && <p>尚未向这个公众号同步当前草稿。</p>}
      {receipt && <>
        <p className="draft-sync-small">记录账号：{receipt.accountId} · 任务：{receipt.jobId}</p>
        {matchingJob && <article className={`draft-sync-receipt ${matchingJob.status}`}><div><strong>{matchingJob.accountName} · {matchingJob.title}</strong><b>{LABELS[matchingJob.status]}</b></div><p>图片 {matchingJob.uploadedCount} / {matchingJob.imageCount} 张 · {matchingJob.message}</p></article>}
        <article className={`draft-sync-receipt ${receipt.status}`} aria-label="公众号草稿核对记录"><div><strong>草稿核对记录</strong><b>{receipt.status === "confirmed_by_user" ? "用户已确认图片正常" : receipt.status === "saved" ? "接口已核对，图片显示待人工检查" : receipt.status === "failed" ? "尚未完成同步" : "结果待核对"}</b></div><p>{receipt.message}</p></article>
        <div className="draft-sync-confirm-actions"><button type="button" disabled={busy || !matchesAccount} onClick={() => read()}>读取同步状态</button><button type="button" disabled={busy || !matchesAccount || !(matchingJob?.draftId || receipt.draftId)} onClick={() => read(true)}>重新核对草稿内容</button></div>
        {!matchesAccount && <p className="draft-sync-small">请连接记录对应的公众号后读取状态。</p>}
        <p>打开目标公众号的草稿箱，检查标题、短文、全部图片的顺序和实际显示。接口核对与人工检查分别记录。</p>
        <a className="draft-sync-platform-link" href="https://mp.weixin.qq.com/" target="_blank" rel="noopener noreferrer">打开公众号草稿箱核对</a>
        {receipt.status !== "confirmed_by_user" && <button type="button" disabled={busy || !matchesAccount} onClick={confirmVisual}>已在公众号草稿箱核对，图片显示正常</button>}
      </>}
    </section>}
    {view === "browser" && <section className="draft-sync-service" aria-label="提交公众号草稿">
      <h3>确认后同步到草稿箱</h3>
      <p>将当前 {draft.images.length} 张图片按顺序上传，并创建一份贴图草稿。同步前会先保留完整本机存档。</p>
      {otherAccountPending && <p className="draft-sync-message error">另一个公众号（{otherAccountPending.accountId}）仍有待核对任务，请先连接该账号核对结果。</p>}
      {receipt && <label className="draft-sync-check"><input type="checkbox" checked={allowNew} disabled={busy || !matchesAccount} onChange={(event) => setAllowNew(event.target.checked)} /><span>我已在公众号草稿箱核对上一组结果，确认要另建一份草稿（可能与已有草稿重复）</span></label>}
      <button type="button" className="primary" disabled={busy || !account || !contentReady || Boolean(otherAccountPending) || Boolean(receipt && !allowNew)} onClick={submit}>同步到公众号草稿箱</button>
    </section>}
    {feedback && <p className={`draft-sync-message ${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
  </div>;
}
