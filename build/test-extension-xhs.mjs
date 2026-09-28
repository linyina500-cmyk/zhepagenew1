// Real unpacked MV3 extension + Chromium, using local route fixtures only.
// No real social account, platform upload endpoint or publish action is used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { packBrowserExtension } from "./pack-browser-extension.mjs";

function creatorFixture() {
  const style = document.createElement("style");
  style.textContent = "button,input,.btn{display:block;min-width:100px;min-height:30px}.pr{width:80px;height:80px;display:inline-block}.pr img{width:40px;height:40px}.tiptap{min-width:300px;min-height:100px}.account-name,.text,.base,.personal,.home-card-wrapper,.others,.others>div,xhs-publish-btn{display:block;min-width:100px;min-height:20px}";
  document.head.append(style);
  if (location.pathname === "/new/home") {
    document.body.innerHTML = '<div class="home-card-wrapper"><div class="personal"><div class="base"><div class="text"><span class="account-name">测试账号</span><div class="others description-text"><div>小红书账号: fixture-420</div></div></div></div></div></div>';
    return;
  }
  const drafts = () => JSON.parse(localStorage.getItem("fixture-drafts") || "[]");
  let state;
  const text = (element) => {
    if (!element) return "";
    const children = [...element.childNodes];
    if (children.every((node) => node.nodeType === 1 && node.tagName === "P")) return children.map((node) => node.innerText.replace(/\n$/u, "")).join("\n");
    return element.innerText;
  };
  class SaveButtons extends HTMLElement {
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: "closed" });
      shadow.innerHTML = '<button>暂存离开</button><button>发布</button>';
      this._onSave = () => {
        const values = drafts();
        values.push({ ...state, id: crypto.randomUUID() });
        localStorage.setItem("fixture-drafts", JSON.stringify(values));
        localStorage.setItem("fixture-save-count", String(Number(localStorage.getItem("fixture-save-count") || "0") + 1));
        showDrafts();
      };
      this._onPublish = () => { localStorage.setItem("fixture-publish-count", "1"); throw Error("Publish must never run"); };
      shadow.querySelectorAll("button")[0].onclick = this._onSave;
      shadow.querySelectorAll("button")[1].onclick = this._onPublish;
    }
  }
  customElements.define("xhs-publish-btn", SaveButtons);
  function appendImage(source) {
    const card = document.createElement("div"); card.className = "pr";
    card.innerHTML = '<img><div class="image-editor-control"><button class="edit-btn">编辑</button></div>';
    card.querySelector("img").src = source;
    document.querySelector(".img-preview-area").append(card);
  }
  function showEditor(value = { title: "", body: "", sources: [] }) {
    state = structuredClone(value);
    document.body.innerHTML = '<button id="draft-entry"></button><input type="file" multiple accept="image/png,image/jpeg"><input id="title" placeholder="填写标题"><div class="tiptap ProseMirror" contenteditable="true"><p><br class="ProseMirror-trailingBreak"></p></div><div class="img-preview-area"></div><xhs-publish-btn is-save-draft="true" save-text="暂存离开" save-disabled="false"></xhs-publish-btn>';
    const title = document.querySelector("#title"), body = document.querySelector(".tiptap");
    title.value = value.title;
    if (value.body) { body.replaceChildren(...value.body.split("\n").map((line) => { const p = document.createElement("p"); p.textContent = line; if (!line) p.innerHTML = '<br class="ProseMirror-trailingBreak">'; return p; })); }
    title.addEventListener("input", () => { state.title = title.value; });
    body.addEventListener("input", () => { state.body = text(body); });
    for (const source of value.sources) appendImage(source);
    document.querySelector("#draft-entry").textContent = `草稿箱(${drafts().length})`;
    document.querySelector("#draft-entry").onclick = showDrafts;
    document.querySelector('input[type="file"]').addEventListener("change", async (event) => {
      for (const file of event.target.files) {
        const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        state.sources.push(source); appendImage(URL.createObjectURL(file));
      }
    });
  }
  function showDrafts() {
    const values = drafts();
    document.body.innerHTML = `<button>图文笔记(${values.length})</button>`;
    for (const draft of values) {
      const card = document.createElement("div"); card.className = "draft-item";
      card.dataset.draftType = "image"; card.dataset.draftId = draft.id;
      const label = document.createElement("div"); label.className = "draft-title-text"; label.textContent = draft.title;
      const edit = document.createElement("div"); edit.className = "btn"; edit.textContent = "编辑"; edit.onclick = () => showEditor(draft);
      card.append(label, edit); document.body.append(card);
    }
  }
  showEditor(location.search.includes("existing=1") ? { title: "原有未保存标题", body: "请勿覆盖这篇内容", sources: [] } : undefined);
}

