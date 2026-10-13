import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { installDom, loadDomModule } from "./helpers/load-dom-module.mjs";
const { WechatSubmissionRejectedError } = loadDomModule("lib/wechat/client.ts");

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const ids = ["a".repeat(20), "b".repeat(20)];
const accounts = ids.map((id, index) => ({ id, appId: `wx-test-${index}`, name: `测试公众号${index + 1}` }));
const fingerprint = (draft) => createHash("sha256").update(JSON.stringify([draft.content.wechat, draft.images.map((image) => image.id)])).digest("hex");

async function fixture(context, options = {}) {
  const dom = installDom(); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const filename = fileURLToPath(new URL("../app/components/WechatDraftPanel.tsx", import.meta.url));
  const nativeRequire = createRequire(filename), React = nativeRequire("react"), { createRoot } = nativeRequire("react-dom/client"), { act } = React;
  const binding = { deviceId: "local-test-device", connectionToken: "test-token" };
  let saved = { schemaVersion: 1, id: "local-draft", updatedAt: new Date().toISOString(), sourceFormat: "wechat", images: [1, 2].map((id) => ({ id: String(id), name: `${id}.png`, blob: new Blob([`original-${id}`], { type: "image/png" }), width: 1080, height: 1440 })), content: { wechat: { title: "测试标题", body: "测试配文" }, xiaohongshu: { title: "", body: "" } }, selectedAccountIds: [], receipts: options.receipts ?? [] };
  let busy = false, active, renderDraft, renderReady, mounted = true, persistFailure = false, createOverride, publicationOverride, connectionOverride, verifyOverride, resolveOverride, readOverride, failAccount;
  const creates = [], publications = [], publicationReads = [], connects = [], verifies = [], resolutions = [], jobs = new Map(), published = new Map(options.previousPublications ?? []);
  const client = {
    getConnection: async () => connectionOverride ? connectionOverride() : ({ deviceId: binding.deviceId }),
    connectAccount: async (input) => { connects.push(input); const account = accounts.find((item) => item.appId === input.appId); if (account.id === failAccount) throw new Error("此账号连接失败"); return account; },
    getJob: async (id) => { if (readOverride) return readOverride(id); const job = jobs.get(id); if (!job) throw new Error("任务不存在，请核对后台"); return job; },
    async createJob(input, signal) {
      const receipt = saved.receipts.find((item) => item.accountId === input.accountId);
      assert.equal(receipt.jobId, input.id, "pending task must persist before upload");
      assert.equal(receipt.contentHash, fingerprint(saved));
      assert.equal(saved.images.length, input.images.length);
      creates.push(input);
      if (createOverride) return createOverride(input, signal);
      const job = { id: input.id, accountId: input.accountId, accountName: accounts.find((item) => item.id === input.accountId).name, title: input.content.title, imageCount: 2, uploadedCount: 2, status: "saved", draftId: `draft-${input.accountId}`, message: "草稿已保存", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(job.id, job); return job;
    },
    waitForJob: async (job) => job,
    verifyJob: async (id) => { verifies.push(id); return verifyOverride ? verifyOverride(id) : jobs.get(id); },
    resolveJob: async (id, accountId, signal) => { resolutions.push({ id, accountId }); return resolveOverride ? resolveOverride(id, accountId, signal) : { jobId: id, accountId, confirmedNoDraft: true }; },
    getPublication: async (id) => {
      publicationReads.push(id);
      assert.equal(options.publicationEnabled, true, "draft-only extension does not expose publication endpoints");
      return published.get(id) || null;
    },
    refreshPublication: async (id) => published.get(id),
    submitPublication: async (id, accountId) => {
      assert.equal(saved.receipts.find((receipt) => receipt.accountId === accountId && receipt.jobId === id).publicationAttempted, true, "publication intent must persist before submission");
      publications.push({ id, accountId }); if (publicationOverride) return publicationOverride(id, accountId);
      const publication = { jobId: id, status: "published", articleId: "article", urls: [], message: "已发表", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; published.set(id, publication); return publication;
    },
    waitForPublication: async (publication) => publication,
  };
  function loadComponent(path) {
    const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const loaded = { exports: {} };
    new Function("require", "module", "exports", output)((specifier) => {
      if (specifier === "../../lib/wechat/client") return { createWechatClient: () => client, WechatSubmissionRejectedError };
      if (specifier === "../../lib/wechat/contentIdentity") return { wechatContentHash: async (draft) => fingerprint(draft) };
      if (specifier === "../../lib/wechat/features") return options.publicationEnabled === undefined
        ? loadDomModule("lib/wechat/features.ts") : { WECHAT_PUBLICATION_ENABLED: options.publicationEnabled };
      if (specifier === "../../lib/wechat/deviceVault") return { readAccountSecret: async (id) => ({ ...accounts.find((account) => account.id === id), appSecret: "private-browser-only" }) };
      if (specifier === "./WechatAccountManager") return { __esModule: true, default: () => null };
      return nativeRequire(specifier);
    }, loaded, loaded.exports);
    return loaded.exports.default;
  }
  const Panel = loadComponent(filename), container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Host() {
    const [draft, setDraft] = React.useState(saved), [ready, setReady] = React.useState(options.contentReady ?? true), [working, setWorking] = React.useState(false), [error, setError] = React.useState(""); renderDraft = setDraft; renderReady = setReady;
    return React.createElement(React.Fragment, null, React.createElement(Panel, { draft, binding, accounts: options.accounts ?? accounts, onAccountsChange() {}, view: "browser", contentReady: ready, contentCheck: options.contentCheck ? React.createElement("section", { "aria-label": "同步前检查" }, options.contentCheck) : undefined, contentChanged: false, busy: working || options.busy, onSubmitted() {},
      runOperation: async (_label, operation) => { if (busy) return; busy = true; active = new AbortController(); setWorking(true); try { await operation(active.signal); } catch (error) { if (!active.signal.aborted && mounted) setError(error.message); } finally { busy = false; if (mounted) setWorking(false); } },
      persistReceipt: async (snapshot, receipt, signal) => { signal.throwIfAborted(); if (persistFailure) throw new Error("存档空间不足"); saved = { ...snapshot, receipts: [...snapshot.receipts.filter((item) => !(item.platform === receipt.platform && item.accountId === receipt.accountId)), receipt] }; if (mounted) setDraft(saved); return saved; },
    }), React.createElement("p", { role: "alert" }, error));
  }
  await act(async () => { root.render(React.createElement(Host)); });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  async function click(text) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
    assert.ok(button, `action: ${text}`); assert.equal(button.disabled, false, `enabled: ${text}`);
    const disclosure = button.closest("details");
    assert.ok(!disclosure || disclosure.open, `visible action: ${text}`);
    await act(async () => { button.click(); }); await settle();
  }
  async function select(index = null) {
    const inputs = container.querySelectorAll('input[type="checkbox"]');
    await act(async () => { inputs[index === null ? 0 : index + 1].click(); });
  }
  async function openMore() {
    const summary = container.querySelector(".draft-sync-more-actions > summary");
    assert.ok(summary, "more actions disclosure");
    await act(async () => { summary.click(); });
  }
  async function confirmNoDraft(checked = true) {
    const label = [...container.querySelectorAll("label")].find(node => node.textContent === "我已在该公众号后台草稿箱确认没有这份内容");
    assert.ok(label, "explicit absence confirmation");
    const checkbox = label.querySelector("input");
    assert.equal(checkbox.disabled, false);
    if (checkbox.checked !== checked) await act(async () => { checkbox.click(); });
  }
  context.after(async () => { active?.abort(); mounted = false; await act(async () => root.unmount()); dom.window.close(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });
  return { container, creates, publications, publicationReads, connects, verifies, resolutions, jobs, published, click, select, openMore, confirmNoDraft, settle, act, get saved() { return saved; },
    set persistFailure(value) { persistFailure = value; }, set createOverride(value) { createOverride = value; }, set publicationOverride(value) { publicationOverride = value; }, set failAccount(value) { failAccount = value; },
    set connectionOverride(value) { connectionOverride = value; }, set verifyOverride(value) { verifyOverride = value; },
    set resolveOverride(value) { resolveOverride = value; }, set readOverride(value) { readOverride = value; },
    close: async () => { active?.abort(); mounted = false; await act(async () => root.render(null)); },
    changeContent: async () => { saved = { ...saved, content: { ...saved.content, wechat: { title: "新标题", body: "新内容" } } }; await act(async () => renderDraft(saved)); },
    changeImages: async () => { saved = { ...saved, images: [...saved.images, { ...saved.images[0], id: "risk-wechat", name: "新风险提示.png" }] }; await act(async () => renderDraft(saved)); },
    changeOtherPlatform: async () => { saved = { ...saved, content: { ...saved.content, xiaohongshu: { title: "小红书新标题", body: "小红书新内容" } } }; await act(async () => renderDraft(saved)); },
    replaceDraft: async (changes = {}) => { saved = { ...saved, id: "replacement-draft", receipts: [], ...changes }; await act(async () => renderDraft(saved)); },
    setReady: async (value) => { await act(async () => renderReady(value)); },
  };
}

test("batch drafts persist each account before POST and one account failure leaves others runnable", async (context) => {
  const f = await fixture(context); f.failAccount = ids[0]; await f.select(); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.equal(f.creates[0].accountId, ids[1]);
  assert.equal(f.saved.receipts[0].accountId, ids[1]); assert.equal(f.publications.length, 0);
  assert.match(f.container.textContent, /此账号连接失败/);
  f.failAccount = undefined; await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 2, "the already saved second account must be reused");
  assert.equal(f.saved.receipts.length, 2);
  assert.equal(JSON.stringify(f.saved).includes("private-browser-only"), false);
});

test("default release offers draft sync only and selects a sole visible account without extra clicks", async (context) => {
  assert.equal(loadDomModule("lib/wechat/features.ts").WECHAT_PUBLICATION_ENABLED, false);
  const f = await fixture(context, { accounts: [accounts[0]] });
  const target = f.container.querySelector('[aria-label="测试公众号1 的结果"]');
  assert.match(target.textContent, /测试公众号1.*wx-test-0/s);
  assert.equal(target.querySelector('input[type="checkbox"]').checked, true);
  assert.equal(f.container.querySelectorAll('input[type="checkbox"]').length, 1);
  const buttons = [...f.container.querySelectorAll("button")];
  assert.equal(buttons.some((button) => /立即发布/u.test(button.textContent)), false);
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  const sync = buttons.find((button) => button.textContent === "同步到草稿箱");
  assert.equal(sync.disabled, false); assert.equal(sync.classList.contains("primary"), true);
  await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.equal(f.publications.length, 0);
  assert.equal(f.saved.receipts[0].publicationAttempted, undefined);
  assert.match(target.textContent, /已同步到草稿箱/);
  const ordinaryActions = [...target.querySelectorAll("button")].filter((button) => !button.closest("details"));
  assert.deepEqual(ordinaryActions.map((button) => button.textContent), ["刷新状态"]);
  const more = target.querySelector("details");
  assert.equal(more.open, false); assert.match(more.textContent, /更多操作.*重新核对草稿.*图片显示正常/s);
  const guidance = f.container.querySelector('[aria-label="公众号操作"]');
  assert.match(guidance.textContent, /编辑封面 → 确认 → 保存/);
  assert.equal(f.container.querySelectorAll('a[href="https://mp.weixin.qq.com/"]').length, 1);
  await f.click("刷新状态");
  assert.equal(f.publications.length, 0); assert.equal(f.creates.length, 1);
  await f.openMore(); await f.click("重新核对草稿");
  await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1, "unchanged content reuses the saved draft");
  await f.changeContent(); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 2, "changed content can create its new draft without publication APIs");
  assert.deepEqual(f.publicationReads, []);
});

