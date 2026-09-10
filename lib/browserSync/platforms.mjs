// Adapted editor selectors from baoyu-skills (MIT) and OpenCLI (Apache-2.0).
// Modified 2026-09-10 for in-page, in-memory uploads. See THIRD_PARTY_NOTICES.md.
export function createPlatformAdapter({ window, document }) {
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
}
