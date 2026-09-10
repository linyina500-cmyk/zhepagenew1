// ==UserScript==
// @name         折页 · 浏览器传图验证
// @namespace    https://feature-local-draft-sync.zhepagenew.pages.dev/browser-sync
// @version      0.1.0
// @description  在当前浏览器中，把测试图片和文案填入小红书图文或公众号贴图编辑器。不会发布。
// @match        https://feature-local-draft-sync.zhepagenew.pages.dev/browser-sync-check.html
// @match        https://creator.xiaohongshu.com/publish/*
// @match        https://mp.weixin.qq.com/cgi-bin/*
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @sandbox      DOM
// @run-at       document-idle
// @noframes
// @updateURL    none
// @downloadURL  none
// ==/UserScript==

// # Browser platform adapter notices
// 
// ## baoyu-skills — MIT
// 
// WeChat image-post editor selectors and the image-input/draft-button workflow in
// `platforms.mjs` are adapted from Jim Liu's baoyu-skills, commit
// `8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766`:
// 
// - [wechat-browser.ts](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-post-to-wechat/scripts/wechat-browser.ts)
// - [wechat-agent-browser.ts](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-post-to-wechat/scripts/wechat-agent-browser.ts)
// 
// Modified 2026-09-10: removed local processes, CDP and filesystem access; use
// in-memory images inside an existing page; require an empty, unambiguous native
// image editor; upload sequentially; preserve text; only trigger explicitly labeled
// draft buttons; report unverified saves as needing confirmation.
// 
// ```text
// MIT License
// 
// Copyright (c) 2026 Jim Liu
// 
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// 
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ```
// 
// ## OpenCLI — Apache-2.0
// 
// Xiaohongshu image-editor selectors are adapted from [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI/blob/8271afc67e8504bda94c147f446ee29775d08274/clis/xiaohongshu/publish.js),
// commit `8271afc67e8504bda94c147f446ee29775d08274`.
// 
// Copyright 2025 jackwener. Licensed under Apache License 2.0. The complete upstream
// license is included in [LICENSE-APACHE-2.0.txt](./LICENSE-APACHE-2.0.txt). The upstream
// tree at this commit does not contain a NOTICE file.
// 
// Include this notice (including the MIT license above) and the complete
// LICENSE-APACHE-2.0.txt when distributing the script, including in bundled builds.
// 
// Modified 2026-09-10: retained only image-editor selectors; removed network account
// lookup, browser management and private component-method invocation; only an exact
// visible draft-button label can trigger a save.
// 
//                                  Apache License
//                            Version 2.0, January 2004
//                         http://www.apache.org/licenses/
// 
//    TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
// 
//    1. Definitions.
// 
//       "License" shall mean the terms and conditions for use, reproduction,
//       and distribution as defined by Sections 1 through 9 of this document.
// 
//       "Licensor" shall mean the copyright owner or entity authorized by
//       the copyright owner that is granting the License.
// 
//       "Legal Entity" shall mean the union of the acting entity and all
//       other entities that control, are controlled by, or are under common
//       control with that entity. For the purposes of this definition,
//       "control" means (i) the power, direct or indirect, to cause the
//       direction or management of such entity, whether by contract or
//       otherwise, or (ii) ownership of fifty percent (50%) or more of the
//       outstanding shares, or (iii) beneficial ownership of such entity.
// 
//       "You" (or "Your") shall mean an individual or Legal Entity
//       exercising permissions granted by this License.
// 
//       "Source" form shall mean the preferred form for making modifications,
//       including but not limited to software source code, documentation
//       source, and configuration files.
// 
//       "Object" form shall mean any form resulting from mechanical
//       transformation or translation of a Source form, including but
//       not limited to compiled object code, generated documentation,
//       and conversions to other media types.
// 
//       "Work" shall mean the work of authorship, whether in Source or
//       Object form, made available under the License, as indicated by a
//       copyright notice that is included in or attached to the work
//       (an example is provided in the Appendix below).
// 
//       "Derivative Works" shall mean any work, whether in Source or Object
//       form, that is based on (or derived from) the Work and for which the
//       editorial revisions, annotations, elaborations, or other modifications
//       represent, as a whole, an original work of authorship. For the purposes
//       of this License, Derivative Works shall not include works that remain
//       separable from, or merely link (or bind by name) to the interfaces of,
//       the Work and Derivative Works thereof.
// 
//       "Contribution" shall mean any work of authorship, including
//       the original version of the Work and any modifications or additions
//       to that Work or Derivative Works thereof, that is intentionally
//       submitted to the Licensor for inclusion in the Work by the copyright owner
//       or by an individual or Legal Entity authorized to submit on behalf of
//       the copyright owner. For the purposes of this definition, "submitted"
//       means any form of electronic, verbal, or written communication sent
//       to the Licensor or its representatives, including but not limited to
//       communication on electronic mailing lists, source code control systems,
//       and issue tracking systems that are managed by, or on behalf of, the
//       Licensor for the purpose of discussing and improving the Work, but
//       excluding communication that is conspicuously marked or otherwise
//       designated in writing by the copyright owner as "Not a Contribution."
// 
//       "Contributor" shall mean Licensor and any individual or Legal Entity
//       on behalf of whom a Contribution has been received by the Licensor and
//       subsequently incorporated within the Work.
// 
//    2. Grant of Copyright License. Subject to the terms and conditions of
//       this License, each Contributor hereby grants to You a perpetual,
//       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
//       copyright license to reproduce, prepare Derivative Works of,
//       publicly display, publicly perform, sublicense, and distribute the
//       Work and such Derivative Works in Source or Object form.
// 
//    3. Grant of Patent License. Subject to the terms and conditions of
//       this License, each Contributor hereby grants to You a perpetual,
//       worldwide, non-exclusive, no-charge, royalty-free, irrevocable
//       (except as stated in this section) patent license to make, have made,
//       use, offer to sell, sell, import, and otherwise transfer the Work,
//       where such license applies only to those patent claims licensable
//       by such Contributor that are necessarily infringed by their
//       Contribution(s) alone or by combination of their Contribution(s)
//       with the Work to which such Contribution(s) was submitted. If You
//       institute patent litigation against any entity (including a
//       cross-claim or counterclaim in a lawsuit) alleging that the Work
//       or a Contribution incorporated within the Work constitutes direct
//       or contributory patent infringement, then any patent licenses
//       granted to You under this License for that Work shall terminate
//       as of the date such litigation is filed.
// 
//    4. Redistribution. You may reproduce and distribute copies of the
//       Work or Derivative Works thereof in any medium, with or without
//       modifications, and in Source or Object form, provided that You
//       meet the following conditions:
// 
//       (a) You must give any other recipients of the Work or
//           Derivative Works a copy of this License; and
// 
//       (b) You must cause any modified files to carry prominent notices
//           stating that You changed the files; and
// 
//       (c) You must retain, in the Source form of any Derivative Works
//           that You distribute, all copyright, patent, trademark, and
//           attribution notices from the Source form of the Work,
//           excluding those notices that do not pertain to any part of
//           the Derivative Works; and
// 
//       (d) If the Work includes a "NOTICE" text file as part of its
//           distribution, then any Derivative Works that You distribute must
//           include a readable copy of the attribution notices contained
//           within such NOTICE file, excluding any notices that do not
//           pertain to any part of the Derivative Works, in at least one
//           of the following places: within a NOTICE text file distributed
//           as part of the Derivative Works; within the Source form or
//           documentation, if provided along with the Derivative Works; or,
//           within a display generated by the Derivative Works, if and
//           wherever such third-party notices normally appear. The contents
//           of the NOTICE file are for informational purposes only and
//           do not modify the License. You may add Your own attribution
//           notices within Derivative Works that You distribute, alongside
//           or as an addendum to the NOTICE text from the Work, provided
//           that such additional attribution notices cannot be construed
//           as modifying the License.
// 
//       You may add Your own copyright statement to Your modifications and
//       may provide additional or different license terms and conditions
//       for use, reproduction, or distribution of Your modifications, or
//       for any such Derivative Works as a whole, provided Your use,
//       reproduction, and distribution of the Work otherwise complies with
//       the conditions stated in this License.
// 
//    5. Submission of Contributions. Unless You explicitly state otherwise,
//       any Contribution intentionally submitted for inclusion in the Work
//       by You to the Licensor shall be under the terms and conditions of
//       this License, without any additional terms or conditions.
//       Notwithstanding the above, nothing herein shall supersede or modify
//       the terms of any separate license agreement you may have executed
//       with Licensor regarding such Contributions.
// 
//    6. Trademarks. This License does not grant permission to use the trade
//       names, trademarks, service marks, or product names of the Licensor,
//       except as required for reasonable and customary use in describing the
//       origin of the Work and reproducing the content of the NOTICE file.
// 
//    7. Disclaimer of Warranty. Unless required by applicable law or
//       agreed to in writing, Licensor provides the Work (and each
//       Contributor provides its Contributions) on an "AS IS" BASIS,
//       WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
//       implied, including, without limitation, any warranties or conditions
//       of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
//       PARTICULAR PURPOSE. You are solely responsible for determining the
//       appropriateness of using or redistributing the Work and assume any
//       risks associated with Your exercise of permissions under this License.
// 
//    8. Limitation of Liability. In no event and under no legal theory,
//       whether in tort (including negligence), contract, or otherwise,
//       unless required by applicable law (such as deliberate and grossly
//       negligent acts) or agreed to in writing, shall any Contributor be
//       liable to You for damages, including any direct, indirect, special,
//       incidental, or consequential damages of any character arising as a
//       result of this License or out of the use or inability to use the
//       Work (including but not limited to damages for loss of goodwill,
//       work stoppage, computer failure or malfunction, or any and all
//       other commercial damages or losses), even if such Contributor
//       has been advised of the possibility of such damages.
// 
//    9. Accepting Warranty or Additional Liability. While redistributing
//       the Work or Derivative Works thereof, You may choose to offer,
//       and charge a fee for, acceptance of support, warranty, indemnity,
//       or other liability obligations and/or rights consistent with this
//       License. However, in accepting such obligations, You may act only
//       on Your own behalf and on Your sole responsibility, not on behalf
//       of any other Contributor, and only if You agree to indemnify,
//       defend, and hold each Contributor harmless for any liability
//       incurred by, or claims asserted against, such Contributor by reason
//       of your accepting any such warranty or additional liability.
// 
//    END OF TERMS AND CONDITIONS
// 
//    Copyright 2025 jackwener
// 
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
// 
//        http://www.apache.org/licenses/LICENSE-2.0
// 
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.
// 

(function installBrowserSync({ window, document, GM }, createPlatformAdapter) {
  const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
  const CHANNEL = "zhepage-browser-sync-v1";
  const TTL = 30 * 60 * 1000;
  const IMAGE_LIMIT = 1024 * 1024;
  const platforms = ["xiaohongshu", "wechat"];
  if (window.top !== window.self) return;
  const key = (platform) => `${CHANNEL}:${platform}`;
  const isSource = () => window.location.origin === ORIGIN && window.location.pathname === "/browser-sync-check.html";
  const reply = (id, payload) => window.postMessage({ channel: CHANNEL, kind: "response", id, ...payload }, ORIGIN);
  const statusOf = (job) => job ? { id: job.id, status: job.status, message: job.message, title: job.draft.title, imageCount: job.draft.images.length } : null;
  async function write(job) {
    await GM.setValue(key(job.platform), job);
    if (JSON.stringify(await GM.getValue(key(job.platform), null)) !== JSON.stringify(job)) throw new Error("浏览器存储读回不一致，操作未确认。请先检查平台页面，不要重复导入或保存");
  }
  async function read(platform) {
    const job = await GM.getValue(key(platform), null);
    if (!job) return null;
    if (job.platform !== platform || !Number.isFinite(job.createdAt) || job.createdAt > Date.now() || !["ready", "filling", "filled", "needs_confirmation"].includes(job.status)) throw new Error("待传内容记录无效，请先核对平台页面并结束本次验证");
    // An interrupted upload/save remains protected until the user ends it.
    if (job.status === "ready" && Date.now() - job.createdAt > TTL) {
      await GM.deleteValue(key(platform));
      return null;
    }
    return job;
  }
  function validate(value) {
    if (!value || !platforms.includes(value.platform) || typeof value.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)) throw new Error("待传内容格式无效");
    const { title, body, images } = value.draft || {};
    if (typeof title !== "string" || !title.trim() || [...title].length > 20 || typeof body !== "string" || [...body].length > 1000) throw new Error("标题需要 1–20 字，文案最多 1000 字");
    const topicCount = (body.match(/(?:^|\s)(?:#[^\s#]+#?)+/gu) ?? []).reduce((sum, group) => sum + (group.match(/#[^\s#]+#?/gu)?.length ?? 0), 0);
    if (topicCount > 10) throw new Error("文案最多 10 个话题");
    if (!Array.isArray(images) || images.length < 1 || images.length > 2) throw new Error("本次验证最多传入 2 张图片");
    let total = 0;
    const clean = images.map((image) => {
      if (!image || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200 || !["image/png", "image/jpeg"].includes(image.mime) || typeof image.dataUrl !== "string" || image.dataUrl.length > Math.ceil(IMAGE_LIMIT / 3) * 4 + 32) throw new Error("本次验证单张图片最多 1 MiB，仅支持 PNG 或 JPEG");
      const prefix = `data:${image.mime};base64,`;
      if (!image.dataUrl.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl.slice(prefix.length))) throw new Error("只能传入浏览器中生成的 PNG 或 JPEG 图片");
      const encoded = image.dataUrl.slice(prefix.length);
      const decoded = window.atob(encoded);
      if (window.btoa(decoded) !== encoded) throw new Error("图片编码无效，请重新准备测试图片");
      const bytes = decoded.length;
      if (bytes === 0 || bytes > IMAGE_LIMIT || (total += bytes) > 2 * IMAGE_LIMIT) throw new Error("本次验证单张图片最多 1 MiB，一组最多 2 MiB");
      return { name: image.name, mime: image.mime, dataUrl: image.dataUrl };
    });
    return { id: value.id, platform: value.platform, createdAt: Date.now(), status: "ready", message: "内容已留在浏览器扩展中，尚未上传", draft: { title, body, images: clean } };
  }

  if (isSource()) {
    let saving = false;
    window.addEventListener("message", async (event) => {
      const message = event.data;
      if (!isSource() || event.source !== window || event.origin !== ORIGIN || message?.channel !== CHANNEL || message.kind !== "request" || typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return;
      try {
        if (message.action === "ping") return reply(message.id, { ok: true, version: "0.1.0" });
        if (!platforms.includes(message.platform)) throw new Error("未知平台");
        if (message.action === "status") return reply(message.id, { ok: true, job: statusOf(await read(message.platform)) });
        if (message.action !== "prepare") throw new Error("未知操作");
        if (saving) throw new Error("正在准备上一组图片，请稍后重试");
        saving = true;
        try {
          const current = await read(message.platform);
          if (current && ["filling", "filled", "needs_confirmation"].includes(current.status)) throw new Error("上一组内容已开始上传。请先在平台确认结果，并在传图面板点击“结束本次验证”");
          const job = validate(message);
          await write(job);
          reply(message.id, { ok: true, job: statusOf(job) });
        } finally { saving = false; }
      } catch (error) { reply(message.id, { ok: false, message: error instanceof Error ? error.message : "浏览器存储不可用" }); }
    });
    return;
  }

  const platform = window.location.origin === "https://creator.xiaohongshu.com" ? "xiaohongshu" : window.location.origin === "https://mp.weixin.qq.com" ? "wechat" : null;
  if (!platform || document.getElementById("zhepage-browser-sync-panel")) return;
  const adapter = createPlatformAdapter({ window, document });
  const host = document.createElement("div");
  host.id = "zhepage-browser-sync-panel";
  host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = ":host{all:initial;font:14px/1.5 system-ui,sans-serif;color:#292624}section{box-sizing:border-box;width:300px;max-height:75vh;overflow:auto;padding:18px;background:#fffdf9;border:1px solid #ded7ce;border-radius:16px;box-shadow:0 8px 35px #0002}h2{margin:0 0 8px;font-size:17px}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#766e65}button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #d7cfc5;background:white;cursor:pointer;margin:6px 6px 0 0}button:disabled{opacity:.45;cursor:default}button.primary{background:#a83728;color:#fff;border-color:#a83728}.images{display:flex;gap:5px;overflow:auto;margin-top:8px}.images img{width:48px;height:62px;object-fit:contain;background:#eee}";
  const section = document.createElement("section");
  section.setAttribute("aria-label", "折页浏览器传图验证");
  const title = document.createElement("h2"); title.textContent = "折页 · 浏览器传图验证";
  const note = document.createElement("small"); note.textContent = "请先进入空白的图文/贴图编辑器。";
  const description = document.createElement("p"); description.textContent = "点击检查，读取这台浏览器中准备的内容。";
  const preview = document.createElement("div"); preview.className = "images";
  const message = document.createElement("p"); message.setAttribute("role", "status");
  section.append(title, note, description, preview, message);
  root.append(style, section);
  document.documentElement.append(host);
  let current = null;
  let busy = false;
  const buttons = [];
  function button(label, action, primary = false) {
    const element = document.createElement("button");
    element.type = "button"; element.textContent = label; element.className = primary ? "primary" : "";
    element.addEventListener("click", async () => {
      if (busy) return;
      busy = true; buttons.forEach((item) => { item.disabled = true; });
      try { await action(); }
      catch (error) { message.textContent = error instanceof Error ? error.message : "当前操作未完成，请检查平台页面"; }
      finally { busy = false; buttons.forEach((item) => { item.disabled = false; }); }
    });
    buttons.push(element); section.append(element);
    return element;
  }
  async function refresh() {
    current = await read(platform);
    preview.replaceChildren();
    if (!current) { description.textContent = "没有待传内容，或已超过 30 分钟。请返回折页重新准备。"; message.textContent = ""; return; }
    description.textContent = `${current.draft.title}\n${current.draft.images.length} 张图片 · ${platform === "wechat" ? "公众号贴图" : "小红书图文"}`;
    for (const image of current.draft.images) {
      const img = document.createElement("img"); img.src = image.dataUrl; img.alt = image.name; preview.append(img);
    }
    message.textContent = current.message;
  }
  button("检查待传内容", refresh);
  button("填入当前编辑器", async () => {
    const job = await read(platform);
    if (!current || job?.id !== current.id) throw new Error("请先检查本次待传内容");
    if (job.status !== "ready") throw new Error("本次内容已开始处理，请核对平台页面，不要重复导入");
    const inspection = await adapter.inspect(platform);
    if (!inspection?.ready || !inspection.empty) throw new Error(inspection?.message || "请先进入空白的图文/贴图编辑器，再填入本次内容");
    job.status = "filling"; job.message = "正在填入平台编辑器，请保持此页打开";
    await write(job);
    message.textContent = job.message;
    try {
      await adapter.fill(platform, job.draft);
      job.status = "filled"; job.message = "图片与文案已填入编辑器，尚未确认保存。核对账号、图片顺序和文案后，再保存草稿。";
    } catch (error) {
      job.status = "needs_confirmation";
      job.message = `导入尚未完成：${error instanceof Error ? error.message : "请检查平台页面"}。请先核对当前内容，不要重复导入。`;
    }
    try { await write(job); }
    catch { throw new Error(`${job.message}\n浏览器未能保存本次结果，请先核对平台页面，不要重复导入。`); }
    await refresh();
  }, true);
  button("保存为平台草稿", async () => {
    const job = await read(platform);
    if (!current || job?.id !== current.id || job.status !== "filled") throw new Error("请先完成导入并核对页面；如已手动保存，请结束本次验证");
    job.status = "needs_confirmation"; job.message = "已请求保存操作，请到平台草稿箱核对结果";
    await write(job);
    try {
      const result = await adapter.save(platform);
      job.message = result?.message || "已触发保存，请到平台草稿箱核对。当前尚无可验证的平台回执。";
    } catch (error) { job.message = error instanceof Error ? error.message : "未能触发保存，请在平台手动保存草稿"; }
    try { await write(job); }
    catch { throw new Error(`${job.message}\n浏览器未能保存本次结果，请到平台草稿箱核对，不要重复保存。`); }
    await refresh();
  });
  button("结束本次验证", async () => {
    const job = await GM.getValue(key(platform), null);
    if (job?.platform === platform && job.status === "filling" && Number.isFinite(job.createdAt) && job.createdAt <= Date.now() && Date.now() - job.createdAt <= TTL) throw new Error("图片仍在上传，请等待完成；若操作中断，请先核对平台页面，30 分钟后可结束本次验证");
    await GM.deleteValue(key(platform));
    if (await GM.getValue(key(platform), null) !== null) throw new Error("浏览器中的临时内容尚未清除，请检查扩展存储");
    await refresh();
    message.textContent = "浏览器扩展中的这组临时图片已清除。平台草稿是否保存，请以平台显示为准。";
  });
})({ window, document, GM }, function createPlatformAdapter({ window, document }) {
  // Keep every dependency inside this function: the userscript serializes it.
  const configs = {
    wechat: {
      origin: "https://mp.weixin.qq.com", path: /^\/cgi-bin\/appmsg/,
      input: '.js_upload_btn_container input[type="file"]', title: "#title",
      body: '.ProseMirror[contenteditable="true"], .js_pmEditorArea[contenteditable="true"]',
      images: '.weui-desktop-upload__thumb, .pic_item, [class*="upload__thumb"]',
      progress: '[class*="upload_loading"], [class*="uploading"], .weui-desktop-upload__loading',
      dialog: ".weui-desktop-dialog__wrp", save: "保存为草稿", maximum: 20,
    },
    xiaohongshu: {
      origin: "https://creator.xiaohongshu.com", path: /^\/publish\/publish\/?$/,
      input: 'input[type="file"][accept*="image"], input[type="file"][accept*=".jpg"], input[type="file"][accept*=".png"], input[type="file"][accept*=".jpeg"]',
      title: '[contenteditable="true"][placeholder*="标题"], input[placeholder*="标题"], input[placeholder*="title" i], .title-input input, .note-title input',
      body: '[contenteditable="true"][class*="content"], [contenteditable="true"][class*="editor"], [contenteditable="true"][placeholder*="正文"], [contenteditable="true"][placeholder*="描述"], [contenteditable="true"][placeholder*="内容"]',
      images: ".img-preview-area .pr",
      progress: '[class*="upload"][class*="progress"], [class*="uploading"], [class*="loading"][class*="image"]',
      dialog: ".d-dialog, .el-dialog, .d-modal", save: "暂存离开", maximum: 18,
    },
  };
  let filling = false;
  let prepared = null;
  let saveAttempted = false;
  const stop = (message) => { throw new Error(message); };
  const normalize = (text) => text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const value = (element) => normalize(element ? ("value" in element ? element.value : element.innerText ?? element.textContent ?? "") : "");
  const disabled = (element) => element.disabled || element.getAttribute("aria-disabled") === "true";
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const rect = element.getBoundingClientRect();
    for (let node = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return rect.width > 0 && rect.height > 0;
  };
  const all = (selector) => [...document.querySelectorAll(selector)];
  const unique = (selector, exclude) => {
    const matches = all(selector).filter((element) => element !== exclude && visible(element));
    if (matches.length > 1) stop("发现多个编辑区域，请只保留一个空白图片编辑器");
    return matches[0];
  };
  function state(platform) {
    const config = configs[platform];
    const url = new window.URL(window.location.href);
    if (!config || url.origin !== config.origin || !config.path.test(url.pathname)) stop("请先打开该平台的原生图片编辑器");
    if (platform === "xiaohongshu" && url.searchParams.get("target") !== "image") stop("请打开小红书的上传图文页面，当前页面不能导入");
    const inputs = all(config.input).filter((element) => !disabled(element));
    if (inputs.length !== 1) stop("无法唯一确认图片上传入口，请检查当前编辑器");
    const title = unique(config.title);
    const body = unique(config.body, title);
    if (platform === "wechat") {
      const labeled = all('h1, h2, h3, [role="heading"], .weui-desktop-breadcrum, .weui-desktop-panel__title')
        .some((element) => visible(element) && /^(?:贴图|图文|图文消息|图片消息)(?:编辑)?$/.test(value(element).trim()));
      if (document.querySelector(".rich_media_content") || !title || !body || (!labeled && !body.matches(".js_pmEditorArea"))) {
        stop("尚不能确认公众号原生贴图编辑器，请打开贴图；普通文章不支持此操作");
      }
    }
    if ((title && disabled(title)) || (body && disabled(body))) stop("当前编辑区域不可填写，请先完成页面上的提示");
    const candidates = all(config.images).filter(visible);
    const images = candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
    const previewsReady = images.every((element) => {
      const image = element.matches("img") ? element : element.querySelector("img");
      return image?.complete && image.naturalWidth > 0;
    });
    const blocked = !previewsReady || all(`${config.progress}, ${config.dialog}`).some(visible);
    const existingId = [...url.searchParams].some(([key, item]) => item && /^(?:draft_?id|note_?id|appmsgid|appmsg_id)$/i.test(key));
    const existing = Boolean(value(title).trim() || value(body).trim() || images.length || inputs[0].files?.length || existingId);
    return { config, input: inputs[0], title, body, images, blocked, existing };
  }
  function inspect(platform) {
    try {
      const current = state(platform);
      return { ready: !current.blocked && !filling, empty: !current.existing, imageCount: current.images.length,
        message: current.blocked ? "页面正在处理图片或有弹窗，请先完成" : current.existing ? "当前编辑器已有内容，系统不会覆盖" : "空白图片编辑器已就绪" };
    } catch (error) { return { ready: false, empty: false, imageCount: 0, message: error.message }; }
  }
  const sameImages = (current, previous) => previous.every((element, index) => current[index] === element);
  function untouched(current, count, previous) {
    if (current.blocked || current.images.length !== count || !sameImages(current.images, previous) || value(current.title).trim() || value(current.body).trim()) {
      stop("图片或正文在导入过程中发生变化，已停止；请核对当前页面，勿重复导入");
    }
  }
  function filesFor(platform, draft) {
    if (!draft || typeof draft.title !== "string" || !draft.title.trim() || [...draft.title].length > 20 || typeof draft.body !== "string" ||
      !Array.isArray(draft.images) || !draft.images.length || draft.images.length > configs[platform].maximum) stop("标题或图片列表无效，请先在折页检查内容");
    return draft.images.map((image) => {
      const match = typeof image?.dataUrl === "string" && /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
      if (!match || match[1] !== image.mime || typeof image.name !== "string" || !image.name.trim() || match[2].length > 14 * 1024 * 1024) stop("图片数据无效，请重新生成图片");
      let bytes;
      try { bytes = window.Uint8Array.from(window.atob(match[2]), (character) => character.charCodeAt(0)); }
      catch { stop("图片数据无效，请重新生成图片"); }
      const signature = image.mime === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
      if (!signature.every((byte, index) => bytes[index] === byte)) stop("图片格式与内容不一致，已停止导入");
      return new window.File([bytes], image.name, { type: image.mime });
    });
  }
  async function waitForUpload(platform, count, previous) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const current = state(platform);
      if (!sameImages(current.images, previous) || current.images.length > count || value(current.title).trim() || value(current.body).trim()) {
        stop("图片或正文在上传过程中发生变化，请检查已上传内容，勿重复导入");
      }
      if (!current.blocked && current.images.length === count && current.title && current.body) return current;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    stop("图片上传未能确认完成，已保留当前页面；请检查后手动处理，勿重复导入");
  }
  function fillField(element, text) {
    if (!element || value(element).trim()) stop("填写前发现已有文案，已停止并保留原内容");
    element.focus();
    if ("value" in element) {
      const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      if (text && (!document.execCommand || !document.execCommand("insertText", false, text))) stop("当前正文编辑器未接受填写，请检查内容后手动完成");
    }
    element.blur();
    if (value(element) !== normalize(text)) stop("编辑器中的文案未能核对一致，请手动检查");
  }
  async function fill(platform, draft) {
    if (filling || prepared || saveAttempted) stop("本页已处理过一次导入，请先核对当前草稿");
    let current = state(platform);
    if (current.existing || current.blocked) stop("当前页面已有内容、图片或弹窗，已停止导入，原内容保持不变");
    const files = filesFor(platform, draft);
    const copy = { title: draft.title, body: draft.body };
    filling = true;
    try {
      let previous = [];
      for (let index = 0; index < files.length; index++) {
        current = state(platform);
        untouched(current, index, previous);
        const transfer = new window.DataTransfer();
        transfer.items.add(files[index]);
        current.input.files = transfer.files;
        current.input.dispatchEvent(new window.Event("change", { bubbles: true }));
        current = await waitForUpload(platform, index + 1, previous);
        previous = current.images.slice();
      }
      current = state(platform);
      untouched(current, files.length, previous);
      fillField(current.title, copy.title);
      current = state(platform);
      if (current.blocked || current.images.length !== files.length || !sameImages(current.images, previous) || value(current.title) !== normalize(copy.title)) stop("填写时图片或标题发生变化，请手动检查");
      fillField(current.body, copy.body);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      current = state(platform);
      if (current.blocked || current.images.length !== files.length || !sameImages(current.images, previous) || value(current.title) !== normalize(copy.title) || value(current.body) !== normalize(copy.body)) stop("页面中的内容尚未核对一致，请手动检查后保存");
      prepared = { platform, ...copy, images: previous };
      return { status: "filled", message: "标题、文案和图片已填入，请检查当前账号与图片顺序后保存草稿" };
    } finally { filling = false; }
  }
  function save(platform) {
    if (filling || !prepared || prepared.platform !== platform || saveAttempted) stop("请先完成本页内容导入并核对；不能重复触发保存");
    const current = state(platform);
    if (current.blocked || current.images.length !== prepared.images.length || !sameImages(current.images, prepared.images) || value(current.title) !== normalize(prepared.title) || value(current.body) !== normalize(prepared.body)) stop("当前内容发生变化，请手动检查并保存草稿");
    const buttons = all('button, [role="button"], a').filter((element) => visible(element) && (element.innerText ?? element.textContent ?? "").trim() === current.config.save);
    if (buttons.length !== 1 || disabled(buttons[0])) stop(`未找到唯一可用的“${current.config.save}”，请在平台手动保存`);
    saveAttempted = true;
    try { buttons[0].click(); } catch { /* The action may have reached the platform; never retry it. */ }
    return { status: "needs_confirmation", message: `已触发“${current.config.save}”，请到平台草稿箱核对；当前无法自动验证是否保存成功` };
  }
  return { inspect, fill, save };
});
