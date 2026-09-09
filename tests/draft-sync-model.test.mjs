import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { normalizeLocalDraft } = loadDomModule("lib/draftSync/localDraftStore.ts");
const { validateDraft, readDraftImage } = loadDomModule("lib/draftSync/validation.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const metadata = { id: "image-1", name: "poster.png", width: 1080, height: 1440, size: png.length, mime: "image/png" };
const makeDraft = () => ({
  schemaVersion: 1, id: "draft-1", sourceFormat: "xiaohongshu", updatedAt: "2026-09-09T12:00:00.000Z",
  images: [{ id: "image-1", name: "poster.png", width: 1080, height: 1440, blob: new Blob([png], { type: "image/png" }) }],
  content: { xiaohongshu: { title: "小红书标题", body: "第一行\n第二行" }, wechat: { title: "公众号标题", body: "独立文案" } },
  selectedAccountIds: ["account-1"], receipts: [],
});

test("local archive preserves original image bytes, order, separate copy and user-confirmed receipts", async () => {
  const source = makeDraft();
  source.images.push({ ...source.images[0], id: "image-2", name: "second.png" });
  source.receipts.push({ accountId: "account-1", platform: "xiaohongshu", status: "confirmed_by_user", message: "用户已在平台核对" });
  const restored = normalizeLocalDraft(source);
  assert.deepEqual(restored, source);
  assert.notEqual(restored.images, source.images);
  assert.notEqual(restored.content, source.content);
  assert.deepEqual(Buffer.from(await restored.images[0].blob.arrayBuffer()), png);
  assert.equal(restored.receipts[0].status, "confirmed_by_user");
});

test("archive writes only draft fields and strips platform URL query credentials", () => {
  const source = makeDraft();
  source.token = "must-not-persist";
  source.appSecret = "must-not-persist";
  source.images[0].cookie = "must-not-persist";
  source.content.wechat.connection = { token: "must-not-persist" };
  source.receipts.push({ accountId: "account-1", platform: "wechat", status: "saved", draftId: "verified-draft", message: "已核对", url: "https://mp.weixin.qq.com/cgi-bin/home?token=must-not-persist#secret", appSecret: "must-not-persist" });
  const archive = normalizeLocalDraft(source);
  assert.equal(JSON.stringify(archive).includes("must-not-persist"), false);
  assert.equal(archive.receipts[0].url, "https://mp.weixin.qq.com/cgi-bin/home");
  assert.equal(source.token, "must-not-persist");
});

test("unfinished copy and image counts can be archived before platform validation is resolved", () => {
  const source = makeDraft();
  source.content.xiaohongshu.title = "尚待缩短的标题".repeat(20);
  source.images = Array.from({ length: 21 }, (_, index) => ({ ...source.images[0], id: `image-${index}` }));
  assert.equal(normalizeLocalDraft(source).images.length, 21);
  assert.ok(validateDraft("xiaohongshu", source.content.xiaohongshu, source.images.map((image) => ({ ...metadata, id: image.id }))).some((issue) => issue.code === "image-count"));
});

test("corrupted archive metadata is rejected before it can crash the dialog or claim a verified save", () => {
  const changes = [
    (draft) => { draft.selectedAccountIds = null; },
    (draft) => { draft.selectedAccountIds = ["same", "same"]; },
    (draft) => { draft.receipts = {}; },
    (draft) => { draft.content.wechat.body = null; },
    (draft) => { draft.updatedAt = "invalid date"; },
    (draft) => { draft.images[0].blob = {}; },
    (draft) => { draft.images[0].width = Infinity; },
    (draft) => { draft.images.push({ ...draft.images[0] }); },
    (draft) => { draft.receipts = [{ accountId: "account-1", platform: "other", status: "saved", message: "bad" }]; },
    (draft) => { draft.receipts = [{ accountId: "account-1", platform: "wechat", status: "saved", message: "no evidence" }]; },
    (draft) => { draft.receipts = [{ accountId: "account-1", platform: "wechat", status: "failed", message: "bad link", url: "https://mp.weixin.qq.com.evil.example/" }]; },
  ];
  for (const change of changes) { const draft = makeDraft(); change(draft); assert.throws(() => normalizeLocalDraft(draft), /本机存档不完整/); }
});

test("platform validation counts Unicode characters and distinguishes size advice from blocking limits", () => {
  assert.equal(validateDraft("xiaohongshu", { title: "🌿".repeat(20), body: "" }, [metadata]).filter((issue) => issue.severity === "error").length, 0);
  assert.ok(validateDraft("xiaohongshu", { title: "🌿".repeat(21), body: "" }, [metadata]).some((issue) => issue.code === "title-long"));
  const wechat = validateDraft("wechat", { title: "标题", body: "中".repeat(683) }, [metadata]);
  assert.ok(wechat.some((issue) => issue.code === "body-bytes" && issue.severity === "error"));
  assert.ok(wechat.some((issue) => issue.code === "image-ratio" && issue.severity === "warning"));
  assert.equal(validateDraft("wechat", { title: "标题", body: "中".repeat(682) }, [{ ...metadata, height: 1350 }]).filter((issue) => issue.severity === "error").length, 0);
  const mixed = validateDraft("xiaohongshu", { title: "标题", body: "" }, [metadata, { ...metadata, id: "image-2", width: 640, height: 640 }]);
  assert.ok(mixed.some((issue) => issue.code === "mixed-ratios"));
  assert.ok(mixed.some((issue) => issue.code === "image-resolution"));
});

test("image reading preserves the file and always releases the temporary URL", async (context) => {
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  const instances = [];
  class ImageFixture {
    constructor() { instances.push(this); }
    naturalWidth = 1600;
    naturalHeight = 900;
    set src(value) { this.source = value; queueMicrotask(() => this.onload?.()); }
    removeAttribute() { this.removed = true; }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: ImageFixture });
  context.after(() => { if (previousImage) Object.defineProperty(globalThis, "Image", previousImage); else delete globalThis.Image; });
  const revoke = context.mock.method(URL, "revokeObjectURL");
  const file = new File([png], "my-image.png", { type: "image/png" });
  const result = await readDraftImage(file);
  assert.equal(result.blob, file);
  assert.deepEqual([result.width, result.height], [1600, 900]);
  assert.equal(revoke.mock.callCount(), 1);
  assert.equal(instances[0].removed, true);
  assert.equal(instances[0].onload, null);
  assert.equal(instances[0].onerror, null);
});

test("a stalled image decoder times out and releases its URL instead of leaving the dialog busy", async (context) => {
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
  class StalledImage { removeAttribute() {} }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: StalledImage });
  context.after(() => { if (previousImage) Object.defineProperty(globalThis, "Image", previousImage); else delete globalThis.Image; });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = context.mock.method(URL, "revokeObjectURL");
  const pending = readDraftImage(new File([png], "stalled.png", { type: "image/png" }));
  const checked = assert.rejects(pending, /图片读取超时/);
  context.mock.timers.tick(15001);
  await checked;
  assert.equal(revoke.mock.callCount(), 1);
});
