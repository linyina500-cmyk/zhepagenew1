import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWechatApi, WechatApiError } from "../lib/wechat/api.mjs";
import { createPublicationService } from "../server/wechat/publications.mjs";

const accountId = "0123456789abcdef0123";
const published = { status: "published", articleId: "article-1", urls: ["https://mp.weixin.qq.com/s/fixture"], message: "微信已确认发表成功。" };
async function fixture(t, overrides = {}, jobPatch = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "zhepage-publication-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const jobId = randomUUID(), directory = join(dataDir, accountId, jobId), calls = [], publicationAttempts = new Map();
  await mkdir(directory, { recursive: true });
  const job = { id: jobId, accountId, status: "saved", draftId: "draft-1", imageCount: 2, uploadedCount: 2, ...jobPatch };
  const api = {
    async submitPublication(value) { calls.push(["submit", value]); return { publishId: "publish-1" }; },
    async getPublication(value) { calls.push(["get", value]); return published; },
    ...overrides,
  };
  const options = { dataDir, accountId, api, jobs: {
    beginPublication(id) {
      publicationAttempts.set(id, (publicationAttempts.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = publicationAttempts.get(id) - 1;
        if (count) publicationAttempts.set(id, count); else publicationAttempts.delete(id);
      };
    },
    async get() { return job; }, async verify() { return job; },
  } };
  return { dataDir, directory, path: join(directory, "publication.json"), jobId, job, calls, api, options, publicationAttempts, service: createPublicationService(options) };
}
function diskFailure(t, fail) {
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    if (fail(...args)) throw Object.assign(new Error("fixture ENOSPC with secret"), { code: "ENOSPC" });
    return original(...args);
  };
  syncBuiltinESMExports();
  const restore = () => { fs.promises.open = original; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test("only a verified complete draft can publish, and a task is polled without replay after restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.submit(f.jobId)).status, "submitting");
  await f.service.idle();
  assert.equal((await f.service.get(f.jobId)).status, "publishing");
  assert.equal(f.calls.length, 1);
  const restarted = createPublicationService(f.options);
  assert.equal((await restarted.submit(f.jobId)).publishId, "publish-1");
  const result = await restarted.refresh(f.jobId);
  assert.equal(result.status, "published");
  assert.equal(result.articleId, "article-1");
  assert.deepEqual(result.urls, published.urls);
  assert.equal("draftId" in result, false); assert.equal("accountId" in result, false);
  assert.deepEqual(f.calls, [["submit", { draftId: "draft-1" }], ["get", { publishId: "publish-1" }]]);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).status, "published");
});