test("changing draft identity preserves chosen accounts but clears earlier account results", async (context) => {
  const f = await fixture(context); await f.select();
  f.failAccount = ids[0]; await f.click("同步到草稿箱");
  assert.match(f.container.textContent, /此账号连接失败/);
  assert.match(f.container.textContent, /已同步到草稿箱/);
  await f.replaceDraft();
  assert.equal([...f.container.querySelectorAll('input[type="checkbox"]')].every((input) => input.checked), true);
  assert.doesNotMatch(f.container.textContent, /此账号连接失败|已同步到草稿箱|更多操作/);
  assert.equal(f.saved.receipts.length, 0);
  f.failAccount = undefined; await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 3, "both selected accounts remain ready for the new draft");
  assert.equal(f.saved.receipts.length, 2); assert.equal(f.publications.length, 0);
});

test("changing draft identity also dismisses publication approval without clearing selection", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("立即发布");
  assert.ok(f.container.querySelector('[aria-label="确认立即发布"]'));
  await f.replaceDraft();
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  assert.equal(f.container.querySelector('[aria-label="测试公众号1 的结果"] input').checked, true);
  assert.equal(f.container.querySelector('[aria-label="测试公众号2 的结果"] input').checked, false);
  assert.equal(f.creates.length, 0); assert.equal(f.publications.length, 0);
});

