"use client";

import { useRef, useState } from "react";
import { createWechatClient, WechatRequestError } from "../../lib/wechat/client";
import { clearDeviceVault, listAccounts, parseLocalWechatConfig, removeAccount, saveAccount, saveBinding, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";

type Props = {
  binding: Binding | null; accounts: LocalWechatAccount[]; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  onChange: (binding: Binding | null, accounts: LocalWechatAccount[], addedId?: string) => void;
};

export default function WechatAccountManager({ binding, accounts, busy, runOperation, onChange }: Props) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [feedback, setFeedback] = useState("");
  const [recovery, setRecovery] = useState<"confirm" | "unreachable" | null>(null);
  const [oldServiceStopped, setOldServiceStopped] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    void runOperation(label, async (signal) => { setFeedback(""); await operation(signal); });
  }
  async function bind(connectionToken: string, signal: AbortSignal) {
    const connection = await createWechatClient(connectionToken).getConnection(signal);
    signal.throwIfAborted();
    const next = { deviceId: connection.deviceId, connectionToken: connectionToken.trim() };
    await saveBinding(next); signal.throwIfAborted();
    onChange(next, await listAccounts()); setToken("");
    return next;
  }
  async function add(input: { appId: string; appSecret: string; name: string }, target: Binding, signal: AbortSignal) {
    const client = createWechatClient(target.connectionToken);
    const connection = await client.getConnection(signal);
    if (connection.deviceId !== target.deviceId) throw new Error("连接设备已改变，请先清除本机公众号账号，再连接新设备。");
    signal.throwIfAborted();
    const account = await saveAccount(input);
    signal.throwIfAborted(); onChange(target, await listAccounts(), account.id);
    setSecret(""); setName(""); setAppId("");
    await client.connectAccount({ ...input, deviceId: target.deviceId }, signal);
    signal.throwIfAborted(); setFeedback(`${account.name} 已保存在本机，并已连接。`);
  }
  function importConfig(file: File) {
    run("正在导入本机公众号配置…", async (signal) => {
      if (file.size > 32768) throw new Error("配置文件过大，请选择原来的 config.env。");
      const input = parseLocalWechatConfig(await file.text());
      signal.throwIfAborted();
      const target = await bind(input.token, signal);
      await add({ appId: input.appId, appSecret: input.appSecret, name: input.name }, target, signal);
    });
  }
  function resetBinding() {
    if (!recovery || (recovery === "unreachable" && !oldServiceStopped)) return;
    run("正在检查并清除本机公众号绑定…", async (signal) => {
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
      setToken(""); setName(""); setAppId(""); setSecret("");
      setRecovery(null); setOldServiceStopped(false); onChange(null, []);
      setFeedback("此浏览器的公众号账号和绑定已清除。海报存档及同步记录已保留，可以连接新设备。" );
    });
  }
  return <details className="draft-sync-wechat-settings" open={!binding || !accounts.length || undefined}>
    <summary>{binding ? "管理本机公众号" : "连接本机并添加公众号"}</summary>
    <p className="draft-sync-small">账号密钥只保存在这台浏览器的加密存储中；清除浏览器资料后需重新添加。每次操作时才连接本机服务。</p>
    <div className="draft-sync-wechat-fields">
      <div className="field-stack"><label htmlFor="wechat-connection-password">本机连接口令</label><input id="wechat-connection-password" type="password" autoComplete="off" value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} placeholder={binding ? "更换口令时填写" : "填写启动工具中的连接口令"} /></div>
      <button type="button" disabled={busy || !token.trim()} onClick={() => run("正在连接本机服务…", async (signal) => { await bind(token, signal); signal.throwIfAborted(); setFeedback("本机服务已连接，可以添加公众号。"); })}>连接本机服务</button>
      <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>导入本机配置</button>
      <input ref={fileRef} type="file" accept=".env,text/plain" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) importConfig(file); }} />
    </div>
    {binding && <form onSubmit={(event) => { event.preventDefault(); run("正在保存并连接公众号…", (signal) => add({ appId, appSecret: secret, name }, binding, signal)); }}>
      <div className="draft-sync-wechat-fields">
        <div className="field-stack"><label htmlFor="wechat-account-name">公众号名称</label><input id="wechat-account-name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} autoComplete="off" /></div>
        <div className="field-stack"><label htmlFor="wechat-account-appid">AppID</label><input id="wechat-account-appid" value={appId} disabled={busy} onChange={(event) => setAppId(event.target.value)} autoComplete="off" spellCheck={false} /></div>
        <div className="field-stack"><label htmlFor="wechat-account-secret">AppSecret</label><input id="wechat-account-secret" type="password" value={secret} disabled={busy} onChange={(event) => setSecret(event.target.value)} autoComplete="off" spellCheck={false} /></div>
      </div>
      <button type="submit" disabled={busy || !name.trim() || !appId.trim() || !secret.trim()}>保存并连接公众号</button>
    </form>}
    {accounts.length > 0 && <ul className="draft-sync-wechat-manage-list">{accounts.map((account) => <li key={account.id}><span>{account.name}<small>{account.appId}</small></span><button type="button" disabled={busy || !binding} onClick={() => run("正在移除本机公众号…", async (signal) => {
      if (!binding) return;
      const client = createWechatClient(binding.connectionToken);
      const connection = await client.getConnection(signal);
      if (connection.deviceId !== binding.deviceId) throw new Error("连接的本机设备已改变，请恢复原设备连接后移除账号。");
      await client.disconnectAccount(account.id, signal); signal.throwIfAborted();
      await removeAccount(account.id); signal.throwIfAborted(); onChange(binding, await listAccounts());
      setFeedback(`${account.name} 已从本机移除，已保存的草稿不受影响。`);
    })}>移除 {account.name}</button></li>)}</ul>}
    <button type="button" disabled={busy} onClick={() => { setRecovery("confirm"); setOldServiceStopped(false); }}>本机连接已失效？清除此浏览器的公众号绑定</button>
    {recovery && <section className="draft-sync-wechat-confirmation" aria-label="清除本机公众号绑定">
      <h3>清除本机公众号绑定</h3>
      <p>将删除此浏览器保存的全部公众号密钥、连接口令和加密密钥，之后需要重新添加账号。海报、图片和同步记录会保留。</p>
      {recovery === "unreachable" && <><p>无法确认原设备已断开。原服务内存中的公众号连接会在退出服务时清除；请先关闭原服务。</p><label className="draft-sync-check"><input type="checkbox" checked={oldServiceStopped} disabled={busy} onChange={(event) => setOldServiceStopped(event.target.checked)} /><span>我已关闭原服务，确认只清除此浏览器的公众号资料</span></label></>}
      <div className="draft-sync-confirm-actions"><button type="button" disabled={busy} onClick={() => { setRecovery(null); setOldServiceStopped(false); }}>取消清除</button><button type="button" disabled={busy || (recovery === "unreachable" && !oldServiceStopped)} onClick={resetBinding}>确认清除本机公众号绑定</button></div>
    </section>}
    {feedback && <p className="draft-sync-message success" role="status">{feedback}</p>}
  </details>;
}
