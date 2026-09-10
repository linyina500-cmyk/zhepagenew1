/** Serialized into the userscript; keep dependencies inside this function. */
export function installBrowserSync({ window, document, GM }, createPlatformAdapter) {
  const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
  const CHANNEL = "zhepage-browser-sync-v1";
  const TTL = 30 * 60 * 1000;
  const IMAGE_LIMIT = 10_000_000;
  const TOTAL_IMAGE_LIMIT = 60 * 1024 * 1024;
  const IMAGE_COUNTS = { xiaohongshu: 18, wechat: 20 };
  const platforms = ["xiaohongshu", "wechat"];
  // Tampermonkey wraps window; MessageEvent.source uses the document's window.
  const sourceWindow = document.defaultView;
  if (!sourceWindow || window.top !== window.self) return;
  const key = (platform) => `${CHANNEL}:${platform}`;
  const imageKey = (platform, id, index) => `${key(platform)}:${id}:image:${index}`;
  const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  const isSource = () => window.location.origin === ORIGIN && ["/", "/browser-sync-check"].includes(window.location.pathname);
  const reply = (id, payload) => window.postMessage({ channel: CHANNEL, kind: "response", id, ...payload }, ORIGIN);
  const statusOf = (job) => job ? { id: job.id, status: job.status, message: job.message, title: job.draft.title, imageCount: job.draft.images.length } : null;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  async function writeValue(name, value) {
    await GM.setValue(name, value);
    if (!same(await GM.getValue(name, null), value)) throw new Error("浏览器存储读回不一致，操作未确认。请先检查平台页面，不要重复准备、导入或保存");
  }
  const write = (job) => writeValue(key(job.platform), job);
  async function deleteKeys(names) {
    for (const name of names) {
      await GM.deleteValue(name);
      if (await GM.getValue(name, null) !== null) throw new Error("浏览器中的临时内容尚未清除，请核对扩展存储后再结束本次传图");
    }
  }
  function ownedImageKeys(job, platform) {
    if (job?.schemaVersion !== 2 || !validId(job.id) || !Array.isArray(job.draft?.images) || job.draft.images.length > IMAGE_COUNTS[platform]) return [];
    // Derive our own keys; a damaged manifest cannot name another platform's data.
    return job.draft.images.map((_, index) => imageKey(platform, job.id, index));
  }
  async function clearJob(platform, job) {
    await deleteKeys(ownedImageKeys(job, platform));
    if (!same(await GM.getValue(key(platform), null), job)) throw new Error("待传任务已经变化，新的内容未被清除；请重新检查");
    await deleteKeys([key(platform)]);
  }
  function validateContent(title, body) {
    if (typeof title !== "string" || !title.trim() || [...title].length > 20 || typeof body !== "string" || [...body].length > 1000) throw new Error("标题需要 1–20 字，文案最多 1000 字");
    const topicCount = (body.match(/(?:^|\s)(?:#[^\s#]+#?)+/gu) ?? []).reduce((sum, group) => sum + (group.match(/#[^\s#]+#?/gu)?.length ?? 0), 0);
    if (topicCount > 10) throw new Error("文案最多 10 个话题");
  }
  function validateImage(image) {
    if (!image || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200 || !["image/png", "image/jpeg"].includes(image.mime) || typeof image.dataUrl !== "string" || image.dataUrl.length > Math.ceil(IMAGE_LIMIT / 3) * 4 + 32) throw new Error("单张图片最多 10 MB，仅支持 PNG 或 JPEG");
    const prefix = `data:${image.mime};base64,`;
    if (!image.dataUrl.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl.slice(prefix.length))) throw new Error("图片编码无效，请重新检查原图");
    const encoded = image.dataUrl.slice(prefix.length);
    const decoded = window.atob(encoded);
    if (window.btoa(decoded) !== encoded) throw new Error("图片编码无效，请重新检查原图");
    const bytes = decoded.length;
    if (!bytes || bytes > IMAGE_LIMIT) throw new Error("单张图片需要大于 0 且不超过 10 MB");
    return { image: { name: image.name, mime: image.mime, dataUrl: image.dataUrl }, bytes };
  }
  function validate(value) {
    if (!value || !platforms.includes(value.platform) || !validId(value.id)) throw new Error("待传内容格式无效");
    const { title, body, images } = value.draft || {};
    validateContent(title, body);
    if (!Array.isArray(images) || images.length < 1 || images.length > IMAGE_COUNTS[value.platform]) throw new Error(`${value.platform === "wechat" ? "公众号贴图" : "小红书"}本次需要 1–${IMAGE_COUNTS[value.platform]} 张图片`);
    let total = 0;
    const clean = images.map((image, index) => {
      const result = validateImage(image);
      if ((total += result.bytes) > TOTAL_IMAGE_LIMIT) throw new Error("本次图片总大小最多 60 MiB，请减少图片或压缩后再准备");
      return { ...result, key: imageKey(value.platform, value.id, index) };
    });
    return { images: clean, manifest: { schemaVersion: 2, id: value.id, platform: value.platform, createdAt: Date.now(), status: "ready", message: "完整内容已留在浏览器扩展中，尚未上传", draft: {
      title, body, images: clean.map(({ image, bytes, key }) => ({ key, name: image.name, mime: image.mime, bytes })),
    } } };
  }
  async function read(platform) {
    const job = await GM.getValue(key(platform), null);
    if (!job) return null;
    if (job.schemaVersion !== 2) throw new Error("浏览器中仍有旧版验证记录，请先在平台面板点击“结束本次传图”，再准备完整内容");
    if (job.platform !== platform || !validId(job.id) || !Number.isFinite(job.createdAt) || job.createdAt > Date.now() || !["ready", "filling", "filled", "needs_confirmation"].includes(job.status) || typeof job.message !== "string") throw new Error("待传内容记录无效，请先核对平台页面并结束本次传图");
    validateContent(job.draft?.title, job.draft?.body);
    const images = job.draft?.images;
    let total = 0;
    if (!Array.isArray(images) || !images.length || images.length > IMAGE_COUNTS[platform] || images.some((image, index) => (
      !image || image.key !== imageKey(platform, job.id, index) || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200
      || !["image/png", "image/jpeg"].includes(image.mime) || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > IMAGE_LIMIT
      || (total += image.bytes) > TOTAL_IMAGE_LIMIT || "dataUrl" in image
    ))) throw new Error("待传图片清单无效，请先核对平台页面并结束本次传图");
    // An interrupted upload/save remains protected until the user ends it.
    if (job.status === "ready" && Date.now() - job.createdAt > TTL) {
      await clearJob(platform, job);
      return null;
    }
    return job;
  }
  async function readImages(job, collect = true) {
    const images = [];
    for (const reference of job.draft.images) {
      const stored = await GM.getValue(reference.key, null);
      if (!stored) throw new Error("待传图片缺失，完整内容未能确认；请先核对平台页面并结束本次传图，不要重复导入");
      const { image, bytes } = validateImage(stored);
      if (image.name !== reference.name || image.mime !== reference.mime || bytes !== reference.bytes) throw new Error("待传图片与清单不一致，请先核对平台页面并结束本次传图");
      if (collect) images.push(image);
    }
    return images;
  }
  async function prepare(value) {
    const { manifest, images } = validate(value);
    const staged = [];
    try {
      for (const { image, key: name } of images) {
        if (await GM.getValue(name, null) !== null) throw new Error("这组内容仍有临时图片，请先核对扩展存储，不要覆盖或重复准备");
        staged.push(name);
        await writeValue(name, image);
      }
      // Another source page can prepare a task while these images are stored.
      // Never replace a task that appeared during this preparation.
      if (await GM.getValue(key(value.platform), null) !== null) throw new Error("待传内容的状态已变化，请先核对平台页面，不要重复准备");
    } catch (error) {
      try { await deleteKeys(staged); }
      catch { throw new Error(`${error instanceof Error ? error.message : "图片写入未完成"}。本次临时图片尚未完全清除，请核对扩展存储`); }
      throw error;
    }
    // If the manifest write has an uncertain outcome, keep its images.
    // A later status check can verify the committed task without re-sending it.
    await write(manifest);
    return manifest;
  }

  if (isSource()) {
    let saving = false;
    window.addEventListener("message", async (event) => {
      const message = event.data;
      if (!isSource() || event.source !== sourceWindow || event.origin !== ORIGIN || message?.channel !== CHANNEL || message.kind !== "request" || typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return;
      try {
        if (message.action === "ping") return reply(message.id, { ok: true, version: "0.2.1" });
        if (!platforms.includes(message.platform)) throw new Error("未知平台");
        if (message.action === "status") {
          if (saving) throw new Error("上一组图片仍在写入和核对，请稍候再读取传图状态，不要重复准备");
          const job = await read(message.platform);
          if (job) await readImages(job, false);
          return reply(message.id, { ok: true, job: statusOf(job) });
        }
        if (message.action !== "prepare") throw new Error("未知操作");
        if (saving) throw new Error("正在准备上一组图片，请稍后重试");
        saving = true;
        try {
          const current = await read(message.platform);
          if (current) throw new Error("浏览器里仍有上一组内容。请先在平台核对，并在传图面板点击“结束本次传图”后再准备下一组");
          const job = await prepare(message);
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
  section.setAttribute("aria-label", "折页浏览器传图");
  const title = document.createElement("h2"); title.textContent = "折页 · 浏览器传图";
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
    for (const image of await readImages(current)) {
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
    const images = await readImages(job);
    if (!same(await GM.getValue(key(platform), null), job)) throw new Error("待传内容状态已经变化，请重新检查，不要重复导入");
    job.status = "filling"; job.message = "正在填入平台编辑器，请保持此页打开";
    await write(job);
    message.textContent = job.message;
    try {
      await adapter.fill(platform, { title: job.draft.title, body: job.draft.body, images });
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
    if (!current || job?.id !== current.id || job.status !== "filled") throw new Error("请先完成导入并核对页面；如已手动保存，请结束本次传图");
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
  button("结束本次传图", async () => {
    const job = await GM.getValue(key(platform), null);
    if (job?.platform === platform && job.status === "filling" && Number.isFinite(job.createdAt) && job.createdAt <= Date.now() && Date.now() - job.createdAt <= TTL) throw new Error("图片仍在上传，请等待完成；若操作中断，请先核对平台页面，30 分钟后可结束本次传图");
    await clearJob(platform, job);
    adapter.reset?.(platform);
    await refresh();
    message.textContent = "浏览器扩展中的这组临时图片已清除。平台草稿是否保存，请以平台显示为准。请新建空白编辑器后再传下一组。";
  });
}