test("a mismatched draft exposes recheck directly while retaining the same job without another upload", async (context) => {
  const f = await fixture(context, { accounts: [accounts[0]] });
  await f.click("同步到草稿箱");
  const id = f.creates[0].id;
  f.verifyOverride = () => ({ ...f.jobs.get(id), status: "needs_confirmation", message: "后台配文已变化，请核对。" });
  await f.openMore(); await f.click("重新核对草稿");
  const row = f.container.querySelector('[aria-label="测试公众号1 的结果"]');
  const recheck = [...row.querySelectorAll("button")].find((button) => button.textContent === "重新核对草稿");
  assert.equal(recheck.closest("details"), null);
  assert.match(row.textContent, /后台配文已变化/);
  f.verifyOverride = undefined; await f.click("重新核对草稿");
  assert.equal(f.saved.receipts[0].status, "saved");
  assert.equal(f.creates.length, 1); assert.equal(f.publications.length, 0);
  assert.deepEqual(f.verifies, [id, id]);
});

test("draft-only release retains historical publication intent without querying unsupported APIs or resubmitting", async (context) => {
  const id = "old-published-job";
  const f = await fixture(context, {
    accounts: [accounts[0]],
    receipts: [{ platform: "wechat", accountId: ids[0], jobId: id, draftId: "old-draft", status: "saved", publicationAttempted: true, message: "旧发布记录" }],
    previousPublications: [[id, { jobId: id, status: "published", articleId: "old-article", urls: ["https://mp.weixin.qq.com/s/old-test"], message: "已发表" }]],
  });
  await f.click("刷新状态");
  assert.match(f.container.textContent, /这份内容曾提交发表，请到公众号后台核对/);
  await f.click("同步到草稿箱");
  await f.changeContent(); await f.click("同步到草稿箱");
  assert.equal(f.saved.receipts[0].publicationAttempted, true);
  assert.equal(f.saved.receipts[0].jobId, id);
  assert.deepEqual(f.publicationReads, []); assert.deepEqual(f.connects, []);
  assert.equal(f.publications.length, 0); assert.equal(f.creates.length, 0);
  assert.equal([...f.container.querySelectorAll("button")].some((button) => /立即发布/u.test(button.textContent)), false);
});

