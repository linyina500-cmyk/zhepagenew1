import assert from "node:assert/strict";
import test from "node:test";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";

test("export snapshots remove XML-invalid clipboard metadata without changing visible text or the source DOM", async (context) => {
  const dom = installDom();
  context.after(() => dom.window.close());
  const { removeInvalidExportXml } = loadDomModule("lib/export/preparePosterSnapshot.ts");
  const node = document.createElement("article");
  node.innerHTML = '<p>图片前的中文正文\t🌿\n后文</p><img src="data:image/png;base64,AAAA" alt="截图\u000b来自剪贴板\u0001"><!--invalid--comment-->';
  const original = node.outerHTML;
  const clone = node.cloneNode(true);
  removeInvalidExportXml(clone);
  assert.equal(clone.querySelector("p").textContent, node.querySelector("p").textContent);
  assert.equal(clone.querySelector("img").alt, "截图来自剪贴板");
  assert.equal(node.outerHTML, original);
  const xml = new dom.window.XMLSerializer().serializeToString(clone);
  assert.equal(new DOMParser().parseFromString(xml, "image/svg+xml").querySelector("parsererror"), null);
});

test("snapshot captures decoded source pixels at full export resolution and cleans up its staging node", async (context) => {
  const dom = installDom();
  context.after(() => dom.window.close());
  const { preparePosterSnapshot } = loadDomModule("lib/export/preparePosterSnapshot.ts");
  document.body.innerHTML = '<section><div class="poster-grid" style="--preview-scale:0.25;--poster-paper:#fff"><div class="poster-wrap"><article class="poster-page"><div class="article-flow"><img src="/api/image?url=original" alt="配图" style="width:100%;height:auto;object-fit:cover"></div></article></div></div></section>';
  const node = document.querySelector("article");
  const original = node.outerHTML;
  const drawn = [];
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    decode: { configurable: true, value: async function () {} },
    complete: { configurable: true, get() { return true; } },
    naturalWidth: { configurable: true, get() { return 1600; } },
    naturalHeight: { configurable: true, get() { return 900; } },
  });
  dom.window.HTMLCanvasElement.prototype.getContext = function () { return { drawImage: (...args) => drawn.push({ args, width: this.width, height: this.height }) }; };
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,ZmFrZQ==";
  let checks = 0;
  const snapshot = await preparePosterSnapshot(node, { width: 1080, height: 1440 }, () => { checks++; });
  assert.notEqual(snapshot.node, node);
  assert.equal(snapshot.node.isConnected, true);
  assert.equal(snapshot.node.closest(".poster-grid").style.getPropertyValue("--preview-scale"), "1");
  assert.equal(snapshot.node.closest(".poster-grid").style.getPropertyValue("--poster-paper"), "#fff");
  assert.equal(snapshot.node.querySelector("img").src, "data:image/png;base64,ZmFrZQ==");
  assert.equal(snapshot.node.querySelector("img").style.objectFit, "cover");
  assert.equal(drawn[0].args[0], node.querySelector("img"));
  assert.equal(drawn[0].width, 1600);
  assert.equal(drawn[0].height, 900);
  assert.ok(checks >= 3);
  assert.equal(node.outerHTML, original);
  snapshot.dispose();
  assert.equal(snapshot.node.isConnected, false);
  assert.equal(document.querySelectorAll(".poster-grid").length, 1);
});

test("unreadable or cross-origin-tainted images fail visibly without mutating preview or leaking a staging node", async (context) => {
  const dom = installDom();
  context.after(() => dom.window.close());
  const { preparePosterSnapshot } = loadDomModule("lib/export/preparePosterSnapshot.ts");
  document.body.innerHTML = '<div class="poster-grid"><article class="poster-page"><img src="/broken.png" alt="original"></article></div>';
  const node = document.querySelector("article");
  const original = node.outerHTML;
  dom.window.HTMLImageElement.prototype.decode = async () => { throw new Error("decode failed"); };
  await assert.rejects(preparePosterSnapshot(node, { width: 1080, height: 1440 }, () => {}), /第 1 张配图无法读取/);
  Object.defineProperties(dom.window.HTMLImageElement.prototype, {
    decode: { configurable: true, value: async function () {} },
    complete: { configurable: true, get() { return true; } },
    naturalWidth: { configurable: true, get() { return 100; } },
    naturalHeight: { configurable: true, get() { return 100; } },
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => { throw new DOMException("Tainted", "SecurityError"); };
  await assert.rejects(preparePosterSnapshot(node, { width: 1080, height: 1440 }, () => {}), /第 1 张配图无法用于下载/);
  assert.equal(node.outerHTML, original);
  assert.equal(document.querySelectorAll(".poster-grid").length, 1);
});
