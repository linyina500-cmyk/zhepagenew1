import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createPlatformAdapter } from "../lib/browserSync/platforms.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==";
const draft = { title: "测试贴图", body: "第一行\n第二行", images: ["1.png", "2.png"].map((name) => ({ name, mime: "image/png", dataUrl: png })) };

function fixture(t, platform = "wechat") {
  const wechat = platform === "wechat";
  const dom = new JSDOM(`<h1>${wechat ? "贴图" : "上传图文"}</h1><div class="js_upload_btn_container"><input type="file" accept="image/png" multiple></div><input id="title" placeholder="标题"><div class="ProseMirror content-editor" contenteditable="true"></div><div class="img-preview-area"></div><button>${wechat ? "保存为草稿" : "暂存离开"}</button><button>发布</button>`, {
    url: wechat ? "https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit" : "https://creator.xiaohongshu.com/publish/publish?target=image",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 });
  window.DataTransfer = class {
    files = [];
    items = { add: (file) => this.files.push(file) };
  };
  document.execCommand = (command, _ui, text) => {
    assert.equal(command, "insertText");
    document.activeElement.textContent = text;
    return true;
  };
  const input = document.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { writable: true, value: [] });
  const uploaded = [];
  const appendPreview = (ready = true) => {
    const preview = document.createElement("div");
    preview.className = wechat ? "pic_item" : "pr";
    const image = document.createElement("img");
    Object.defineProperties(image, { complete: { configurable: true, value: ready }, naturalWidth: { configurable: true, value: ready ? 1 : 0 } });
    preview.append(image);
    document.querySelector(".img-preview-area").append(preview);
    return image;
  };
  input.addEventListener("change", () => { uploaded.push(...input.files); appendPreview(); });
  // Compile the serialized function as the userscript will: no module imports.
  const factory = new Function(`return (${createPlatformAdapter.toString()})`)();
  return { window, document, input, uploaded, appendPreview, adapter: factory({ window, document }) };
}

for (const platform of ["wechat", "xiaohongshu"]) {
  test(`${platform}: an empty image editor receives ordered in-memory images and saves once without publishing`, async (t) => {
    const app = fixture(t, platform);
    let saved = 0;
    let published = 0;
    const [save, publish] = app.document.querySelectorAll("button");
    save.addEventListener("click", () => saved++);
    publish.addEventListener("click", () => published++);
    assert.equal(app.adapter.inspect(platform).empty, true);
    assert.equal((await app.adapter.fill(platform, draft)).status, "filled");
    assert.deepEqual(app.uploaded.map((file) => file.name), ["1.png", "2.png"]);
    assert.ok(app.uploaded.every((file) => file instanceof app.window.File && file.type === "image/png" && file.size > 50));
    assert.equal(app.document.querySelector("#title").value, draft.title);
    assert.equal(app.document.querySelector(".ProseMirror").textContent, draft.body);
    assert.equal(app.adapter.save(platform).status, "needs_confirmation");
    assert.throws(() => app.adapter.save(platform), /重复/);
    assert.equal(saved, 1);
    assert.equal(published, 0);
  });
}

test("existing content, images, or ambiguous upload inputs are preserved without writing", async (t) => {
  for (const kind of ["text", "image", "ambiguous"]) {
    const app = fixture(t);
    if (kind === "text") app.document.querySelector("#title").value = "用户原稿";
    if (kind === "image") app.appendPreview();
    if (kind === "ambiguous") app.input.after(app.input.cloneNode());
    const before = app.document.body.innerHTML;
    await assert.rejects(app.adapter.fill("wechat", draft), /已有|唯一/);
    assert.equal(app.document.body.innerHTML, before);
    assert.equal(app.uploaded.length, 0);
  }
});

test("ordinary WeChat articles and non-image XHS pages cannot be imported", async (t) => {
  const article = fixture(t);
  article.document.querySelector(".ProseMirror").classList.add("rich_media_content");
  assert.equal(article.adapter.inspect("wechat").ready, false);
  await assert.rejects(article.adapter.fill("wechat", draft), /普通文章/);
  const xhs = fixture(t, "xiaohongshu");
  xhs.window.history.replaceState(null, "", "?target=video");
  await assert.rejects(xhs.adapter.fill("xiaohongshu", draft), /上传图文/);
});