test("publication requires a separate explicit confirmation and reuses matching saved drafts", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 2); await f.click("立即发布");
  assert.equal(f.publications.length, 0); assert.match(f.container.querySelector('[aria-label="确认立即发布"]').textContent, /测试公众号1.*测试公众号2/s);
  await f.click("取消"); assert.equal(f.publications.length, 0);
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.publications.length, 2); assert.equal(f.creates.length, 2);
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.publications.length, 2, "existing publications cannot be submitted twice");
});

test("sync after publication reports the article and does not rely on a possibly removed draft", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("立即发布"); await f.click("确认立即发布");
  const id = f.publications[0].id;
  f.jobs.delete(id); // WeChat may remove the source draft after publication.
  await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.equal(f.publications.length, 1);
  const row = f.container.querySelector('[aria-label="测试公众号1 的结果"]');
  assert.match(row.textContent, /这份内容已发表/); assert.doesNotMatch(row.textContent, /草稿已保存|已同步到草稿箱|重新核对草稿/);
  assert.match(f.saved.receipts[0].message, /已发表/);
  await f.click("刷新状态");
  assert.match(row.textContent, /这份内容已发表/);
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.publications.length, 1);
  await f.changeContent(); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 2, "explicitly changed content may create a new draft after a known publication");
  assert.equal(f.publications.length, 1); assert.equal(f.saved.receipts[0].publicationAttempted, undefined);
});

