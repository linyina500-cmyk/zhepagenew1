import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import ts from 'typescript';
import {packBrowserExtension} from './pack-browser-extension.mjs';
const temporary=await mkdtemp(path.join(os.tmpdir(),'zhepage-extension-test-'));
const origin='https://zhepagenew.pages.dev';
const previewOrigin='https://feature-local-draft-sync.zhepagenew.pages.dev';
let context;
try {
  const {directory,id,archive}=await packBrowserExtension(path.join(temporary,'package'));
  const data=await readFile(archive);assert.ok(data.length<1024*1024);
  const storeSource=(await readFile(new URL('../browser-extension/store.mjs',import.meta.url),'utf8')).replace('export function','function');
  const vaultSource=ts.transpileModule(await readFile(new URL('../lib/wechat/deviceVault.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  const loadVault=async(page)=>page.evaluate(async(source)=>{
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    try{globalThis.fixtureVault=await import(url);}finally{URL.revokeObjectURL(url);}
  },vaultSource);
  const launch=async profile=>{
    const ctx=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,chromiumSandbox:true,args:[`--disable-extensions-except=${directory}`,`--load-extension=${directory}`]});
    for(const site of [origin,previewOrigin])await ctx.route(site+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Extension integration fixture</title>'}));
    return ctx;
  };
  const request=async(page,message)=> page.evaluate(({id,message})=>new Promise((resolve,reject)=>{
    chrome.runtime.sendMessage(id,{protocol:1,...message},response=>{const error=chrome.runtime.lastError;if(error)reject(new Error(error.message));else resolve(response);});
  }),{id,message});
  const pair=async(ctx,site=origin)=>{
    const page=await ctx.newPage();await page.goto(site);
    const identity=await request(page,{type:'pair',nonce:'11111111-1111-4111-8111-111111111111'});
    assert.match(identity.deviceId,/^[a-f0-9]{32}$/);assert.match(identity.connectionToken,/^[a-f0-9]{64}$/);
    return {page,identity};
  };
  context=await launch(path.join(temporary,'profile'));
  const errors=[];context.on('weberror',e=>errors.push(e.error().message));
  const first=await pair(context);
  const call={type:'request',token:first.identity.connectionToken,path:'/api/wechat/connection',method:'GET'};
  assert.deepEqual(await request(first.page,call),{status:200,body:{deviceId:first.identity.deviceId,busy:false}});
  assert.equal((await request(first.page,{...call,token:'0'.repeat(64)})).status,401);
  assert.equal((await request(first.page,{...call,path:'/api/wechat/accounts/aaaaaaaaaaaaaaaaaaaa/jobs/11111111-1111-4111-8111-111111111111/publication',method:'POST'})).status,404);
  const preview=await pair(context,previewOrigin+'/browser-sync-check');
  assert.deepEqual(preview.identity,first.identity,'both authorized websites connect to the same installed extension');
  assert.deepEqual(await request(preview.page,call),{status:200,body:{deviceId:first.identity.deviceId,busy:false}});
  await loadVault(first.page);await loadVault(preview.page);
  await preview.page.evaluate(async(binding)=>{
    await fixtureVault.saveBinding(binding);
    await fixtureVault.saveAccount({appId:'wx1234567890123456',appSecret:'fixture-preview-only-secret',name:'预览站测试公众号'});
  },preview.identity);
  assert.deepEqual(await first.page.evaluate(async()=>({binding:await fixtureVault.loadBinding(),accounts:await fixtureVault.listAccounts()})),{binding:null,accounts:[]},'main site must not import the preview site binding or account secrets');
  await first.page.evaluate(async(binding)=>{
    await fixtureVault.saveBinding(binding);
    await fixtureVault.saveAccount({appId:'wx6543210987654321',appSecret:'fixture-main-only-secret',name:'主站测试公众号'});
  },first.identity);
  assert.deepEqual(await preview.page.evaluate(async()=>(await fixtureVault.listAccounts()).map(account=>account.name)),['预览站测试公众号'],'adding a main-site account must leave preview records unchanged');
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const mockWechat=async(worker)=>worker.evaluate(()=>{
    globalThis.fixtureWechat={blocked:true,writes:0,tokens:0,article:null};
    globalThis.fetch=async(url,options)=>{
      const parsed=new URL(url),state=globalThis.fixtureWechat;
      if(parsed.origin!=='https://api.weixin.qq.com')throw new Error('Unexpected fixture destination');
      if(parsed.pathname==='/cgi-bin/stable_token'){
        state.tokens++;
        return Response.json(state.blocked?{errcode:40164,errmsg:'invalid ip 203.0.113.7, not in whitelist'}:{access_token:'fixture-only-token',expires_in:7200});
      }
      if(parsed.pathname==='/cgi-bin/draft/count')return Response.json({total_count:0});
      if(parsed.pathname==='/cgi-bin/material/add_material')return Response.json({media_id:'fixture-image'});
      if(parsed.pathname==='/cgi-bin/draft/add'){state.writes++;state.article=JSON.parse(options.body).articles[0];return Response.json({media_id:'fixture-draft'});}
      if(parsed.pathname==='/cgi-bin/draft/get')return Response.json({news_item:[state.article]});
      throw new Error('Unexpected fixture API');
    };
  });
  await mockWechat(worker);
  const connectMessage={...call,path:'/api/wechat/accounts/connect',method:'POST',body:{kind:'json',value:{deviceId:first.identity.deviceId,appId:'wx1234567890123456',appSecret:'s'.repeat(32),name:'回归测试账号'}}};
  const blocked=await request(first.page,connectMessage);
  assert.equal(blocked.status,424);assert.match(blocked.body.error,/203\.0\.113\.7/u);
  await worker.evaluate(()=>{fixtureWechat.blocked=false;});
  const connected=await request(first.page,connectMessage);assert.equal(connected.status,200);
  const accountId=connected.body.account.id,oldId='12345678-1234-4234-8234-123456789012',newId='12345678-1234-4234-8234-123456789013';
  const oldRecord={id:oldId,accountId,accountName:'回归测试账号',title:'恢复测试',body:'正文',imageCount:1,uploadedCount:0,imageMediaIds:[],status:'needs_confirmation',message:'旧版结果待确认',createdAt:'2026-10-13',updatedAt:'2026-10-13'};
  await worker.evaluate(`(async()=>{${storeSource};await createStore().set(${JSON.stringify(`wechat:job:${accountId}:${oldId}`)},${JSON.stringify(oldRecord)});})()`);
  const resolveMessage={...call,path:`/api/wechat/accounts/${accountId}/jobs/${oldId}/resolve`,method:'POST',body:{kind:'json',value:{confirmNoDraft:true}}};
  assert.deepEqual(await request(first.page,resolveMessage),{status:200,body:{resolution:{jobId:oldId,accountId,confirmedNoDraft:true}}});
  assert.equal((await request(first.page,resolveMessage)).status,200);
  const bytes=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);Buffer.from('IHDR').copy(bytes,12);bytes.writeUInt32BE(1080,16);bytes.writeUInt32BE(1350,20);
  const submitMessage={...call,path:`/api/wechat/accounts/${accountId}/jobs`,method:'POST',body:{kind:'form',entries:[...Object.entries({id:newId,expectedAccountId:accountId,title:'恢复测试',body:'正文'}).map(([key,value])=>({key,value})),{key:'images',file:{name:'fixture.png',type:'image/png',data:bytes.toString('base64')}}]}};
  assert.equal((await request(first.page,submitMessage)).status,202);
  let saved;
  for(let attempt=0;attempt<100;attempt++){
    saved=await request(first.page,{...call,path:`/api/wechat/accounts/${accountId}/jobs/${newId}`});
    if(!['uploading','creating'].includes(saved.body.job?.status))break;
  }
  assert.equal(saved.body.job.status,'saved');assert.equal(saved.body.job.draftId,'fixture-draft');
  assert.equal(await worker.evaluate(()=>fixtureWechat.writes),1);
  assert.equal((await request(first.page,{...resolveMessage,path:`/api/wechat/accounts/${accountId}/jobs/${newId}/resolve`})).status,409);
  const value=await worker.evaluate(`(async()=>{${storeSource};const s=createStore();await s.set('test:blob',{blob:new Blob(['complete bytes']),status:'saved'});return(await s.get('test:blob')).blob.text();})()`);
  assert.equal(value,'complete bytes');
  await context.close();context=await launch(path.join(temporary,'profile'));
  const second=await pair(context);assert.deepEqual(second.identity,first.identity);
  await loadVault(second.page);
  assert.deepEqual(await second.page.evaluate(async()=>(await fixtureVault.listAccounts()).map(account=>account.name)),['主站测试公众号']);
  const restarted=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  await mockWechat(restarted);await restarted.evaluate(()=>{fixtureWechat.blocked=false;});
  assert.equal((await request(second.page,connectMessage)).status,200);
  assert.equal((await request(second.page,resolveMessage)).status,200,'resolution survives extension restart');
  assert.equal((await request(second.page,{...call,path:`/api/wechat/accounts/${accountId}/jobs/${oldId}`})).body.job.status,'failed');
  assert.equal((await request(second.page,submitMessage)).body.job.status,'saved');
  assert.equal(await restarted.evaluate(()=>fixtureWechat.writes),0,'restarted extension must not replay an existing task');
  assert.equal(await restarted.evaluate(`(async()=>{${storeSource};return(await createStore().get('test:blob')).blob.text();})()`),'complete bytes');
  await context.close();context=await launch(path.join(temporary,'another-profile'));
  const separate=await pair(context);assert.notEqual(separate.identity.deviceId,first.identity.deviceId);assert.notEqual(separate.identity.connectionToken,first.identity.connectionToken);
  await loadVault(separate.page);
  assert.deepEqual(await separate.page.evaluate(async()=>({binding:await fixtureVault.loadBinding(),accounts:await fixtureVault.listAccounts()})),{binding:null,accounts:[]});
  assert.deepEqual(errors,[]);
  console.log('PASS: real unpacked extension, origin handshakes, credential isolation, whitelist rejection and recovery, durable absence resolution, single draft creation, known-ID protection, authentication, publish denied, IndexedDB persistence, restart, and isolated new browser profile.');
} finally {await context?.close();await rm(temporary,{recursive:true,force:true});}
