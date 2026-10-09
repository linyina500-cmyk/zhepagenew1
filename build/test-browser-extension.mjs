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
  const value=await worker.evaluate(`(async()=>{${storeSource};const s=createStore();await s.set('test:blob',{blob:new Blob(['complete bytes']),status:'saved'});return(await s.get('test:blob')).blob.text();})()`);
  assert.equal(value,'complete bytes');
  await context.close();context=await launch(path.join(temporary,'profile'));
  const second=await pair(context);assert.deepEqual(second.identity,first.identity);
  await loadVault(second.page);
  assert.deepEqual(await second.page.evaluate(async()=>(await fixtureVault.listAccounts()).map(account=>account.name)),['主站测试公众号']);
  const restarted=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  assert.equal(await restarted.evaluate(`(async()=>{${storeSource};return(await createStore().get('test:blob')).blob.text();})()`),'complete bytes');
  await context.close();context=await launch(path.join(temporary,'another-profile'));
  const separate=await pair(context);assert.notEqual(separate.identity.deviceId,first.identity.deviceId);assert.notEqual(separate.identity.connectionToken,first.identity.connectionToken);
  await loadVault(separate.page);
  assert.deepEqual(await separate.page.evaluate(async()=>({binding:await fixtureVault.loadBinding(),accounts:await fixtureVault.listAccounts()})),{binding:null,accounts:[]});
  assert.deepEqual(errors,[]);
  console.log('PASS: real unpacked extension, main and preview origin handshakes, site-local credential isolation without migration, authentication, publish denied, IndexedDB Blob persistence, restart, and isolated new browser profile.');
} finally {await context?.close();await rm(temporary,{recursive:true,force:true});}
