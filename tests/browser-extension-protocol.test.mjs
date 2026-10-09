import assert from 'node:assert/strict';
import test from 'node:test';
import {allowedSender,validateRequest,decodeBody,safeError} from '../browser-extension/protocol.mjs';
const origins=['https://zhepagenew.pages.dev','https://feature-local-draft-sync.zhepagenew.pages.dev'];
test('only the exact main and preview top-level origins can address the extension',()=>{
  for (const origin of origins) {
    const sender={url:origin+'/browser-sync-check',origin,frameId:0,tab:{id:12}};
    assert.equal(allowedSender(sender),true);
    for(const change of [{id:'another-extension'},{frameId:1},{origin:'https://evil.example'},{url:origin+'.evil.example/'},{tab:{}},{url:origin.replace('https:','http:')+'/'},{url:'https://other-branch.zhepagenew.pages.dev/'},{url:origin+':8443/'}]) assert.equal(allowedSender({...sender,...change}),false);
    assert.equal(allowedSender({...sender,origin:origins.find(value=>value!==origin)}),false);
  }
});
test('publish and arbitrary requests are denied even with valid identity',()=>{
  const valid={protocol:1,type:'request',method:'GET',token:'a'.repeat(64),path:'/api/wechat/connection'};assert.doesNotThrow(()=>validateRequest(valid));
  for(const change of [{protocol:2},{method:'DELETE'},{path:'/api/wechat/accounts/a/jobs/b/publication'},{path:'/api/wechat/../connection'},{path:'https://example.com/'},{token:'bad'},{body:{kind:'json',value:{}}}]) assert.throws(()=>validateRequest({...valid,...change}));
});
test('payload decoder preserves bounded PNG files and rejects malformed or unknown fields',async()=>{
  const file={name:'a.png',type:'image/png',data:btoa('png-bytes')};
  const form=decodeBody({kind:'form',entries:[{key:'title',value:'标题'},{key:'images',file}]});assert.equal(await form.get('images').text(),'png-bytes');
  for(const entry of [{key:'url',value:'evil'},{key:'images',file:{...file,data:'?==='}},{key:'images',file:{...file,type:'text/html'}}]) assert.throws(()=>decodeBody({kind:'form',entries:[entry]}));
});
test('unexpected error details and credentials are never reflected',()=>{assert.ok(!safeError(new Error('appsecret=private')).body.error.includes('private'));});