test("incomplete, unverified or other-account jobs cannot reserve or publish", async (t) => {
  for (const patch of [{ status: "needs_confirmation" }, { uploadedCount: 1 }, { imageCount: 0, uploadedCount: 0 }, { draftId: "" }, { accountId: "another-account" }, { id: randomUUID() }]) {
    const f = await fixture(t, {}, patch);
    await assert.rejects(f.service.submit(f.jobId), (error) => error.status === 409);
    assert.equal(f.calls.length, 0);
    assert.equal(f.publicationAttempts.size, 0);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});

test("publication attempts cover queued reservations until the durable record exists", async (t) => {
  const f = await fixture(t);
  let releaseRead, enteredRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const releases = [], begin = f.options.jobs.beginPublication;
  f.options.jobs.beginPublication = (id) => {
    const release = begin(id);
    return () => { releases.push(fs.existsSync(f.path)); release(); };
  };
  f.options.jobs.get = async () => { enteredRead(); await gate; return f.job; };
  const first = f.service.submit(f.jobId);
  assert.equal(f.publicationAttempts.get(f.jobId), 1);
  const second = f.service.submit(f.jobId);
  assert.equal(f.publicationAttempts.get(f.jobId), 2);
  await entered;
  assert.equal(fs.existsSync(f.path), false);
  assert.equal(f.calls.length, 0);
  releaseRead();
  await Promise.all([first, second]);
  await f.service.idle();
  assert.deepEqual(releases, [true, true]);
  assert.equal(f.publicationAttempts.size, 0);
  assert.equal(f.calls.filter(([kind]) => kind === "submit").length, 1);
});

test("a resolving job rejects publication before any reservation or external call", async (t) => {
  const f = await fixture(t);
  f.options.jobs.beginPublication = () => { throw Object.assign(new Error("草稿正在人工核对"), { status: 409 }); };
  f.options.jobs.get = async () => { assert.fail("a rejected publication attempt must not read the job"); };
  await assert.rejects(f.service.submit(f.jobId), (error) => error.status === 409);
  assert.equal(f.service.busy(), false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});

test("a fresh official draft readback must pass after reservation and before publication", async (t) => {
  for (const changed of [{ status: "needs_confirmation" }, { draftId: "changed-draft" }, new Error("private-token")]) {
    const f = await fixture(t);
    let verifies = 0;
    f.options.jobs.verify = async () => {
      verifies++;
      assert.equal(JSON.parse(await readFile(f.path, "utf8")).status, "submitting");
      if (changed instanceof Error) throw changed;
      return { ...f.job, ...changed };
    };
    await f.service.submit(f.jobId); await f.service.idle();
    const result = await f.service.get(f.jobId);
    assert.equal(result.status, "failed"); assert.match(result.message, /尚未提交发表/u);
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
    await createPublicationService(f.options).submit(f.jobId);
    assert.equal(verifies, 1); assert.equal(f.calls.length, 0);
  }
});

test("independent service instances racing to reserve a draft still submit only once", async (t) => {
  const f = await fixture(t);
  let readers = 0, releaseReaders, releaseSubmit;
  const ready = new Promise((resolve) => { releaseReaders = resolve; });
  f.options.jobs.get = async () => { if (++readers === 2) releaseReaders(); await ready; return f.job; };
  f.api.submitPublication = async () => { f.calls.push(["submit"]); return new Promise((resolve) => { releaseSubmit = resolve; }); };
  const second = createPublicationService(f.options);
  const results = await Promise.allSettled([f.service.submit(f.jobId), second.submit(f.jobId)]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal(f.calls.length, 1);
  releaseSubmit({ publishId: "publish-1" });
  await Promise.all([f.service.idle(), second.idle()]);
  assert.equal((await f.service.get(f.jobId)).publishId, "publish-1");
});

test("submitting is written before the external call and concurrent clicks produce one submission", async (t) => {
  let resolveSubmit, entered;
  const entry = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t);
  f.api.submitPublication = async () => {
    f.calls.push(["submit"]);
    assert.equal(JSON.parse(await readFile(f.path, "utf8")).status, "submitting");
    entered();
    return new Promise((resolve) => { resolveSubmit = resolve; });
  };
  const results = await Promise.all([f.service.submit(f.jobId), f.service.submit(f.jobId)]);
  await entry;
  assert.ok(results.every((result) => result.status === "submitting"));
  assert.equal(f.service.busy(), true);
  assert.equal((await f.service.refresh(f.jobId)).status, "submitting");
  const competing = createPublicationService(f.options);
  assert.equal((await competing.submit(f.jobId)).status, "needs_confirmation");
  assert.equal(f.calls.length, 1);
  resolveSubmit({ publishId: "publish-1" }); await f.service.idle();
  assert.equal(f.service.busy(), false);
});

test("interrupted submitting records and malformed reservations never replay or poll without an ID", async (t) => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  await writeFile(f.path, JSON.stringify({ jobId: f.jobId, accountId, draftId: "draft-1", status: "submitting", urls: [], createdAt: now, updatedAt: now }));
  assert.equal((await f.service.get(f.jobId)).status, "needs_confirmation");
  assert.equal((await f.service.submit(f.jobId)).status, "needs_confirmation");
  assert.equal((await f.service.refresh(f.jobId)).status, "needs_confirmation");
  await writeFile(f.path, "partial record");
  await assert.rejects(f.service.submit(f.jobId), (error) => error.status === 503);
  assert.equal(f.calls.length, 0);
  assert.equal(f.publicationAttempts.size, 0);
});

test("clear rejection, unsubmitted requests and unknown outcomes stay terminal without exposing raw errors", async (t) => {
  for (const outcome of ["rejected", "not_submitted", "uncertain", "spoofed"]) {
    let count = 0;
    const message = outcome === "not_submitted" ? "尚未取得公众号调用凭据，发表请求尚未发出。" : "请到公众号后台保存（错误码 53505）。";
    const f = await fixture(t, { async submitPublication() {
      count++;
      if (outcome === "rejected" || outcome === "not_submitted") throw new WechatApiError(message, { outcome, errcode: outcome === "rejected" ? 53505 : undefined });
      const error = new Error("private-secret https://api.weixin.qq.com/?access_token=token");
      if (outcome === "spoofed") { error.name = "WechatApiError"; error.outcome = "not_submitted"; }
      throw error;
    } });
    await f.service.submit(f.jobId); await f.service.idle();
    const result = await f.service.get(f.jobId);
    const failed = outcome === "rejected" || outcome === "not_submitted";
    assert.equal(result.status, failed ? "failed" : "needs_confirmation");
    if (failed) assert.equal(result.message, message);
    assert.equal(result.publishId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|access_token|api.weixin/);
    const restarted = createPublicationService(f.options);
    assert.equal((await restarted.submit(f.jobId)).status, result.status);
    await f.service.refresh(f.jobId);
    assert.equal(count, 1);
  }
});

test("token failure before publication is definitive while a lost submission receipt remains uncertain", async (t) => {
  for (const stage of ["token", "submit"]) {
    const paths = [];
    const api = createWechatApi({ appId: "wx-fixture", appSecret: "fixture-secret", fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (stage === "submit" && path === "/cgi-bin/stable_token") return Response.json({ access_token: "fixture-token", expires_in: 7200 });
      throw new Error("private-secret https://api.weixin.qq.com/?access_token=fixture-token");
    } });
    const f = await fixture(t, { submitPublication: api.submitPublication });
    await f.service.submit(f.jobId); await f.service.idle();
    const result = await f.service.get(f.jobId);
    assert.equal(result.status, stage === "token" ? "failed" : "needs_confirmation");
    assert.equal(result.publishId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|fixture-token|access_token|api.weixin/);
    const restarted = createPublicationService(f.options);
    assert.equal((await restarted.submit(f.jobId)).status, result.status);
    assert.equal((await restarted.refresh(f.jobId)).status, result.status);
    assert.deepEqual(paths, stage === "token" ? ["/cgi-bin/stable_token"] : ["/cgi-bin/stable_token", "/cgi-bin/freepublish/submit"]);
  }
});