test("changed copy cannot publish an older saved draft", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("同步到草稿箱");
  const oldId = f.creates[0].id; await f.changeContent(); await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.creates.length, 2); assert.notEqual(f.publications[0].id, oldId);
  assert.equal(f.creates[1].content.title, "新标题");
});

test("rechecking reconnects the browser account and visibly completes even when the draft is unchanged", async (context) => {
  const f = await fixture(context); await f.select(0); await f.click("同步到草稿箱");
  const id = f.creates[0].id, row = f.container.querySelector('[aria-label="测试公众号1 的结果"]');
  f.connects.length = 0; // The restarted helper has no remembered accounts.
  const gate = Promise.withResolvers(); f.verifyOverride = () => gate.promise;
  await f.openMore();
  await f.click("重新核对草稿");
  assert.match(row.textContent, /正在核对草稿…/);
  assert.equal(f.connects.length, 1); assert.equal(f.connects[0].appId, accounts[0].appId);
  assert.deepEqual(f.verifies, [id]);
  assert.equal([...row.querySelectorAll("button")].every((button) => button.disabled), true);
  await f.act(async () => { gate.resolve(f.jobs.get(id)); }); await f.settle();
  assert.match(row.textContent, /已重新核对：草稿已保存/);
  assert.equal(f.saved.receipts[0].jobId, id); assert.equal(f.creates.length, 1); assert.equal(f.publications.length, 0);
});

test("a fast recheck failure appears beside the account and retry reads the same saved task", async (context) => {
  const f = await fixture(context); await f.select(0); await f.click("同步到草稿箱");
  const id = f.creates[0].id, row = f.container.querySelector('[aria-label="测试公众号1 的结果"]');
  f.connectionOverride = () => { throw new Error("暂时连不上本机助手，请打开折页同步助手。"); };
  await f.openMore();
  await f.click("重新核对草稿");
  assert.match(row.querySelector('.draft-sync-message.error').textContent, /请打开折页同步助手/);
  assert.equal(f.verifies.length, 0); assert.equal(f.saved.receipts[0].jobId, id);
  f.connectionOverride = undefined; await f.click("重新核对草稿");
  assert.match(row.textContent, /已重新核对：草稿已保存/);
  assert.equal(row.querySelector('.draft-sync-message.error'), null);
  assert.deepEqual(f.verifies, [id]); assert.equal(f.creates.length, 1); assert.equal(f.publications.length, 0);
});

test("editing WeChat copy dismisses an open publication approval and requires a fresh one", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("立即发布");
  await f.changeContent();
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  assert.equal(f.publications.length, 0); assert.equal(f.creates.length, 0);
  await f.click("立即发布");
  assert.match(f.container.querySelector('[aria-label="确认立即发布"]').textContent, /新标题/);
  await f.click("确认立即发布");
  assert.equal(f.creates[0].content.title, "新标题"); assert.equal(f.publications.length, 1);
});

test("replacing prepared images or invalidating content checks cancels publication approval", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("立即发布");
  await f.changeImages();
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  await f.click("立即发布"); await f.setReady(false);
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  await f.setReady(true);
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null, "restoring content readiness cannot revive an old approval");
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.creates[0].images.length, 3); assert.equal(f.publications.length, 1);
});

test("changing target accounts cancels approval, while edits to the other platform preserve it", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0); await f.click("立即发布");
  await f.select(1);
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null);
  await f.select(1);
  assert.equal(f.container.querySelector('[aria-label="确认立即发布"]'), null, "restoring the old selection cannot revive approval");
  await f.click("立即发布"); await f.changeOtherPlatform();
  assert.ok(f.container.querySelector('[aria-label="确认立即发布"]'));
  await f.click("确认立即发布");
  assert.equal(f.publications.length, 1); assert.equal(f.publications[0].accountId, ids[0]);
});

