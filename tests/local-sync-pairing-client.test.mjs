import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDomModule } from './helpers/load-dom-module.mjs';
const {beginLocalSyncConnection}=loadDomModule('lib/localSync/connection.ts');
const identity={deviceId:'a'.repeat(32),connectionToken:'b'.repeat(64)};
function fixture(t,override) {
  const old=globalThis.chrome,calls=[];
  globalThis.chrome={runtime:{sendMessage(_id,msg,callback){calls.push(msg);callback(override?.(msg)??(msg.type==='pair'?{...identity,nonce:msg.nonce}:{status:200,body:{deviceId:identity.deviceId}}));}}};
  t.after(()=>{globalThis.chrome=old;});t.mock.method(globalThis,'fetch',()=>assert.fail('pairing must not contact local ports'));
  return calls;
}
test('user detection pairs with extension then verifies its device, no helper or popup',async t=>{
  const calls=fixture(t);const attempt=beginLocalSyncConnection();assert.equal(calls.length,0);
  assert.deepEqual(await attempt.connect(new AbortController().signal),identity);assert.equal(calls.length,2);
  assert.equal(calls[1].path,'/api/wechat/connection');assert.equal(calls[1].token,identity.connectionToken);
  await assert.rejects(attempt.connect(new AbortController().signal),/正在处理中/);
});
test('mismatched challenge and malformed identities are rejected before authentication',async t=>{
  for(const change of [{nonce:'bad'},{deviceId:'bad'},{connectionToken:'short'}]) await t.test(JSON.stringify(change),async t=>{
    const calls=fixture(t,m=>({...identity,nonce:m.nonce,...change}));await assert.rejects(beginLocalSyncConnection().connect(new AbortController().signal),/信息不完整/);assert.equal(calls.length,1);
  });
});
test('changed extension identity never binds credentials to the wrong target',async t=>{
  fixture(t,m=>m.type==='request'?{status:200,body:{deviceId:'c'.repeat(32)}}:undefined);
  await assert.rejects(beginLocalSyncConnection().connect(new AbortController().signal),/身份不一致/);
});
test('cancelled connection never sends a message',async t=>{
  const calls=fixture(t);const attempt=beginLocalSyncConnection();attempt.close();await assert.rejects(attempt.connect(new AbortController().signal),{name:'AbortError'});assert.equal(calls.length,0);
});
