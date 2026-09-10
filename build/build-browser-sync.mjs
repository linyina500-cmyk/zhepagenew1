import { readFile, writeFile } from "node:fs/promises";
import { installBrowserSync } from "../lib/browserSync/bridge.mjs";
import { createPlatformAdapter } from "../lib/browserSync/platforms.mjs";

const origin = "https://feature-local-draft-sync.zhepagenew.pages.dev";
const metadata = `// ==UserScript==
// @name         折页 · 浏览器传图验证
// @namespace    ${origin}/browser-sync
// @version      0.2.1
// @description  在当前浏览器中，把完整文章图片和文案填入小红书图文或公众号贴图编辑器。不会发布。
// @match        ${origin}/
// @match        ${origin}/browser-sync-check
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
`;
const notices = await readFile(new URL("../lib/browserSync/THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
const apacheLicense = await readFile(new URL("../lib/browserSync/LICENSE-APACHE-2.0.txt", import.meta.url), "utf8");
const licenseComment = `${notices}\n${apacheLicense}`.split("\n").map((line) => `// ${line}`).join("\n");
// The two factories are self-contained, ordinary JavaScript. This emits a static
// script with no runtime imports, eval, third-party CDN, or downloaded libraries.
await writeFile(new URL("../public/zhepage-browser-sync.user.js", import.meta.url), `${metadata}\n${licenseComment}\n\n(${installBrowserSync.toString()})({ window, document, GM }, ${createPlatformAdapter.toString()});\n`);