const scratch = await mkdtemp(join(tmpdir(), "zhepage-xhs-extension-"));
let context, server;
try {
  const bundle = await packBrowserExtension(join(scratch, "package"));
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(scratch, "key.pem"), "-out", join(scratch, "cert.pem"), "-days", "1", "-subj", "/CN=fixture.invalid"]);
  server = createServer({ key: await readFile(join(scratch, "key.pem")), cert: await readFile(join(scratch, "cert.pem")) }, (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.headers.host === "creator.xiaohongshu.com") return res.end(`<html><head><meta charset="utf-8"></head><body><script>(${creatorFixture.toString()})()</script></body></html>`);
    if (req.headers.host === "feature-local-draft-sync.zhepagenew.pages.dev") return res.end('<html><head><meta charset="utf-8"></head><body>折页扩展测试</body></html>');
    res.writeHead(403); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const launch = () => chromium.launchPersistentContext(join(scratch, "profile"), {
    channel: "chromium", headless: true, chromiumSandbox: true,
    args: [`--disable-extensions-except=${bundle.directory}`, `--load-extension=${bundle.directory}`,
      "--ignore-certificate-errors", "--no-proxy-server", `--host-resolver-rules=MAP creator.xiaohongshu.com 127.0.0.1:${port}, MAP feature-local-draft-sync.zhepagenew.pages.dev 127.0.0.1:${port}, MAP * ~NOTFOUND`],
    viewport: { width: 1200, height: 900 },
  });
  context = await launch();
  const original = await context.newPage();
  await original.goto("https://creator.xiaohongshu.com/publish/publish?target=image&existing=1");
  let page = await context.newPage();
  await page.goto("https://feature-local-draft-sync.zhepagenew.pages.dev/");
  const rpc = (message) => page.evaluate(({ extensionId, message }) => chrome.runtime.sendMessage(extensionId, message), { extensionId: bundle.id, message });
  const paired = await rpc({ protocol: 1, type: "pair", nonce: randomUUID() });
  assert.match(paired.connectionToken, /^[a-f0-9]{64}$/u);
  const request = (path, method = "GET", body) => rpc({ protocol: 1, type: "request", token: paired.connectionToken, path, method, ...(body ? { body } : {}) });
  const login = await request("/api/xiaohongshu/login", "POST");
  if (login.body.status !== "connected") {
    console.info(JSON.stringify({ login, pages: await Promise.all(context.pages().map(async (page) => ({ url: page.url(), content: (await page.content()).slice(0, 2500) }))) }));
  }
  assert.equal(login.status, 200); assert.equal(login.body.status, "connected");
  const account = login.body.account;
  const images = await page.evaluate(() => ["#bb3322", "#2266cc"].map((color) => {
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 6;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 4, 6); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  const jobId = randomUUID(), title = "两张图片测试", body = "第一段\n\n第二段";
  const form = { kind: "form", entries: [
    { key: "id", value: jobId }, { key: "expectedAccountId", value: account.id }, { key: "title", value: title }, { key: "body", value: body },
    ...images.map((data, index) => ({ key: "images", file: { name: `poster-${index + 1}.png`, type: "image/png", data } })),
  ] };
  const created = await request("/api/xiaohongshu/jobs", "POST", form);
  assert.equal(created.status, 202, JSON.stringify(created));
  let result;
  for (let attempt = 0; attempt < 150; attempt++) {
    result = await request(`/api/xiaohongshu/jobs/${jobId}`);
    if (!["uploading", "creating"].includes(result.body.job?.status)) break;
    await pause(200);
  }
  if (result.body.job?.status !== "saved") console.info(JSON.stringify(await Promise.all(context.pages().map(async (page) => ({ url: page.url(), content: (await page.content()).slice(0, 2500) })))));
  assert.equal(result.body.job?.status, "saved", JSON.stringify(result));
  assert.equal(result.body.job.uploadedCount, 2); assert.ok(result.body.job.draftId);
  assert.equal(await original.locator("#title").inputValue(), "原有未保存标题");
  const evidence = await original.evaluate(() => ({ count: localStorage.getItem("fixture-save-count"), published: localStorage.getItem("fixture-publish-count"), drafts: JSON.parse(localStorage.getItem("fixture-drafts") || "[]") }));
  assert.equal(evidence.count, "1"); assert.equal(evidence.published, null); assert.equal(evidence.drafts.length, 1);
  assert.equal(evidence.drafts[0].title, title); assert.equal(evidence.drafts[0].body, body);
  assert.deepEqual(evidence.drafts[0].sources.map((source) => source.split(",")[1]), images);
  assert.equal((await request("/api/xiaohongshu/jobs", "POST", form)).body.job.status, "saved");
  assert.equal(await original.evaluate(() => localStorage.getItem("fixture-save-count")), "1");
  await context.close(); context = await launch();
  const preserved = await context.newPage();
  await preserved.goto("https://creator.xiaohongshu.com/publish/publish?target=image&existing=1");
  page = await context.newPage(); await page.goto("https://feature-local-draft-sync.zhepagenew.pages.dev/");
  const restartedPair = await rpc({ protocol: 1, type: "pair", nonce: randomUUID() });
  assert.equal(restartedPair.connectionToken, paired.connectionToken);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get("zhepage:xhs:owned-tabs")), {});
  const verified = await request(`/api/xiaohongshu/jobs/${jobId}/verify`, "POST");
  assert.equal(verified.body.job?.status, "saved", JSON.stringify(verified));
  assert.equal(verified.body.job.draftId, result.body.job.draftId);
  assert.equal(await preserved.locator("#title").inputValue(), "原有未保存标题");
  assert.equal(await preserved.evaluate(() => localStorage.getItem("fixture-save-count")), "1");
  assert.equal(await preserved.evaluate(() => localStorage.getItem("fixture-publish-count")), null);
  console.info("MV3 Xiaohongshu fixture passed: isolated script serialization, native editing events, two DataTransfer uploads, canvas fingerprints, MAIN draft save, reopen verification, idempotency, untouched user editor and known-draft recovery after real browser restart.");
} finally {
  await context?.close(); server?.closeAllConnections(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); await rm(scratch, { recursive: true, force: true });
}
