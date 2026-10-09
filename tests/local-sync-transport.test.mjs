import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDomModule } from './helpers/load-dom-module.mjs';
import { decodeBody } from '../browser-extension/protocol.mjs';
const { localSyncFetch, LocalSyncBrowserError, assertLocalSyncBrowser, DRAFT_EXTENSION_ID } = loadDomModule('lib/localSync/transport.ts');
function chromeFixture(t, handler) {
  const old = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: handler } };
  t.after(() => { globalThis.chrome = old; });
  t.mock.method(globalThis, 'fetch', () => assert.fail('extension transport must not call network or localhost'));
}
function browser(t, agent, platform='MacIntel', maxTouchPoints=0) {
  const old=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{ configurable:true,value:{userAgent:agent,platform,maxTouchPoints} });
  t.after(()=> {if(old)Object.defineProperty(globalThis,'navigator',old);else delete globalThis.navigator;});
}
test('unsupported browsers explain the desktop Chrome requirement before any operation', async t => {
  for (const agent of ['Android Chrome/140.0 Mobile','iPhone CriOS/130.0','AppleWebKit/605 Safari/605','Firefox/130']) {
    await t.test(agent,t=> {browser(t,agent);assert.throws(assertLocalSyncBrowser,LocalSyncBrowserError);});
  }
});
test('Windows and Mac Chromium are supported', async t => {
  for(const agent of ['Windows Chrome/140.0','Macintosh Chrome/140.0','Windows Edg/140.0','Macintosh Chromium/140.0']) {
    await t.test(agent,t=> {browser(t,agent);assert.doesNotThrow(assertLocalSyncBrowser);});
  }
});
test('images preserve exact bytes, order, names, and fields through JSON extension messaging', async t => {
  const calls=[];
  chromeFixture(t,(id,message,callback)=>{calls.push({id,message});callback({status:202,body:{accepted:true}});});
  const form=new FormData();form.append('title','标题');form.append('body','两行\n正文');
  for (const name of ['2.png','1.png']) form.append('images',new Blob([new Uint8Array([0,255,24,128])],{type:'image/png'}),name);
  const response=await localSyncFetch('/api/xiaohongshu/jobs',{method:'POST',headers:{Authorization:'Bearer '+ 'b'.repeat(64)},body:form});
  assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
  assert.equal(calls[0].id,DRAFT_EXTENSION_ID);assert.equal(calls[0].message.token,'b'.repeat(64));
  const restored=decodeBody(JSON.parse(JSON.stringify(calls[0].message.body)));
  assert.equal(restored.get('body'),'两行\n正文');assert.deepEqual(restored.getAll('images').map(x=>x.name),['2.png','1.png']);
  assert.deepEqual([...new Uint8Array(await restored.get('images').arrayBuffer())],[0,255,24,128]);
});
test('invalid routes cannot reach extension or network',t=>{
  chromeFixture(t,()=>assert.fail('invalid route reached extension'));
  for(const path of ['https://example.com/api/wechat/connection','/api/wechat/../pair','/api/wechat/connection?token=secret','/pair']) assert.throws(()=>localSyncFetch(path),/地址无效/);
});
test('missing extension and runtime failure get setup instructions',async t=>{
  chromeFixture(t,(_id,_message,callback)=>{globalThis.chrome.runtime.lastError={message:'No receiver'};callback();delete globalThis.chrome.runtime.lastError;});
  await assert.rejects(localSyncFetch('/api/wechat/connection'),/Chrome 扩展页/);
});
test('abort releases a pending extension request and never resends writes',async t=>{
  let count=0;chromeFixture(t,()=>{count++;});const controller=new AbortController();
  const pending=localSyncFetch('/api/wechat/accounts/connect',{method:'POST',body:'{}',signal:controller.signal});
  await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(count,1);
});