test("failure to fsync the reservation prevents the external publication call", async (t) => {
  const f = await fixture(t);
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === f.directory) handle.sync = async () => { throw new Error("fixture fsync failure"); };
    return handle;
  };
  syncBuiltinESMExports();
  const restore = () => { fs.promises.open = original; syncBuiltinESMExports(); };
  t.after(restore);
  await assert.rejects(f.service.submit(f.jobId), (error) => error.status === 503);
  assert.equal(f.calls.length, 0);
  restore();
  assert.equal((await f.service.submit(f.jobId)).status, "needs_confirmation");
  assert.equal(f.calls.length, 0);
});

test("lost storage after receipt retains the publication ID and refresh can persist recovery", async (t) => {
  const f = await fixture(t);
  let full = false, failures = 0;
  f.api.submitPublication = async () => { f.calls.push(["submit"]); full = true; return { publishId: "publish-1" }; };
  const restore = diskFailure(t, (path, flags) => {
    if (full && flags === "wx" && String(path).startsWith(f.directory) && String(path).endsWith(".tmp")) { failures++; return true; }
    return false;
  });
  await f.service.submit(f.jobId); await f.service.idle();
  const lost = await f.service.get(f.jobId);
  assert.equal(lost.status, "needs_confirmation"); assert.equal(lost.publishId, "publish-1");
  assert.equal((await f.service.submit(f.jobId)).publishId, "publish-1");
  assert.equal((await f.service.refresh(f.jobId)).status, "needs_confirmation");
  assert.equal(failures, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "submit").length, 1);
  restore();
  assert.equal((await f.service.refresh(f.jobId)).status, "published");
  const restarted = createPublicationService(f.options);
  assert.equal((await restarted.get(f.jobId)).publishId, "publish-1");
  assert.equal((await restarted.submit(f.jobId)).status, "published");
  assert.equal(f.calls.filter(([kind]) => kind === "submit").length, 1);
});

test("unknown poll results preserve the task ID and only a later confirmed result becomes published", async (t) => {
  const f = await fixture(t);
  await f.service.submit(f.jobId); await f.service.idle();
  for (const value of [{ status: "future-state", urls: [] }, { status: "published", urls: [] }, new Error("secret-token")]) {
    f.api.getPublication = async () => { if (value instanceof Error) throw value; return value; };
    const result = await f.service.refresh(f.jobId);
    assert.equal(result.status, "needs_confirmation"); assert.equal(result.publishId, "publish-1");
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  }
  f.api.getPublication = async () => published;
  assert.equal((await f.service.refresh(f.jobId)).status, "published");
  for (const status of ["removed", "blocked"]) {
    f.api.getPublication = async () => ({ status, urls: [], message: "微信已确认内容状态变化。" });
    const result = await f.service.refresh(f.jobId);
    assert.equal(result.status, status); assert.deepEqual(result.urls, published.urls);
  }
  assert.equal(f.calls.filter(([kind]) => kind === "submit").length, 1);
});

test("path traversal and cross-account stored records fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.submit("../../other-account"));
  await f.service.submit(f.jobId); await f.service.idle();
  const stored = JSON.parse(await readFile(f.path, "utf8"));
  await writeFile(f.path, JSON.stringify({ ...stored, accountId: "another-account" }));
  await assert.rejects(f.service.submit(f.jobId), (error) => error.status === 503);
  assert.equal(f.calls.length, 1);
});
