/** Serialized into the userscript; keep dependencies inside this function. */
export function installBrowserSync({ window, document, GM }, createPlatformAdapter) {
  const ORIGIN = "https://feature-local-draft-sync.zhepagenew.pages.dev";
  const CHANNEL = "zhepage-browser-sync-v1";
  const TTL = 30 * 60 * 1000;
  const IMAGE_LIMIT = 1024 * 1024;
  const platforms = ["xiaohongshu", "wechat"];
  if (window.top !== window.self) return;
  const key = (platform) => `${CHANNEL}:${platform}`;
  const isSource = () => window.location.origin === ORIGIN && window.location.pathname === "/browser-sync-check";
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
}