test("an uncertain publication with no readback is never resubmitted or replaced by changed content", async (context) => {
  const f = await fixture(context, { publicationEnabled: true }); await f.select(0);
  f.publicationOverride = async () => { throw new Error("发表响应中断"); };
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.publications.length, 1); assert.equal(f.saved.receipts[0].publicationAttempted, true);
  await f.click("立即发布"); await f.click("确认立即发布");
  assert.equal(f.publications.length, 1); assert.match(f.container.textContent, /曾提交发表/);
  await f.changeContent(); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.equal(f.saved.receipts[0].publicationAttempted, true);
});

test("storage failure prevents uploads, while uncertain tasks stay blocked without another POST", async (context) => {
  const f = await fixture(context); await f.select(0); f.persistFailure = true; await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 0); assert.match(f.container.textContent, /存档空间不足/);
  f.persistFailure = false; f.createOverride = async () => { throw new Error("结果未知"); };
  await f.click("同步到草稿箱"); const pendingId = f.saved.receipts[0].jobId;
  assert.equal(f.saved.receipts[0].status, "needs_confirmation"); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.equal(f.saved.receipts[0].jobId, pendingId);
  assert.match(f.container.textContent, /任务不存在/);
});

const recoveryReceipt = (change = {}) => ({ platform: "wechat", accountId: ids[0], jobId: "76f6dbe5-a12d-4fe2-8ee7-35e6e988ab8e", status: "needs_confirmation", message: "请核对后台草稿箱", ...change });
const recoveryButton = (fixture) => [...fixture.container.querySelectorAll("button")].find(button => button.textContent === "确认未创建并允许重试");

test("definite submission rejection releases only the new identity and the next sync creates a fresh one", async (context) => {
  const f = await fixture(context); await f.select(0);
  f.createOverride = async () => { throw new WechatSubmissionRejectedError("请添加公众号 IP 白名单", 424); };
  await f.click("同步到草稿箱");
  const rejected = f.creates[0].id;
  assert.equal(f.saved.receipts[0].status, "failed");
  assert.equal(f.saved.receipts[0].jobId, undefined); assert.equal(f.saved.receipts[0].draftId, undefined);
  assert.match(f.saved.receipts[0].message, /IP 白名单/);
  assert.equal(recoveryButton(f), undefined);
  f.createOverride = undefined; await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 2); assert.notEqual(f.creates[1].id, rejected);
  assert.equal(f.saved.receipts[0].status, "saved");
});

test("a rejection while reading an older task never releases that task", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  f.readOverride = async () => { throw new WechatSubmissionRejectedError("旧任务暂不可读", 400); };
  await f.select(0); await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 0); assert.deepEqual(f.saved.receipts, [receipt]);
});

test("a missing old task requires explicit absence confirmation and cancellation sends nothing", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  await f.select(0); await f.click("刷新状态");
  assert.match(f.container.textContent, /任务不存在/);
  assert.equal(recoveryButton(f).disabled, true);
  await f.confirmNoDraft(); assert.equal(recoveryButton(f).disabled, false);
  await f.confirmNoDraft(false); assert.equal(recoveryButton(f).disabled, true);
  await f.act(async () => recoveryButton(f).click());
  assert.equal(f.resolutions.length, 0); assert.deepEqual(f.saved.receipts, [receipt]);
  await f.confirmNoDraft(); await f.click("确认未创建并允许重试");
  assert.deepEqual(f.resolutions, [{ id: receipt.jobId, accountId: ids[0] }]);
  assert.equal(f.creates.length, 0, "acknowledging absence must not automatically create a draft");
  assert.equal(f.saved.receipts[0].status, "failed"); assert.equal(f.saved.receipts[0].jobId, undefined);
  assert.equal(recoveryButton(f), undefined);
  await f.click("同步到草稿箱");
  assert.equal(f.creates.length, 1); assert.notEqual(f.creates[0].id, receipt.jobId);
});

