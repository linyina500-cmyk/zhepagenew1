import assert from "node:assert/strict";
import test from "node:test";
import { loadDomModule } from "./helpers/load-dom-module.mjs";

const { normalizeLocalDraft, encodeLocalDraft, decodeLocalDraft, saveLocalDraft } = loadDomModule("lib/draftSync/localDraftStore.ts");
const { validateDraft, readDraftImage } = loadDomModule("lib/draftSync/validation.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGMQPNj5HwAEnQJbj/CYfgAAAABJRU5ErkJggg==", "base64");
const jpeg = Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgAkgf/9k=", "base64");
const metadata = { id: "image-1", name: "poster.png", width: 1080, height: 1440, size: png.length, mime: "image/png" };
const makeDraft = () => ({
  schemaVersion: 1, id: "draft-1", sourceFormat: "xiaohongshu", updatedAt: "2026-09-09T12:00:00.000Z",
  images: [{ id: "image-1", name: "poster.png", width: 1080, height: 1440, blob: new Blob([png], { type: "image/png" }) }],
  content: { xiaohongshu: { title: "小红书标题", body: "第一行\n第二行" }, wechat: { title: "公众号标题", body: "独立文案" } },
  selectedAccountIds: ["account-1"], receipts: [],
});

test("local archive preserves original image bytes, order, separate copy and user-confirmed receipts", async () => {
  const source = makeDraft();
  source.images.push({ ...source.images[0], id: "image-2", name: "second.jpg", blob: new Blob([jpeg], { type: "image/jpeg" }) });
  source.receipts.push({ accountId: "account-1", platform: "xiaohongshu", status: "confirmed_by_user", message: "用户已在平台核对" });
  const stored = await encodeLocalDraft(source);
  assert.deepEqual(stored.images.map(({ id, name, mime }) => ({ id, name, mime })), [
    { id: "image-1", name: "poster.png", mime: "image/png" }, { id: "image-2", name: "second.jpg", mime: "image/jpeg" },
  ]);
  for (const image of stored.images) { assert.ok(image.bytes instanceof ArrayBuffer); assert.equal("blob" in image, false); }
  const restored = decodeLocalDraft(structuredClone(stored));
  assert.deepEqual(restored, source);
  assert.notEqual(restored.images, source.images);
  assert.notEqual(restored.content, source.content);
  assert.deepEqual(Buffer.from(await restored.images[0].blob.arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await restored.images[1].blob.arrayBuffer()), jpeg);
  assert.deepEqual(restored.images.map(({ blob }) => blob.type), ["image/png", "image/jpeg"]);
  assert.equal(restored.receipts[0].status, "confirmed_by_user");
});

test("archive writes only draft fields and omits temporary URLs and credentials", async () => {
  const source = makeDraft();
  source.token = "must-not-persist";
  source.appSecret = "must-not-persist";
  source.images[0].cookie = "must-not-persist";
  source.images[0].previewUrl = "blob:http://localhost/must-not-persist";
  source.content.wechat.connection = { token: "must-not-persist" };
  source.receipts.push({ accountId: "account-1", platform: "wechat", status: "saved", draftId: "verified-draft", message: "已核对", url: "https://mp.weixin.qq.com/cgi-bin/home?token=must-not-persist#secret", appSecret: "must-not-persist" });
  const archive = await encodeLocalDraft(source);
  assert.equal(JSON.stringify(archive).includes("must-not-persist"), false);
  assert.equal("url" in archive.receipts[0], false);
  assert.equal("previewUrl" in archive.images[0], false);
  assert.equal("blob" in archive.images[0], false);
  assert.equal(normalizeLocalDraft(source).receipts[0].url, "https://mp.weixin.qq.com/cgi-bin/home");
  assert.equal(source.token, "must-not-persist");
});

test("binary archives reject missing, empty or invalid bytes and still validate restored metadata", async () => {
  const archive = await encodeLocalDraft(makeDraft());
  const changes = [
    (draft) => { delete draft.images[0].bytes; },
    (draft) => { draft.images[0].bytes = "blob:http://localhost/old-image"; },
    (draft) => { draft.images[0].bytes = new Blob([png]); },
    (draft) => { draft.images[0].bytes = new Uint8Array(png); },
    (draft) => { draft.images[0].bytes = new ArrayBuffer(0); },
    (draft) => { draft.images[0].mime = "image/svg+xml"; },
    (draft) => { draft.images[0].mime = null; },
    (draft) => { draft.images[0].width = Infinity; },
    (draft) => { draft.images.push({ ...draft.images[0] }); },
    (draft) => { draft.receipts = [{ accountId: "account-1", platform: "wechat", status: "saved", message: "missing evidence" }]; },
  ];
  for (const change of changes) { const draft = structuredClone(archive); change(draft); assert.throws(() => decodeLocalDraft(draft), /本机存档不完整/); }
  assert.throws(() => decodeLocalDraft(makeDraft()), /本机存档不完整/);
});

test("image read failure rejects saving before IndexedDB can open or replace an existing archive", async (context) => {
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let opens = 0;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() { opens++; throw new Error("unexpected database access"); } } });
  context.after(() => { if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB); else delete globalThis.indexedDB; });
  const source = makeDraft();
  let failRead;
  context.mock.method(source.images[0].blob, "arrayBuffer", () => new Promise((_resolve, reject) => { failRead = reject; }));
  const pending = saveLocalDraft(source);
  const checked = assert.rejects(pending, /simulated byte read failure/);
  await Promise.resolve();
  assert.equal(opens, 0);
  failRead(new Error("simulated byte read failure"));
  await checked;
  assert.equal(opens, 0);
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
