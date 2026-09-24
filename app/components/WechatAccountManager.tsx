"use client";

import { useState } from "react";
import { createWechatClient } from "../../lib/wechat/client";
import { listAccounts, removeAccount, saveAccount, type Binding, type LocalWechatAccount } from "../../lib/wechat/deviceVault";

type Props = {
  binding: Binding | null; accounts: LocalWechatAccount[]; busy: boolean;
  runOperation: (label: string, operation: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  onChange: (binding: Binding | null, accounts: LocalWechatAccount[], addedId?: string) => void;
};

export default function WechatAccountManager({ binding, accounts, busy, runOperation, onChange }: Props) {
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [feedback, setFeedback] = useState("");
  function run(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    void runOperation(label, async (signal) => { setFeedback(""); await operation(signal); });
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
  if (!binding) return null;
  return <details className="draft-sync-wechat-settings" open={!accounts.length || undefined}>
    <summary>{accounts.length ? "管理公众号" : "添加公众号"}</summary>
    <p className="draft-sync-small">公众号密钥只保存在当前浏览器、当前网址。换浏览器或清除数据后，需要重新添加。</p>
    {binding && <form onSubmit={(event) => { event.preventDefault(); run("正在保存并连接公众号…", (signal) => add({ appId, appSecret: secret, name }, binding, signal)); }}>
      <h4>添加公众号</h4>
      <p className="draft-sync-small">在微信开发者平台找到 AppID 和 AppSecret，复制到下方。</p>
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
      signal.throwIfAborted();
      if (connection.deviceId !== binding.deviceId) throw new Error("连接的本机设备已改变，请恢复原设备连接后移除账号。");
      await client.disconnectAccount(account.id, signal); signal.throwIfAborted();
      await removeAccount(account.id); signal.throwIfAborted(); onChange(binding, await listAccounts());
      setFeedback(`${account.name} 已从本机移除，已保存的草稿不受影响。`);
    })} aria-label={`移除 ${account.name}`}>移除</button></li>)}</ul>}
    {feedback && <p className="draft-sync-message success" role="status">{feedback}</p>}
  </details>;
}