test("a lost resolution acknowledgement keeps the same receipt and can be explicitly retried", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  f.resolveOverride = async () => { throw new Error("恢复确认响应丢失"); };
  await f.confirmNoDraft(); await f.click("确认未创建并允许重试");
  assert.deepEqual(f.saved.receipts, [receipt]); assert.equal(f.creates.length, 0);
  assert.match(f.container.textContent, /恢复确认响应丢失/);
  f.resolveOverride = undefined; await f.click("确认未创建并允许重试");
  assert.deepEqual(f.resolutions, Array.from({ length: 2 }, () => ({ id: receipt.jobId, accountId: ids[0] })));
  assert.equal(f.saved.receipts[0].status, "failed"); assert.equal(f.saved.receipts[0].jobId, undefined);
  assert.equal(f.creates.length, 0);
});

test("double clicking recovery sends one request and retains the identity until its acknowledgement", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  const gate = Promise.withResolvers(); f.resolveOverride = () => gate.promise;
  await f.confirmNoDraft();
  const button = recoveryButton(f);
  await f.act(async () => { button.click(); button.click(); }); await f.settle();
  assert.equal(f.resolutions.length, 1); assert.deepEqual(f.saved.receipts, [receipt]);
  assert.equal(recoveryButton(f).disabled, true); assert.equal(f.connects.length, 1);
  await f.act(async () => gate.resolve({ jobId: receipt.jobId, accountId: ids[0], confirmedNoDraft: true })); await f.settle();
  assert.equal(f.saved.receipts[0].status, "failed"); assert.equal(f.creates.length, 0);
});

test("recovery checks the original device and account before resolving", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  await f.confirmNoDraft();
  f.connectionOverride = async () => ({ deviceId: "other-device" });
  await f.click("确认未创建并允许重试");
  assert.equal(f.resolutions.length, 0); assert.deepEqual(f.saved.receipts, [receipt]);
  f.connectionOverride = undefined; f.failAccount = ids[0];
  await f.click("确认未创建并允许重试");
  assert.equal(f.resolutions.length, 0); assert.deepEqual(f.saved.receipts, [receipt]);
  f.failAccount = undefined; await f.click("确认未创建并允许重试");
  assert.equal(f.resolutions.length, 1); assert.equal(f.saved.receipts[0].jobId, undefined);
});

test("saving the recovery receipt must succeed before the original identity can be released", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  await f.confirmNoDraft(); f.persistFailure = true;
  await f.click("确认未创建并允许重试");
  assert.equal(f.resolutions.length, 1); assert.deepEqual(f.saved.receipts, [receipt]);
  assert.equal(f.creates.length, 0); assert.match(f.container.textContent, /存档空间不足/);
  f.persistFailure = false; await f.click("确认未创建并允许重试");
  assert.equal(f.resolutions.length, 2); assert.equal(f.saved.receipts[0].jobId, undefined);
});

test("known draft IDs, publication attempts, and definite failures never offer absence recovery", async (context) => {
  for (const change of [{ draftId: "known-draft" }, { publicationAttempted: true }, { status: "saved", draftId: "known-draft" }, { status: "failed" }]) {
    await context.test(JSON.stringify(change), async (subtest) => {
      const receipt = recoveryReceipt(change), f = await fixture(subtest, { receipts: [receipt] });
      assert.equal(recoveryButton(f), undefined);
      assert.doesNotMatch(f.container.textContent, /我已在该公众号后台草稿箱确认没有这份内容/);
      assert.equal(f.resolutions.length, 0);
    });
  }
});

test("a confirmed failed job can be synced again without manual absence confirmation", async (context) => {
  const receipt = recoveryReceipt({ status: "failed" }), f = await fixture(context, { receipts: [receipt] });
  f.jobs.set(receipt.jobId, { id: receipt.jobId, accountId: ids[0], status: "failed", message: "微信明确拒绝，未创建草稿" });
  await f.select(0); await f.click("同步到草稿箱");
  assert.equal(f.resolutions.length, 0); assert.equal(f.creates.length, 1);
  assert.notEqual(f.creates[0].id, receipt.jobId); assert.equal(f.saved.receipts[0].status, "saved");
});

