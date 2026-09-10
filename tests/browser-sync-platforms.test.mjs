import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createPlatformAdapter } from "../lib/browserSync/platforms.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==";
const draft = { title: "测试贴图", body: "第一行\n第二行", images: ["1.png", "2.png"].map((name) => ({ name, mime: "image/png", dataUrl: png })) };

function appendEditControl(preview) {
  const control = preview.ownerDocument.createElement("div");
  control.className = "image-editor-control";
  const button = preview.ownerDocument.createElement("button");
  button.className = "edit-btn"; button.textContent = "编辑";
  control.append(button); preview.append(control);
}

function fixture(t, platform = "wechat") {
  const wechat = platform === "wechat";
  const dom = new JSDOM(`<h1>${wechat ? "贴图" : "上传图文"}</h1><div class="js_upload_btn_container"><input type="file" accept="image/png" multiple></div><input id="title" placeholder="标题"><div class="ProseMirror content-editor" contenteditable="true"></div><div class="img-preview-area"></div><button data-draft-save>${wechat ? "保存为草稿" : "暂存离开"}</button><button>发布</button>`, {
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
    if (!wechat) appendEditControl(preview);
    document.querySelector(".img-preview-area").append(preview);
    return image;
  };
  input.addEventListener("change", () => { uploaded.push(...input.files); appendPreview(); });
  // Compile the serialized function as the userscript will: no module imports.
  const factory = new Function(`return (${createPlatformAdapter.toString()})`)();
  return { window, document, input, uploaded, appendPreview, adapter: factory({ window, document }) };
}

function installParagraphEditor(app, render) {
  const editor = app.document.querySelector(".ProseMirror");
  editor.className = "tiptap ProseMirror";
  // Browser innerText includes paragraph layout spacing. Reproduce the actual
  // XHS readback: an empty paragraph adds five newlines between its neighbours.
  Object.defineProperty(editor, "innerText", {
    configurable: true,
    get: () => [...editor.childNodes].map((node) => node.textContent || "\n").join("\n\n"),
  });
  app.document.execCommand = (command, _ui, text) => {
    assert.equal(command, "insertText");
    assert.equal(app.document.activeElement, editor);
    editor.replaceChildren();
    if (render) render(editor, text);
    else for (const line of text.split("\n")) {
      const paragraph = app.document.createElement("p");
      if (line) paragraph.textContent = line;
      else {
        const placeholder = app.document.createElement("br");
        placeholder.className = "ProseMirror-trailingBreak";
        paragraph.append(placeholder);
      }
      editor.append(paragraph);
    }
    return true;
  };
  return editor;
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
    const save = app.document.querySelector("[data-draft-save]");
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

for (const platform of ["wechat", "xiaohongshu"]) {
  test(`${platform}: ProseMirror paragraph readback preserves multiline copy and every empty line despite browser layout spacing`, async (t) => {
    const bodies = [
      "第一组：核对两张图片，顺序为01、02。\n第二行：检查标题和多段文案完整保留。\n\n仅保存草稿，不公开发布。",
      "\n开头空行要保留\n\n\n连续空行要保留\n",
    ];
    for (const body of bodies) {
      const app = fixture(t, platform), editor = installParagraphEditor(app);
      let saved = 0;
      app.document.querySelector("[data-draft-save]").addEventListener("click", () => saved++);
      assert.equal((await app.adapter.fill(platform, { ...draft, body })).status, "filled");
      assert.notEqual(editor.innerText, body, "the browser's visual spacing is not the original copy");
      assert.equal(editor.querySelectorAll("p").length, body.split("\n").length);
      assert.equal(app.adapter.save(platform).status, "needs_confirmation");
      assert.equal(saved, 1);
    }
  });
}

test("ProseMirror readback preserves genuine BR nodes and inline text while ignoring only its final placeholder", async (t) => {
  const variants = [
    { body: "第一段加粗与链接\n同段软换行\n\n末段", html: '<p>第一段<strong>加粗</strong>与<a href="https://example.com">链接</a><br>同段软换行</p><p><br class="ProseMirror-trailingBreak"></p><p><em>末段</em></p>' },
    { body: "第一行\n\n后段", html: '<p>第一行<br><br class="ProseMirror-trailingBreak"></p><p>后段</p>' },
  ];
  for (const { body, html } of variants) {
    const app = fixture(t, "xiaohongshu");
    installParagraphEditor(app, (editor) => { editor.innerHTML = html; });
    assert.equal((await app.adapter.fill("xiaohongshu", { ...draft, body })).status, "filled");
    assert.equal(app.adapter.save("xiaohongshu").status, "needs_confirmation");
  }
});

test("saving still rejects edited ProseMirror text, removed empty paragraphs, and removed genuine line breaks", async (t) => {
  const body = "第一段\n同段软换行\n\n末段";
  for (const change of ["text", "empty-paragraph", "hard-break"]) {
    const app = fixture(t, "xiaohongshu");
    const editor = installParagraphEditor(app, (element) => {
      element.innerHTML = '<p>第一段<br>同段软换行</p><p><br class="ProseMirror-trailingBreak"></p><p>末段</p>';
    });
    assert.equal((await app.adapter.fill("xiaohongshu", { ...draft, body })).status, "filled");
    if (change === "text") editor.lastElementChild.textContent = "用户修改后的末段";
    if (change === "empty-paragraph") editor.children[1].remove();
    if (change === "hard-break") editor.querySelector("br").remove();
    let saved = 0;
    app.document.querySelector("[data-draft-save]").addEventListener("click", () => saved++);
    assert.throws(() => app.adapter.save("xiaohongshu"), /当前内容发生变化/);
    assert.equal(saved, 0);
  }
});

test("unsupported ProseMirror structure falls back without silently omitting unexpected text", async (t) => {
  const app = fixture(t, "xiaohongshu");
  installParagraphEditor(app, (editor) => {
    const paragraph = app.document.createElement("p"); paragraph.textContent = draft.body;
    const unknown = app.document.createElement("div"); unknown.textContent = "编辑器额外出现的正文";
    editor.append(paragraph, unknown);
  });
  await assert.rejects(app.adapter.fill("xiaohongshu", draft), /文案未能核对一致/);
  assert.throws(() => app.adapter.save("xiaohongshu"), /先完成本页内容导入/);
});

test("a platform error with a final full stop is reported without repeated punctuation", async (t) => {
  const app = fixture(t, "xiaohongshu");
  app.document.execCommand = () => { throw new Error("平台拒绝填写。"); };
  await assert.rejects(app.adapter.fill("xiaohongshu", draft), (error) => {
    assert.match(error.message, /已确认 2\/2 张图片。平台拒绝填写。请核对平台内容/);
    assert.equal(error.message.includes("。。"), false);
    return true;
  });
});

test("XHS waits through visible blob prerender and upload states before each next image or any copy", async (t) => {
  const app = fixture(t, "xiaohongshu"), polls = [];
  const originalSetTimeout = app.window.setTimeout.bind(app.window);
  t.mock.method(app.window, "setTimeout", (callback, delay, ...args) => {
    if (delay === 200) { polls.push(callback); return polls.length; }
    return originalSetTimeout(callback, delay, ...args);
  });
  const advance = async () => {
    assert.equal(polls.length, 1, "one upload observation is waiting");
    polls.shift()(); await new Promise((resolve) => setImmediate(resolve));
  };
  app.input.addEventListener("change", () => {
    const preview = app.document.querySelector(".img-preview-area").lastElementChild;
    preview.querySelector("img").src = `blob:local-preview-${app.uploaded.length}`;
    preview.querySelector(".image-editor-control").remove();
    const mask = app.document.createElement("div");
    mask.className = "mask hover-mask prerender";
    mask.innerHTML = '<div class="processing-container"></div>';
    preview.append(mask);
  });
  let filled = false;
  const pending = app.adapter.fill("xiaohongshu", draft).then((result) => { filled = true; return result; });
  const first = app.document.querySelector(".img-preview-area").firstElementChild;
  assert.equal(first.querySelector("img").complete, true);
  assert.ok(first.querySelector("img").naturalWidth > 0);
  assert.equal(app.uploaded.length, 1);
  await advance();
  assert.equal(app.uploaded.length, 1, "a decoded blob is still only the first local preview");
  const firstMask = first.querySelector(".mask");
  firstMask.className = "mask uploading";
  firstMask.innerHTML = '<div class="progress-container"></div>';
  await advance();
  assert.equal(app.uploaded.length, 1, "the next file must wait for native upload processing");
  firstMask.remove();
  await advance();
  assert.equal(app.uploaded.length, 1, "a transient gap between masks cannot finish the image before its edit control mounts");
  appendEditControl(first);
  await advance();
  assert.equal(app.uploaded.length, 2);
  assert.equal(app.document.querySelector("#title").value, "");
  assert.equal(app.document.querySelector(".ProseMirror").textContent, "");
  assert.equal(filled, false);
  const second = app.document.querySelector(".img-preview-area").lastElementChild;
  second.querySelector(".mask").remove(); appendEditControl(second);
  await advance();
  assert.equal((await pending).status, "filled");
  assert.deepEqual(app.uploaded.map((file) => file.name), ["1.png", "2.png"]);
  assert.equal(app.document.querySelector("#title").value, draft.title);
  assert.equal(app.document.querySelector(".ProseMirror").textContent, draft.body);
});

test("XHS stops immediately on a failed second image, retains the first, and supports a new group after explicit reset", async (t) => {
  const app = fixture(t, "xiaohongshu");
  const originalSetTimeout = app.window.setTimeout.bind(app.window);
  let polls = 0;
  t.mock.method(app.window, "setTimeout", (callback, delay, ...args) => {
    if (delay === 200) polls++;
    return originalSetTimeout(callback, delay, ...args);
  });
  let first;
  app.input.addEventListener("change", () => {
    const preview = app.document.querySelector(".img-preview-area").lastElementChild;
    if (app.uploaded.length === 1) first = preview;
    if (app.uploaded.length !== 2) return;
    preview.querySelector("img").remove();
    preview.querySelector(".image-editor-control").remove();
    const mask = app.document.createElement("div");
    mask.className = "mask failed"; mask.textContent = "上传失败"; preview.append(mask);
  });
  const threeImages = { ...draft, images: [...draft.images, { ...draft.images[0], name: "3.png" }] };
  await assert.rejects(app.adapter.fill("xiaohongshu", threeImages), /已确认 1\/3 张图片。平台报告第 2 张图片上传失败/);
  assert.equal(polls, 0, "an explicit native failure does not wait for the timeout or retry");
  assert.equal(app.uploaded.length, 2, "the third image is never dispatched");
  assert.equal(app.document.querySelector(".img-preview-area").firstElementChild, first);
  assert.ok(first.querySelector("img"));
  assert.equal(app.document.querySelector("#title").value, "");
  assert.equal(app.document.querySelector(".ProseMirror").textContent, "");
  assert.match(app.adapter.inspect("xiaohongshu").message, /第 2 张图片上传失败/);
  assert.throws(() => app.adapter.save("xiaohongshu"), /先完成本页内容导入/);
  assert.equal(app.adapter.reset().reset, true);
  await assert.rejects(app.adapter.fill("xiaohongshu", draft), /新建空白/);
  app.document.querySelector(".img-preview-area").replaceChildren(); app.input.files = [];
  assert.equal((await app.adapter.fill("xiaohongshu", { ...draft, title: "核对后新建的第二组" })).status, "filled");
  assert.equal(app.uploaded.length, 4);
  assert.equal(app.adapter.save("xiaohongshu").status, "needs_confirmation");
});
