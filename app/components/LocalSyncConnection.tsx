"use client";

import { useState } from "react";
import { createWechatClient, WechatRequestError } from "../../lib/wechat/client";
import { clearDeviceVault, listAccounts, saveBinding, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";

import { beginLocalSyncConnection } from "../../lib/localSync/connection";

type Props = {
  binding: Binding | null; accounts: LocalWechatAccount[]; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  onChange: (binding: Binding | null, accounts: LocalWechatAccount[], addedId?: string) => void;
};

export default function LocalSyncConnection({ binding, accounts, busy, runOperation, onChange }: Props) {
  const [feedback, setFeedback] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [recovery, setRecovery] = useState<"confirm" | "unreachable" | null>(null);
  const [oldServiceStopped, setOldServiceStopped] = useState(false);
  function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    void runOperation(label, async (signal) => { setFeedback(""); setConnectionError(""); await operation(signal); });
  }
  function connectDevice() {
    if (busy) return;
    const attempt = beginLocalSyncConnection();
    setFeedback(""); setConnectionError("");
    void runOperation("正在连接这台电脑…", async (signal) => {
      try {
        const next = await attempt.connect(signal);
        signal.throwIfAborted();
        await saveBinding(next);
        signal.throwIfAborted();
        const savedAccounts = await listAccounts();
        signal.throwIfAborted();
        onChange(next, savedAccounts);
        setFeedback("本机已连接，小红书和公众号共用此连接。");
      } catch (error) {
        signal.throwIfAborted();
        setConnectionError(error instanceof Error ? error.message : "连接未完成，请打开本机助手后重试。");
        throw error;
      }
    }).finally(() => attempt.close());
  }
  function resetBinding() {
    if (!recovery || (recovery === "unreachable" && !oldServiceStopped)) return;
    run("正在检查并清除本机连接…", async (signal) => {
      let reachable = false;
      let connection: Awaited<ReturnType<ReturnType<typeof createWechatClient>["getConnection"]>> | undefined;
      const client = binding ? createWechatClient(binding.connectionToken) : null;
      if (client && binding) {
        try { connection = await client.getConnection(signal); reachable = connection.deviceId === binding.deviceId; }
        catch { signal.throwIfAborted(); }
      }
      signal.throwIfAborted();
      if (reachable && client) {
        if (connection?.busy) throw new Error("原服务仍在处理任务，请等待任务完成后再清除绑定。");
        for (const account of accounts) {
          try { await client.disconnectAccount(account.id, signal); }
          catch (error) {
            signal.throwIfAborted();
            // A busy response is a definite refusal, never an offline bypass.
            if (error instanceof WechatRequestError && error.status === 409) throw new Error("原服务仍在处理任务，请等待任务完成后再清除绑定。");
            setRecovery("unreachable"); setOldServiceStopped(false);
            throw new Error("未能确认原服务已断开。请先关闭原服务，再确认清除这台浏览器的绑定。");
          }
          signal.throwIfAborted();
        }
      } else if (!oldServiceStopped) {
        setRecovery("unreachable"); setOldServiceStopped(false);
        return;
      }
      signal.throwIfAborted();
      await clearDeviceVault(); signal.throwIfAborted();
      setRecovery(null); setOldServiceStopped(false); onChange(null, []);
      setFeedback("此浏览器的连接和公众号账号已清除。海报存档及同步记录已保留，可以重新连接。" );
    });
  }
  const connectButton = <button type="button" className={binding ? undefined : "primary"} disabled={busy} onClick={connectDevice}>连接这台电脑</button>;
  const resetButton = <button type="button" className="draft-sync-reset-connection" disabled={busy} onClick={() => { setRecovery("confirm"); setOldServiceStopped(false); }}>重置本机连接</button>;
  return <section className="draft-sync-connection" aria-label="本机连接">
    {binding ? <div className="draft-sync-connection-saved">
      <strong>本机连接已保存</strong>
      <details><summary>连接设置</summary>
        <p className="draft-sync-small">连接信息仅保存在当前浏览器、当前网址。两个平台共用，无需重复连接。</p>
        {connectButton}{resetButton}
      </details>
    </div> : <>
      <h3>连接这台电脑</h3>
      <p className="draft-sync-small">小红书和公众号共用此连接，只需连接一次。</p>
      {connectButton}
      <details className="draft-sync-connection-help"><summary>连接帮助</summary>
        <p className="draft-sync-small">安装一次折页同步助手，之后随登录启动。无需上传文件或填写连接口令；若 Chrome 提示访问本机，请允许。</p>
        {resetButton}
      </details>
    </>}
    {recovery && <section className="draft-sync-wechat-confirmation" aria-label="清除本机连接">
      <h3>清除本机连接</h3>
      <p>将删除此浏览器保存的连接信息和全部公众号密钥，之后需要重新连接并添加公众号。海报、图片和同步记录会保留。</p>
      {recovery === "unreachable" && <><p>无法确认原设备已断开。原服务内存中的公众号连接会在退出服务时清除；请先关闭原服务。</p><label className="draft-sync-check"><input type="checkbox" checked={oldServiceStopped} disabled={busy} onChange={(event) => setOldServiceStopped(event.target.checked)} /><span>我已关闭原服务，确认只清除此浏览器的连接和公众号资料</span></label></>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => { setRecovery(null); setOldServiceStopped(false); }}>取消清除</button><button type="button" disabled={busy || (recovery === "unreachable" && !oldServiceStopped)} onClick={resetBinding}>确认清除本机连接</button></div>
    </section>}
    {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
    {feedback && <p className="draft-sync-message success" role="status">{feedback}</p>}
  </section>;
}
