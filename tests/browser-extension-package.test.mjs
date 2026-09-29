import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {packBrowserExtension} from '../build/pack-browser-extension.mjs';
test('portable ZIP loads directly from its extracted root and contains no native program or user data',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'draft-extension-package-'));
  try {
    const packed=await packBrowserExtension(temp),zip=await JSZip.loadAsync(await readFile(packed.archive));
    const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.manifest_version,3);assert.ok(zip.file(manifest.background.service_worker));
    assert.deepEqual(manifest.permissions,['scripting','storage']);
    assert.ok(!manifest.permissions.includes('nativeMessaging'));assert.ok(!manifest.permissions.includes('proxy'));
    const allowed=/^(?:manifest\.json|开始使用\.txt|browser-extension\/[a-z-]+\.mjs|lib\/wechat\/api\.mjs)$/;
    for(const [name,file]of Object.entries(zip.files))if(!file.dir)assert.match(name,allowed);
    assert.equal(Object.keys(zip.files).some(name=>/config\.env|\.exe$|node_modules|profile|cookie|\.pem$/.test(name)),false);
    const transport=await readFile(new URL('../lib/localSync/transport.ts',import.meta.url),'utf8');assert.ok(transport.includes(packed.id));
    assert.deepEqual(manifest.externally_connectable.matches,['https://feature-local-draft-sync.zhepagenew.pages.dev/*']);
    assert.ok(packed.bytes<1024*1024);
  } finally{await rm(temp,{recursive:true,force:true});}
});
