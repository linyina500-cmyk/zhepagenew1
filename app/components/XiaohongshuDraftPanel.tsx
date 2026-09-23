"use client";
import { useState, type ReactNode } from "react";
import type { LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { createXhsClient, type XhsAccount, type XhsJob } from "../../lib/xiaohongshu/client";
import { createWechatClient } from "../../lib/wechat/client";
import type { Binding } from "../../lib/wechat/deviceVault";
type Props = {
  draft: LocalDraft; contentReady: boolean; contentCheck?: ReactNode; contentChanged: boolean; busy: boolean;
  binding: Binding;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  persistReceipt: (draft: LocalDraft, receipt: SyncReceipt, signal: AbortSignal) => Promise<LocalDraft>;
  onSubmitted: () => void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "尚未完成，请读取状态并核对专用窗口。";
export default function XiaohongshuDraftPanel({ draft, contentReady, contentCheck, contentChanged, busy, runOperation, persistReceipt, onSubmitted, binding }: Props) {
  const [account, setAccount] = useState<XhsAccount | null>(null), [job, setJob] = useState<XhsJob | null>(null);
  const [feedback, setFeedback] = useState("");
  const [checked, setChecked] = useState(false), [allowNew, setAllowNew] = useState(false);
  const receipt = draft.receipts.find((item) => item.platform === "xiaohongshu" && item.accountId === account?.id);
  const pending = receipt?.status === "needs_confirmation" && !job?.acknowledged;
  async function client(signal: AbortSignal) {
    const secret = binding.connectionToken;
    const connection = await createWechatClient(secret).getConnection(signal);
    if (connection.deviceId !== binding.deviceId) throw new Error("连接的不是原来绑定的电脑，请在连接设置中核对。");
    signal.throwIfAborted();
    return createXhsClient(secret);
  }
  function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    void runOperation(label, async (signal) => { setFeedback(""); await operation(signal); });
  }
  async function remember(value: XhsJob, previous: SyncReceipt, snapshot: LocalDraft, signal: AbortSignal) {
    signal.throwIfAborted(); setJob(value);
    await persistReceipt(snapshot, { ...previous, draftId: value.draftId, message: value.message,
      status: value.status === "saved" ? "saved" : value.status === "failed" ? "failed" : "needs_confirmation" }, signal);
  }
  function submit() {
    if (!account || !contentReady || pending || (receipt && !allowNew)) return;
    const target = account;
    run("正在保存小红书草稿…", async (signal) => {
      const api = await client(signal);
      const connected = await api.getAccount(signal);
      if (connected.id !== target.id) throw new Error("专用窗口的账号已变化，请重新检查账号。");
      const previous: SyncReceipt = { platform: "xiaohongshu", accountId: target.id, jobId: crypto.randomUUID(), status: "needs_confirmation", message: "已保留任务编号，正在保存小红书草稿；中断后请先读取状态。" };
      const snapshot = await persistReceipt(draft, previous, signal);
      signal.throwIfAborted(); setAllowNew(false); setChecked(false); setJob(null); onSubmitted();
      try {
        const initial = await api.createJob({ id: previous.jobId!, accountId: target.id, content: snapshot.content.xiaohongshu, images: snapshot.images }, signal);
        const latest = await api.waitForJob(initial, signal, setJob);
        await remember(latest, previous, snapshot, signal);
      } catch (error) {
        if (signal.aborted) return;
        await persistReceipt(snapshot, { ...previous, message: errorText(error) }, signal); setFeedback(errorText(error));
      }
    });
  }
  function read(action: "read" | "verify" | "acknowledge") {
    if (!account || !receipt?.jobId) return;
    const previous = receipt, target = account;
    run("正在核对小红书任务…", async (signal) => {
      const api = await client(signal);
      const result = action === "verify" ? await api.verifyJob(previous.jobId!, target.id, signal)
        : action === "acknowledge" ? await api.acknowledgeJob(previous.jobId!, target.id, signal) : await api.getJob(previous.jobId!, target.id, signal);
      await remember(result, previous, draft, signal); setChecked(false);
    });
  }
  return <div className="draft-sync-xhs">
    <section className="draft-sync-service" aria-label="小红书本机连接"><h3>{account ? "小红书账号" : "登录小红书"}</h3>
      <p>{account ? "已确认账号，可以把图片存到草稿箱。" : "打开登录窗口扫码，完成后点击“我已登录”。"}</p>
      <div className="draft-sync-confirm-actions"><button type="button" className={account ? undefined : "primary"} disabled={busy} onClick={() => run("正在打开小红书专用窗口…", async (signal) => { await (await client(signal)).openLogin(signal); signal.throwIfAborted(); setAccount(null); setFeedback("请在打开的窗口扫码，再回到这里点击“我已登录”。"); })}>{account ? "切换账号" : "打开登录窗口"}</button>
      <button type="button" disabled={busy} onClick={() => run("正在确认小红书账号…", async (signal) => { const value = await (await client(signal)).getAccount(signal); signal.throwIfAborted(); setAccount(value); setJob(null); setAllowNew(false); })}>{account ? "刷新账号" : "我已登录"}</button></div>
      {account && <p role="status">已连接：<strong>{account.name}</strong></p>}
    </section>
    {receipt && <section className="draft-sync-results" aria-label="小红书同步结果"><h3>{contentChanged ? "上次结果 · 当前内容有更新" : "小红书草稿状态"}</h3>
      <p>{job?.message || receipt.message}</p>{job && <p>图片 {job.uploadedCount} / {job.imageCount} 张</p>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => read("read")}>读取小红书同步状态</button><button type="button" disabled={busy || !(job?.draftId || receipt.draftId)} onClick={() => read("verify")}>重新核对小红书草稿</button></div>
      {pending && <><p>保存结果尚未确认。请在小红书窗口打开草稿，检查文字和全部图片。</p><label className="draft-sync-check"><input type="checkbox" disabled={busy} checked={checked} onChange={(event) => setChecked(event.target.checked)} /><span>我已检查草稿，并保存或退出了当前编辑</span></label><button type="button" disabled={busy || !checked} onClick={() => read("acknowledge")}>结束本次任务</button></>}
      {job?.acknowledged && <p>已结束本次任务。保存结果以小红书草稿箱为准。</p>}
    </section>}
    {account && <section className="draft-sync-service"><h3>保存到小红书</h3><p>共 {draft.images.length} 张图片，按当前顺序存入草稿箱。</p>
      {contentCheck}
      {receipt && !pending && <label className="draft-sync-check"><input type="checkbox" checked={allowNew} disabled={busy} onChange={(event) => setAllowNew(event.target.checked)} /><span>另存一份新草稿，保留上次内容</span></label>}
      <button type="button" className="primary" disabled={busy || !account || !contentReady || pending || Boolean(receipt && !allowNew)} onClick={submit}>同步到小红书草稿箱</button>
    </section>}
    {feedback && <p className="draft-sync-message" role="status">{feedback}</p>}
  </div>;
}