test("saving stops on changed text, ambiguous draft buttons, or a publish-only page", async (t) => {
  for (const kind of ["changed", "ambiguous", "publish-only"]) {
    const app = fixture(t);
    await app.adapter.fill("wechat", draft);
    const save = app.document.querySelector("button");
    if (kind === "changed") app.document.querySelector("#title").value = "其他内容";
    if (kind === "ambiguous") save.after(save.cloneNode(true));
    if (kind === "publish-only") save.remove();
    let clicks = 0;
    app.document.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => clicks++));
    assert.throws(() => app.adapter.save("wechat"), /发生变化|唯一/);
    assert.equal(clicks, 0);
  }
});

test("XHS continues through its first-upload transition using the add input, not the replacement input", async (t) => {
  const app = fixture(t, "xiaohongshu");
  app.document.querySelector(".ProseMirror").className = "tiptap ProseMirror";
  let replacements = 0;
  app.input.addEventListener("change", () => {
    const list = app.document.createElement("div");
    list.className = "img-list";
    const top = app.document.createElement("div");
    top.className = "top";
    const add = app.input.cloneNode();
    add.hidden = true;
    Object.defineProperty(add, "files", { writable: true, value: [] });
    add.addEventListener("change", () => { app.uploaded.push(...add.files); app.appendPreview(); });
    const replace = add.cloneNode();
    replace.multiple = false;
    replace.addEventListener("change", () => replacements++);
    top.append(add, replace);
    list.append(top);
    app.input.remove();
    // The input is briefly absent as XHS changes from the upload landing page
    // to its editor; that transition must not be treated as a failed upload.
    app.window.setTimeout(() => app.document.body.append(list), 20);
  }, { once: true });
  const fullDraft = { ...draft, images: [...draft.images, { ...draft.images[0], name: "3.png" }] };
  assert.equal((await app.adapter.fill("xiaohongshu", fullDraft)).status, "filled");
  assert.deepEqual(app.uploaded.map((file) => file.name), ["1.png", "2.png", "3.png"]);
  assert.equal(replacements, 0);
  assert.equal(app.document.querySelector("#title").value, fullDraft.title);
  assert.equal(app.document.querySelector(".tiptap").textContent, fullDraft.body);
});

for (const platform of ["wechat", "xiaohongshu"]) {
  test(`${platform}: ending a completed job permits a second group on the same page, preserving the first editor until cleared`, async (t) => {
    const app = fixture(t, platform);
    await app.adapter.fill(platform, draft);
    app.adapter.save(platform);
    await assert.rejects(app.adapter.fill(platform, draft), /已处理过一次/);
    const before = app.document.body.innerHTML;
    assert.equal(app.adapter.reset(platform).reset, true);
    await assert.rejects(app.adapter.fill(platform, draft), /新建空白/);
    assert.equal(app.document.body.innerHTML, before);
    // Simulate the platform opening a fresh editor without a full page reload.
    app.document.querySelector("#title").value = "";
    app.document.querySelector(".ProseMirror").textContent = "";
    app.document.querySelector(".img-preview-area").replaceChildren();
    app.input.files = [];
    const next = { ...draft, title: "第二组实际文案", body: "这是第二次上传\n图片仍按原顺序" };
    assert.equal((await app.adapter.fill(platform, next)).status, "filled");
    assert.equal(app.document.querySelector("#title").value, next.title);
    assert.equal(app.document.querySelector(".ProseMirror").textContent, next.body);
    assert.equal(app.adapter.save(platform).status, "needs_confirmation");
    assert.equal(app.uploaded.length, 4);
  });
}

test("an in-progress job cannot be reset, and a partial failure reports its confirmed image count", async (t) => {
  const app = fixture(t, "xiaohongshu");
  let changes = 0;
  app.input.addEventListener("change", () => {
    assert.equal(app.adapter.reset().reset, false);
    if (++changes === 2) app.document.querySelector("#title").value = "用户正在修改";
  });
  await assert.rejects(app.adapter.fill("xiaohongshu", draft), /已确认 1\/2 张图片.*发生变化/s);
  assert.equal(app.document.querySelector("#title").value, "用户正在修改");
  assert.equal(app.uploaded.length, 2);
});
