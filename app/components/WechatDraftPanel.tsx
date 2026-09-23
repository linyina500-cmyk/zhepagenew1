"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LocalDraft, SyncReceipt } from "../../lib/draftSync/types";
import { createWechatClient, type WechatJob, type WechatPublication } from "../../lib/wechat/client";
import { readAccountSecret, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";
import { wechatContentHash } from "../../lib/wechat/contentIdentity";
import WechatAccountManager from "./WechatAccountManager";

type Props = {
  draft: LocalDraft; view: "browser" | "results"; contentReady: boolean; contentChanged: boolean; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  persistReceipt: (snapshot: LocalDraft, receipt: SyncReceipt, signal: AbortSignal) => Promise<LocalDraft>;
  onSubmitted: () => void;
  contentCheck?: ReactNode;
  binding: Binding;
  accounts: LocalWechatAccount[];
  onAccountsChange: (binding: Binding | null, accounts: LocalWechatAccount[], addedId?: string) => void;
};
type Result = { job?: WechatJob; publication?: WechatPublication | null; text: string; error?: boolean };
const publicationLabels: Record<WechatPublication["status"], string> = { submitting: "正在提交发表", publishing: "微信正在处理发表", published: "已发表", failed: "发表未成功", needs_confirmation: "发表结果待确认", removed: "内容已被移除", blocked: "暂时不能发表" };
const message = (error: unknown) => error instanceof Error ? error.message : "结果暂未确认，请读取状态并核对公众号后台。";
const publicationText = (publication: WechatPublication) => publication.status === "published" ? "这份内容已发表，请通过文章链接或公众号后台查看。" : publication.message;
function receiptFor(job: WechatJob, previous: SyncReceipt): SyncReceipt {
  const confirmed = previous.status === "confirmed_by_user" && job.status === "saved";
  return { ...previous, draftId: job.draftId, status: confirmed ? "confirmed_by_user" : job.status === "saved" ? "saved" : job.status === "failed" ? "failed" : "needs_confirmation", message: confirmed ? previous.message : job.message };
}

export default function WechatDraftPanel({ draft, contentReady, contentChanged, busy, runOperation, persistReceipt, onSubmitted, contentCheck, binding, accounts, onAccountsChange }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [confirmation, setConfirmation] = useState<{ draft: LocalDraft; accounts: LocalWechatAccount[] } | null>(null);
  const requestRef = useRef(false);
  const confirmationRef = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmation) confirmationRef.current?.focus(); }, [confirmation]);
  const targets = accounts.filter((account) => selected.includes(account.id));
  const actionHintId = useId();
  const contentCheckId = useId();
  const actionHint = busy ? "正在处理，请稍候。" : !targets.length ? "请先勾选至少一个公众号。" : !contentReady && !contentCheck ? "请先完成图片和文案检查，再继续。" : "";
  const actionDescription = actionHint ? actionHintId : !contentReady ? contentCheckId : undefined;
  const receiptForAccount = (accountId: string, snapshot = draft) => snapshot.receipts.find((receipt) => receipt.platform === "wechat" && receipt.accountId === accountId && receipt.jobId);
  function result(accountId: string, next: Partial<Result>) { setResults((current) => ({ ...current, [accountId]: { ...current[accountId], text: "", ...next } })); }
  function changedAccounts(nextBinding: Binding | null, nextAccounts: LocalWechatAccount[], addedId?: string) {
    onAccountsChange(nextBinding, nextAccounts, addedId);
    setSelected((current) => [...new Set([...current.filter((id) => nextAccounts.some((account) => account.id === id)), ...(addedId ? [addedId] : [])])]);
    setConfirmation(null);
  }
  async function clientForDevice(signal: AbortSignal) {
    if (!binding) throw new Error("请先连接本机服务并添加公众号。");
    const client = createWechatClient(binding.connectionToken);
    const connection = await client.getConnection(signal);
    signal.throwIfAborted();
    if (connection.deviceId !== binding.deviceId) throw new Error("连接设备已改变，请先清除本机公众号账号，再连接新设备。");
    return { client, binding };
  }
  async function connectAccount(client: ReturnType<typeof createWechatClient>, target: Binding, account: LocalWechatAccount, signal: AbortSignal) {
    const secret = await readAccountSecret(account.id);
    signal.throwIfAborted();
    await client.connectAccount({ deviceId: target.deviceId, appId: secret.appId, appSecret: secret.appSecret, name: secret.name }, signal);
    signal.throwIfAborted();
  }
  function batch(publish: boolean, approved?: { draft: LocalDraft; accounts: LocalWechatAccount[] }) {
    const snapshot = approved?.draft || draft, batchAccounts = approved?.accounts || targets;
    if (busy || requestRef.current || !binding || !contentReady || !batchAccounts.length || (publish && !approved)) return;
    requestRef.current = true; setConfirmation(null);
    void runOperation(publish ? "正在逐个公众号发表…" : "正在逐个公众号同步草稿…", async (signal) => {
      const { client, binding: targetBinding } = await clientForDevice(signal);
      const contentHash = await wechatContentHash(snapshot);
      signal.throwIfAborted();
      let staged = snapshot;
      for (const account of batchAccounts) {
        signal.throwIfAborted();
        let previous = receiptForAccount(account.id, staged);
        let activeJob: WechatJob | undefined;
        result(account.id, { text: "正在连接…", error: false, publication: undefined });
        try {
          await connectAccount(client, targetBinding, account, signal);
          if (previous?.jobId) {
            const priorPublication = await client.getPublication(previous.jobId, account.id, signal);
            signal.throwIfAborted();
            if (priorPublication) {
              result(account.id, { publication: priorPublication, text: publicationText(priorPublication) });
              staged = await persistReceipt(staged, { ...previous, publicationAttempted: true, message: publicationText(priorPublication) }, signal);
              if (previous.contentHash === contentHash) {
                const latest = publish ? await client.waitForPublication(priorPublication, account.id, signal, (progress) => result(account.id, { publication: progress, text: publicationText(progress) })) : priorPublication;
                signal.throwIfAborted();
                staged = await persistReceipt(staged, { ...previous, publicationAttempted: true, message: publicationText(latest) }, signal);
                signal.throwIfAborted(); result(account.id, { publication: latest, text: publicationText(latest), error: !["published", "submitting", "publishing"].includes(latest.status) });
                continue;
              }
              if (["submitting", "publishing", "needs_confirmation"].includes(priorPublication.status)) throw new Error("上一内容的发表结果尚待确认，请先读取原任务状态；这次没有创建新草稿。");
            } else if (previous.publicationAttempted) throw new Error("上一内容曾提交发表，但结果还未读到。请先核对原任务和公众号后台，这次没有重新提交。");
            if (!priorPublication) {
              activeJob = await client.getJob(previous.jobId, account.id, signal);
              signal.throwIfAborted();
              staged = await persistReceipt(staged, receiptFor(activeJob, previous), signal);
              if (["uploading", "creating", "needs_confirmation"].includes(activeJob.status)) throw new Error("上一任务尚待确认，请先读取状态；这次没有重新上传或发表。");
              if (previous.contentHash !== contentHash || activeJob.status === "failed") activeJob = undefined;
            }
            if (!activeJob) result(account.id, { publication: undefined, text: "正在保存新内容…" });
          }
          if (!activeJob) {
            previous = { platform: "wechat", accountId: account.id, jobId: crypto.randomUUID(), contentHash, status: "needs_confirmation", message: "任务已记录，结果待确认。请读取原任务状态，不要重复提交。" };
            staged = await persistReceipt(staged, previous, signal);
            signal.throwIfAborted(); onSubmitted();
            activeJob = await client.createJob({ id: previous.jobId!, accountId: account.id, content: staged.content.wechat, images: staged.images }, signal);
            signal.throwIfAborted();
            activeJob = await client.waitForJob(activeJob, signal, (job) => { result(account.id, { job, text: `图片 ${job.uploadedCount}/${job.imageCount} · ${job.message}` }); });
            signal.throwIfAborted();
            staged = await persistReceipt(staged, receiptFor(activeJob, previous), signal);
          }
          signal.throwIfAborted(); result(account.id, { job: activeJob, text: activeJob.status === "saved" ? "已同步到草稿箱，请核对图片实际显示。" : activeJob.message, error: activeJob.status !== "saved" });
          if (!publish || activeJob.status !== "saved") continue;
          const existing = await client.getPublication(activeJob.id, account.id, signal);
          signal.throwIfAborted();
          const publicationReceipt = receiptForAccount(account.id, staged)!;
          if (!existing && publicationReceipt.publicationAttempted) throw new Error("这份草稿曾提交发表，但结果还未读到。请读取原任务并核对公众号后台，不要再次发表。");
          if (!existing) {
            staged = await persistReceipt(staged, { ...publicationReceipt, publicationAttempted: true }, signal);
            signal.throwIfAborted();
          }
          let publication = existing || await client.submitPublication(activeJob.id, account.id, signal);
          signal.throwIfAborted(); result(account.id, { publication, text: publication.message });
          publication = await client.waitForPublication(publication, account.id, signal, (progress) => result(account.id, { publication: progress, text: progress.message }));
          signal.throwIfAborted();
          staged = await persistReceipt(staged, { ...receiptForAccount(account.id, staged)!, publicationAttempted: true, message: publicationText(publication) }, signal);
          signal.throwIfAborted(); result(account.id, { publication, text: publicationText(publication), error: !["published", "submitting", "publishing"].includes(publication.status) });
        } catch (error) {
          if (signal.aborted) return;
          const text = message(error);
          // The pending ID was persisted before any create. Keep it on errors;
          // a failed account must not prevent later selected accounts running.
          result(account.id, { ...(activeJob ? { job: activeJob } : {}), text, error: true });
        }
      }
    }).finally(() => { requestRef.current = false; });
  }
  function read(account: LocalWechatAccount, verify = false) {
    const previous = receiptForAccount(account.id);
    if (busy || !previous?.jobId) return;
    void runOperation("正在读取公众号任务状态…", async (signal) => {
      const { client, binding: target } = await clientForDevice(signal);
      await connectAccount(client, target, account, signal);
      const existing = await client.getPublication(previous.jobId!, account.id, signal);
      signal.throwIfAborted();
      if (existing) {
        const publication = existing.publishId && ["submitting", "publishing", "needs_confirmation"].includes(existing.status) ? await client.refreshPublication(previous.jobId!, account.id, signal) : existing;
        signal.throwIfAborted();
        await persistReceipt(draft, { ...previous, publicationAttempted: true, message: publicationText(publication) }, signal);
        signal.throwIfAborted(); result(account.id, { publication, text: publicationText(publication), error: !["published", "submitting", "publishing"].includes(publication.status) });
        return;
      }
      if (previous.publicationAttempted) throw new Error("这份内容曾提交发表，但结果还未读到。请核对原任务和公众号后台，不要再次发表。");
      const job = verify ? await client.verifyJob(previous.jobId!, account.id, signal) : await client.getJob(previous.jobId!, account.id, signal);
      signal.throwIfAborted();
      await persistReceipt(draft, receiptFor(job, previous), signal);
      signal.throwIfAborted(); result(account.id, { job, publication: null, text: job.message, error: job.status === "failed" || job.status === "needs_confirmation" });
    });
  }
  function confirmVisual(account: LocalWechatAccount) {
    const previous = receiptForAccount(account.id);
    if (busy || !previous?.draftId) return;
    void runOperation("正在记录图片核对结果…", async (signal) => {
      await persistReceipt(draft, { ...previous, status: "confirmed_by_user", message: "你已在目标公众号草稿箱核对标题、文案、全部图片及顺序，并确认图片显示正常。" }, signal);
    });
  }
  return <div className="draft-sync-wechat">
    <WechatAccountManager binding={binding} accounts={accounts} busy={busy} runOperation={runOperation} onChange={changedAccounts} />
    <section className="draft-sync-wechat-targets" aria-label="选择公众号">
      <div className="draft-sync-wechat-heading"><h3>选择公众号</h3>{accounts.length > 0 && <label><input type="checkbox" checked={selected.length === accounts.length} disabled={busy} onChange={(event) => setSelected(event.target.checked ? accounts.map((account) => account.id) : [])} />全选</label>}</div>
      {accounts.length === 0 ? <p>添加公众号后，即可选择要同步的账号。</p> : <div className="draft-sync-wechat-account-list">{accounts.map((account) => {
        const receipt = receiptForAccount(account.id), current = results[account.id];
        const label = current?.publication ? publicationLabels[current.publication.status] : receipt?.publicationAttempted ? "发布结果待确认" : receipt?.status === "confirmed_by_user" ? "图片已核对" : receipt?.status === "saved" ? "草稿已保存" : receipt?.status === "failed" ? "同步未完成" : receipt ? "结果待核对" : "尚未同步";
        return <article key={account.id} className="draft-sync-wechat-account-row" data-selected={selected.includes(account.id)} aria-label={`${account.name} 的结果`}>
          <label className="draft-sync-wechat-account-choice"><input type="checkbox" checked={selected.includes(account.id)} disabled={busy} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, account.id] : ids.filter((id) => id !== account.id))} /><span><strong>{account.name}</strong><small>{account.appId}</small></span><b>{label}</b></label>
          {(current?.text || receipt) && <p className={current?.error ? "draft-sync-message error" : "draft-sync-small"} role="status">{current?.text || receipt?.message}</p>}
          {receipt && <div className="draft-sync-confirm-actions"><button type="button" disabled={busy || !binding} onClick={() => read(account)} aria-label={`刷新 ${account.name} 状态`}>刷新状态</button>{receipt.draftId && !receipt.publicationAttempted && !current?.publication && <><button type="button" disabled={busy || !binding} onClick={() => read(account, true)}>重新核对草稿</button>{receipt.status !== "confirmed_by_user" && <button type="button" disabled={busy} onClick={() => confirmVisual(account)}>图片显示正常</button>}</>}</div>}
          {current?.publication?.urls.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">查看已发表内容{current.publication!.urls.length > 1 ? ` ${index + 1}` : ""}</a>)}
        </article>;
      })}</div>}
    </section>
    <section className="draft-sync-wechat-actions" aria-label="公众号操作">
      <p>已选 {targets.length} 个公众号 · {draft.images.length} 张图片{contentChanged && draft.receipts.some((receipt) => receipt.platform === "wechat") ? " · 当前内容有更新" : ""}</p>
      {contentCheck && <div id={contentCheckId}>{contentCheck}</div>}
      {actionHint && <p id={actionHintId} className="draft-sync-small" role="status">{actionHint}</p>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy || !targets.length || !contentReady} aria-describedby={actionDescription} onClick={() => batch(false)}>同步到草稿箱</button><button type="button" className="primary" disabled={busy || !targets.length || !contentReady} aria-describedby={actionDescription} onClick={() => setConfirmation({ draft, accounts: targets })}>立即发布</button></div>
      <p className="draft-sync-small">需要定时发布？先存草稿，再去公众号后台设置时间。</p>
      <a href="https://mp.weixin.qq.com/" target="_blank" rel="noopener noreferrer">打开公众号后台</a>
    </section>
    {confirmation && <section ref={confirmationRef} tabIndex={-1} className="draft-sync-wechat-confirmation" aria-label="确认立即发布">
      <h3>确认立即发布</h3><p>标题：<strong>{confirmation.draft.content.wechat.title}</strong></p><p>{confirmation.draft.images.length} 张图片 · {confirmation.accounts.length} 个公众号</p><ul>{confirmation.accounts.map((account) => <li key={account.id}>{account.name} <small>（{account.appId}）</small></li>)}</ul>
      <p>确认后，这些公众号将立即提交发布。请检查账号和内容；处理结果会逐个显示。</p>
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => batch(true, confirmation)}>确认立即发布</button></div>
    </section>}
  </div>;
}
