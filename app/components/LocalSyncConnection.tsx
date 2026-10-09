"use client";

import { useEffect, useRef, useState } from "react";
import { createWechatClient, WechatRequestError } from "../../lib/wechat/client";
import { clearDeviceVault, listAccounts, saveBinding, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";

import { beginLocalSyncConnection } from "../../lib/localSync/connection";

type Props = {
  binding: Binding | null; accounts: LocalWechatAccount[]; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  onChange: (binding: Binding | null, accounts: LocalWechatAccount[], addedId?: string) => void;
  onReadyChange: (ready: boolean) => void;
};

function ExtensionGuide() {
  return <details className="draft-sync-connection-help draft-sync-extension-guide"><summary>首次使用：3 步加载插件</summary>
    <ol className="draft-sync-setup-steps">
      <li><strong>下载并解压</strong><p>下载上方插件 ZIP，解压到固定文件夹。Windows 和 Mac 使用同一份插件。</p></li>
      <li><strong>在 Chrome 加载插件</strong><p>在地址栏打开 <code>chrome://extensions/</code>，开启「开发者模式」，点击「加载已解压的扩展程序」，选择刚才解压的插件文件夹。</p></li>
      <li><strong>回到折页检测</strong><p>点击「检测插件」，显示「插件已连接」后即可登录小红书或添加公众号。</p></li>
    </ol>
  </details>;
}

export default function LocalSyncConnection({ binding, accounts, busy, runOperation, onChange, onReadyChange }: Props) {
  const [feedback, setFeedback] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [recovery, setRecovery] = useState<"confirm" | "unreachable" | null>(null);
  const [oldServiceStopped, setOldServiceStopped] = useState(false);
  const [verified, setVerified] = useState<{ binding: Binding; ready: boolean; changed?: boolean; message?: string } | null>(null);
  const busyRef = useRef(busy);
  const pairedBinding = useRef<Binding | null>(null);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const connected = Boolean(binding && verified?.binding === binding && verified.ready);
  const checking = Boolean(binding && verified?.binding !== binding);
  useEffect(() => { onReadyChange(connected); }, [connected, onReadyChange]);
  useEffect(() => {
    if (!binding) return;
    let active: AbortController | undefined;
    let disposed = false;
    const check = async () => {
      if (active || disposed) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const result = await createWechatClient(binding.connectionToken).getConnection(controller.signal);
        controller.signal.throwIfAborted();
        const ready = result.deviceId === binding.deviceId;
        if (!disposed) setVerified({ binding, ready, changed: !ready });
      } catch (error) {
        if (!disposed) setVerified({ binding, ready: false, changed: error instanceof WechatRequestError && error.status === 401, message: "未连接到插件。请确认 Chrome 中已加载并启用折页插件，再点击检测；已保存的账号仍会保留。" });
      } finally { clearTimeout(timeout); active = undefined; }
    };
    if (pairedBinding.current !== binding) void check();
    const focus = () => { if (!busyRef.current) void check(); };
    window.addEventListener("focus", focus);
    return () => { disposed = true; active?.abort(); window.removeEventListener("focus", focus); };
  }, [binding]);
  function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    void runOperation(label, async (signal) => { setFeedback(""); setConnectionError(""); await operation(signal); });
  }
  function connectDevice() {
    if (busy) return;
    const attempt = beginLocalSyncConnection();
    setFeedback(""); setConnectionError("");
    void runOperation("正在检测浏览器插件…", async (signal) => {
      try {
        const next = await attempt.connect(signal);
        signal.throwIfAborted();
        await saveBinding(next);
        signal.throwIfAborted();
        const savedAccounts = await listAccounts();
        signal.throwIfAborted();
        pairedBinding.current = next;
        onChange(next, savedAccounts);
        setVerified({ binding: next, ready: true });
      } catch (error) {
        signal.throwIfAborted();
        setConnectionError(error instanceof Error ? error.message : "尚未连接，请加载并启用折页插件后重试。");
        throw error;
      }
    }).finally(() => attempt.close());
  }
  function resetBinding() {
    if (!recovery || (recovery === "unreachable" && !oldServiceStopped)) return;
    run("正在检查并重置插件连接…", async (signal) => {
      let reachable = false;
      let connection: Awaited<ReturnType<ReturnType<typeof createWechatClient>["getConnection"]>> | undefined;
      const client = binding ? createWechatClient(binding.connectionToken) : null;
      if (client && binding) {
        try { connection = await client.getConnection(signal); reachable = connection.deviceId === binding.deviceId; }
        catch { signal.throwIfAborted(); }
      }
      signal.throwIfAborted();
      if (reachable && client) {
        if (connection?.busy) throw new Error("插件仍在处理任务，请等待任务完成后再重置连接。");
        for (const account of accounts) {
          try { await client.disconnectAccount(account.id, signal); }
          catch (error) {
            signal.throwIfAborted();
            // A busy response is a definite refusal, never an offline bypass.
            if (error instanceof WechatRequestError && error.status === 409) throw new Error("插件仍在处理任务，请等待任务完成后再重置连接。");
            setRecovery("unreachable"); setOldServiceStopped(false);
            throw new Error("未能确认原连接已断开。请先停用原插件或关闭原浏览器，再确认重置连接。");
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
      setFeedback("插件连接和此浏览器的公众号资料已清除。海报及同步记录已保留，可以重新检测插件。" );
    });
  }
  const connectButton = <button type="button" className={connected ? undefined : "primary"} disabled={busy} onClick={connectDevice}>检测插件</button>;
  const resetButton = <button type="button" className="draft-sync-reset-connection" disabled={busy} onClick={() => { setRecovery("confirm"); setOldServiceStopped(false); }}>重置插件连接</button>;
  const downloadLink = <a className="draft-sync-extension-download" href="/downloads/zhepage-draft-extension.zip" download>下载插件<span>Windows / Mac 通用</span></a>;
  return <section className="draft-sync-connection" aria-label="浏览器插件连接" data-connected={connected}>
    {connected ? <div className="draft-sync-connection-saved">
      <strong role="status">插件已连接</strong>
      <details><summary>连接设置</summary>
        <p className="draft-sync-small">小红书和公众号共用此插件，之后可直接同步。账号资料仅保存在当前浏览器，换电脑需重新添加。</p>
        {connectButton}{resetButton}
        <details className="draft-sync-connection-help"><summary>重新下载插件</summary>{downloadLink}<ExtensionGuide /></details>
      </details>
    </div> : checking ? <p className="draft-sync-small" role="status">正在检测浏览器插件…</p> : <>
      <h3>{binding ? "检查插件连接" : "连接浏览器插件"}</h3>
      <p className="draft-sync-small">{binding ? verified?.changed ? accounts.length ? "插件身份已变化。请先重置连接，再重新添加公众号。海报和同步记录会保留。" : "插件身份已变化。请重新检测插件，并确认小红书账号。" : verified?.message : "首次加载一次，小红书和公众号共用。无需安装电脑程序、上传配置文件或填写连接口令。"}</p>
      <div className="draft-sync-connection-actions">{binding && verified?.changed && accounts.length ? resetButton : connectButton}{downloadLink}</div>
      <ExtensionGuide />
      <details className="draft-sync-connection-help"><summary>连接帮助</summary>
        <p className="draft-sync-small">请在加载了插件的同一个 <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">Chrome 浏览器</a>中打开折页。若未检测到，检查扩展页中的折页插件是否已启用，再回到这里重试。</p>
        <p className="draft-sync-small">已在预览站装过旧版插件？请下载新版并覆盖原插件文件夹，在 Chrome 扩展页点「重新加载」，再刷新折页。</p>
        <p className="draft-sync-small">换电脑或浏览器后，需要重新加载插件、登录小红书或添加公众号。从预览站切到主站也需重新检测插件、添加公众号，账号密钥不会自动迁移。</p>
        {!(binding && verified?.changed && accounts.length) && resetButton}
      </details>
    </>}
    {recovery && <section className="draft-sync-wechat-confirmation" aria-label="重置插件连接">
      <h3>重置插件连接</h3>
      <p>将删除此浏览器保存的连接信息和全部公众号密钥，之后需要重新连接并添加公众号。海报、图片和同步记录会保留。</p>
      {recovery === "unreachable" && <><p>无法确认原连接的任务状态。请先停用原插件或关闭原浏览器，再清除此浏览器的连接资料。</p><label className="draft-sync-check"><input type="checkbox" checked={oldServiceStopped} disabled={busy} onChange={(event) => setOldServiceStopped(event.target.checked)} /><span>我已停用原插件或关闭原浏览器，确认清除此浏览器的连接和公众号资料</span></label></>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => { setRecovery(null); setOldServiceStopped(false); }}>取消清除</button><button type="button" disabled={busy || (recovery === "unreachable" && !oldServiceStopped)} onClick={resetBinding}>确认重置连接</button></div>
    </section>}
    {connectionError && <p className="draft-sync-message error" role="alert">{connectionError}</p>}
    {feedback && <p className="draft-sync-message success" role="status">{feedback}</p>}
  </section>;
}
