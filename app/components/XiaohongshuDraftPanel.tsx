"use client";
import { useEffect, useState } from "react";
import type { LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { createXhsClient, type XhsAccount, type XhsJob } from "../../lib/xiaohongshu/client";
import { createWechatClient } from "../../lib/wechat/client";
import { loadBinding, saveBinding, type Binding } from "../../lib/wechat/deviceVault";
type Props = {
  draft: LocalDraft; contentReady: boolean; contentChanged: boolean; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  persistReceipt: (draft: LocalDraft, receipt: SyncReceipt, signal: AbortSignal) => Promise<LocalDraft>;
  onSubmitted: () => void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "尚未完成，请读取状态并核对专用窗口。";
export default function XiaohongshuDraftPanel({ draft, contentReady, contentChanged, busy, runOperation, persistReceipt, onSubmitted }: Props) {
  const [binding, setBinding] = useState<Binding | null>(null), [token, setToken] = useState("");
  const [account, setAccount] = useState<XhsAccount | null>(null), [job, setJob] = useState<XhsJob | null>(null);
  const [feedback, setFeedback] = useState("");
  const [checked, setChecked] = useState(false), [allowNew, setAllowNew] = useState(false);
  const receipt = draft.receipts.find((item) => item.platform === "xiaohongshu" && item.accountId === account?.id);
  const pending = receipt?.status === "needs_confirmation" && !job?.acknowledged;
  useEffect(() => {
    let active = true;
    void loadBinding().then((value) => { if (active) setBinding(value); }).catch((error) => { if (active) setFeedback(errorText(error)); });
    return () => { active = false; };
  }, []);
  async function client(signal: AbortSignal) {
    const secret = binding?.connectionToken || token.trim();
    const connection = await createWechatClient(secret).getConnection(signal);
    if (binding && connection.deviceId !== binding.deviceId) throw new Error("连接的不是原来绑定的电脑，请先检查本机服务地址。");
    const next = { deviceId: connection.deviceId, connectionToken: secret };
    if (!binding) await saveBinding(next);
    signal.throwIfAborted(); setBinding(next); setToken("");
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
    <section className="draft-sync-service" aria-label="小红书本机连接"><h3>连接小红书</h3>
      <p>本机程序打开专用小红书窗口。首次扫码登录后，在这台电脑保留登录状态，之后直接同步到草稿箱。</p>
      {!binding && <div className="field-stack"><label htmlFor="xhs-connection-token">本机连接口令</label><input id="xhs-connection-token" type="password" autoComplete="off" value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} /><small>与公众号使用同一份本机连接配置。</small></div>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy || !(binding || token.trim())} onClick={() => run("正在打开小红书专用窗口…", async (signal) => { await (await client(signal)).openLogin(signal); signal.throwIfAborted(); setAccount(null); setFeedback("请在本机专用窗口扫码，完成后点击“检查小红书账号”。"); })}>打开专用窗口登录</button>
      <button type="button" disabled={busy || !(binding || token.trim())} onClick={() => run("正在检查小红书账号…", async (signal) => { const value = await (await client(signal)).getAccount(signal); signal.throwIfAborted(); setAccount(value); setJob(null); setAllowNew(false); })}>检查小红书账号</button></div>
      {account && <p role="status">目标账号：<strong>{account.name}</strong></p>}
    </section>
    {receipt && <section className="draft-sync-results" aria-label="小红书同步结果"><h3>{contentChanged ? "上次同步记录（当前编辑尚未同步）" : "小红书草稿状态"}</h3>
      <p>{job?.message || receipt.message}</p>{job && <p>图片 {job.uploadedCount} / {job.imageCount} 张</p>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => read("read")}>读取小红书同步状态</button><button type="button" disabled={busy || !(job?.draftId || receipt.draftId)} onClick={() => read("verify")}>重新核对小红书草稿</button></div>
      {pending && <><p>请在专用窗口重新打开草稿，检查标题、配文和全部图片。结果待核对不会显示为保存成功。</p><label className="draft-sync-check"><input type="checkbox" disabled={busy} checked={checked} onChange={(event) => setChecked(event.target.checked)} /><span>我已在专用窗口核对本次结果，并处理好当前编辑器</span></label><button type="button" disabled={busy || !checked} onClick={() => read("acknowledge")}>结束本次任务</button></>}
      {job?.acknowledged && <p>已记录人工核对并结束任务；这不代表程序已验证保存成功。</p>}
    </section>}
    <section className="draft-sync-service"><h3>保存当前贴图草稿</h3><p>将 {draft.images.length} 张完整海报按当前顺序上传，只保存草稿。</p>
      {receipt && !pending && <label className="draft-sync-check"><input type="checkbox" checked={allowNew} disabled={busy} onChange={(event) => setAllowNew(event.target.checked)} /><span>确认另建一份草稿，保留上次平台内容</span></label>}
      <button type="button" className="primary" disabled={busy || !account || !contentReady || pending || Boolean(receipt && !allowNew)} onClick={submit}>同步到小红书草稿箱</button>
    </section>
    {feedback && <p className="draft-sync-message" role="status">{feedback}</p>}
  </div>;
}