test("closing recovery discards a late acknowledgement and retains the original task", async (context) => {
  const receipt = recoveryReceipt(), f = await fixture(context, { receipts: [receipt] });
  const gate = Promise.withResolvers(); f.resolveOverride = () => gate.promise;
  await f.confirmNoDraft(); await f.click("确认未创建并允许重试");
  await f.close(); await f.act(async () => gate.resolve({ jobId: receipt.jobId, accountId: ids[0], confirmedNoDraft: true }));
  assert.deepEqual(f.saved.receipts, [receipt]); assert.equal(f.creates.length, 0);
});

test("closing an active request preserves pending identity and discards late results", async (context) => {
  const f = await fixture(context); let finish;
  f.createOverride = (input) => new Promise((resolve) => { finish = () => resolve({ id: input.id, accountId: input.accountId, status: "saved", draftId: "late" }); });
  await f.select(0); await f.click("同步到草稿箱");
  const pending = f.saved.receipts[0].jobId; await f.close(); await f.act(async () => finish());
  assert.equal(f.saved.receipts[0].jobId, pending); assert.equal(f.saved.receipts[0].status, "needs_confirmation"); assert.equal(f.saved.receipts[0].draftId, undefined);
});

test("content identity includes original image bytes and order but ignores draft bookkeeping", async () => {
  const { wechatContentHash } = loadDomModule("lib/wechat/contentIdentity.ts");
  const images = ["first", "second"].map((text) => ({ blob: new Blob([text]) }));
  const draft = { images, content: { wechat: { title: "标题", body: "一\n二" } } };
  const original = await wechatContentHash(draft);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(await wechatContentHash({ ...draft, id: "other", receipts: [{}] }), original);
  assert.notEqual(await wechatContentHash({ ...draft, images: [...images].reverse() }), original);
  assert.notEqual(await wechatContentHash({ ...draft, content: { wechat: { title: "新标题", body: "一\n二" } } }), original);
});


function mainActionHints(container) {
  const region = container.querySelector('[aria-label="公众号操作"]');
  return [...region.querySelectorAll("button")].map((button) => {
    const descriptionId = button.getAttribute("aria-describedby");
    return { text: button.textContent, disabled: button.disabled,
      describedBy: descriptionId ? container.ownerDocument.getElementById(descriptionId)?.textContent : undefined };
  });
}

test("selected accounts with incomplete content see their checks immediately beside the disabled actions", async (context) => {
  const f = await fixture(context, { contentReady: false, contentCheck: "请确认这 6 张图片沿用当前比例" });
  await f.select(0);
  const region = f.container.querySelector('[aria-label="公众号操作"]');
  assert.match(region.querySelector('[aria-label="同步前检查"]').textContent, /这 6 张图片/);
  for (const action of mainActionHints(f.container)) {
    assert.equal(action.disabled, true);
    assert.match(action.describedBy, /请确认这 6 张图片沿用当前比例/);
  }
  assert.equal(f.creates.length, 0); assert.equal(f.publications.length, 0);
});

test("disabled actions explain missing selection and clear the hint once an account is selected", async (context) => {
  const f = await fixture(context);
  for (const action of mainActionHints(f.container)) {
    assert.equal(action.disabled, true); assert.match(action.describedBy, /勾选至少一个公众号/);
  }
  await f.select(0);
  for (const action of mainActionHints(f.container)) { assert.equal(action.disabled, false); assert.equal(action.describedBy, undefined); }
});

test("a bound browser without public accounts cannot upload or publish", async (context) => {
  const f = await fixture(context, { accounts: [] });
  for (const action of mainActionHints(f.container)) {
    assert.equal(action.disabled, true); assert.match(action.describedBy, /勾选至少一个公众号/);
  }
  assert.equal(f.creates.length, 0); assert.equal(f.publications.length, 0);
});

test("incomplete content without a supplied check still explains why actions are disabled", async (context) => {
  const f = await fixture(context, { contentReady: false });
  await f.select(0);
  for (const action of mainActionHints(f.container)) {
    assert.equal(action.disabled, true); assert.match(action.describedBy, /完成图片和文案检查/);
  }
});

test("busy action hint has priority over account selection", async (context) => {
  const f = await fixture(context, { busy: true, contentReady: false });
  for (const action of mainActionHints(f.container)) {
    assert.equal(action.disabled, true); assert.equal(action.describedBy, "正在处理，请稍候。");
  }
});
