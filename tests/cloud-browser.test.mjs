import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCloudBrowser, CloudBrowserCleanupError } from "../cloud/browser.mjs";

function state() {
  return {
    cookies: [{ name: "test_session", value: "fake-cookie-only", domain: ".xiaohongshu.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    origins: [{ origin: "https://creator.xiaohongshu.com", localStorage: [{ name: "test", value: "not-a-real-token" }], indexedDB: [], opfs: [] }],
  };
}

function fixture(options = {}) {
  const calls = [];
  let handler;
  const context = {
    pages: () => options.pages ?? [],
    route: async (pattern, callback) => {
      calls.push(["route", pattern]);
      if (options.routeError) throw options.routeError;
      handler = callback;
    },
    storageState: async (settings) => {
      calls.push(["snapshot", settings]);
      return options.snapshot ? await options.snapshot() : state();
    },
    close: async () => {
      calls.push(["context.close"]);
      await options.contextClose?.();
    },
  };
  const browser = {
    newContext: async (settings) => {
      calls.push(["newContext", settings]);
      if (options.contextError) throw options.contextError;
      return context;
    },
    close: async () => {
      calls.push(["browser.close"]);
      await options.browserClose?.();
    },
  };
  const playwright = { chromium: { launch: async (settings) => { calls.push(["launch", settings]); return browser; } } };
  return { playwright, calls, context, route: async (request) => {
    const actions = [];
    await handler({ request: () => request, abort: async (reason) => actions.push(["abort", reason]), continue: async () => actions.push(["continue"]) });
    return actions;
  } };
}

function page(url = "https://creator.xiaohongshu.com/new/home", screenshot) {
  const result = new EventEmitter();
  const frame = {};
  result.currentUrl = url;
  result.closed = false;
  result.captures = [];
  result.url = () => result.currentUrl;
  result.isClosed = () => result.closed;
  result.mainFrame = () => frame;
  result.screenshot = async (settings) => {
    result.captures.push(settings);
    return screenshot ? await screenshot(result) : Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  };
  return result;
}

test("cloud browser creates an isolated sandboxed context and snapshots in memory", async () => {
  const stub = fixture();
  const initial = state();
  const runtime = await createCloudBrowser({ playwright: stub.playwright, storageState: initial, launchOptions: { executablePath: "/trusted/chromium", headless: false, chromiumSandbox: false } });
  assert.deepEqual(stub.calls[0], ["launch", { executablePath: "/trusted/chromium", headless: true, chromiumSandbox: true }]);
  assert.deepEqual(stub.calls[1], ["newContext", { storageState: initial, acceptDownloads: false, viewport: { width: 1280, height: 900 } }]);
  assert.notEqual(stub.calls[1][1].storageState, initial);
  assert.equal(runtime.context, stub.context);
  assert.deepEqual(await runtime.snapshot(), initial);
  assert.deepEqual(stub.calls.at(-1), ["snapshot", { indexedDB: true, opfs: true }]);
  assert.equal(await runtime.screenshot(), undefined);
  await runtime.close();
  assert.deepEqual(stub.calls.slice(-2), [["context.close"], ["browser.close"]]);
  await assert.rejects(runtime.snapshot(), /会话已结束/);
  assert.equal(await runtime.screenshot(), undefined);
});

test("navigation only allows the two HTTPS sites while assets remain loadable", async () => {
  const stub = fixture();
  const runtime = await createCloudBrowser({ playwright: stub.playwright });
  try {
    for (const url of ["https://creator.xiaohongshu.com/publish/publish", "https://www.xiaohongshu.com/explore"]) {
      assert.deepEqual(await stub.route({ isNavigationRequest: () => true, url: () => url }), [["continue"]]);
    }
    for (const url of ["http://creator.xiaohongshu.com/", "https://creator.xiaohongshu.com.attacker.example/", "https://creator.xiaohongshu.com:8443/", "https://user:password@www.xiaohongshu.com/", "https://example.com/", "http://127.0.0.1/", "file:///etc/passwd"]) {
      assert.deepEqual(await stub.route({ isNavigationRequest: () => true, url: () => url }), [["abort", "blockedbyclient"]]);
    }
    assert.deepEqual(await stub.route({ isNavigationRequest: () => false, url: () => "https://cdn.example.com/image.png" }), [["continue"]]);
  } finally { await runtime.close(); }
});

test("screenshot uses the latest open page and never falls back from an unrelated page", async () => {
  const earlier = page();
  const latest = page("https://www.xiaohongshu.com/explore");
  const closed = page();
  closed.closed = true;
  const pages = [earlier, latest, closed];
  const stub = fixture({ pages });
  const runtime = await createCloudBrowser({ playwright: stub.playwright });
  try {
    assert.equal(await runtime.screenshot(), "data:image/jpeg;base64,/9j/2Q==");
    assert.deepEqual(latest.captures, [{ type: "jpeg", quality: 70 }]);
    assert.equal(earlier.captures.length, 0);
    pages.push(page("https://example.com/private"));
    assert.equal(await runtime.screenshot(), undefined);
    assert.equal(earlier.captures.length, 0);
    assert.equal(latest.captures.length, 1);
  } finally { await runtime.close(); }
});

test("screenshots are discarded if the page navigates, closes, or fails during capture", async () => {
  const actions = [
    (current) => { current.currentUrl = "https://example.com/private"; },
    (current) => { current.emit("framenavigated", current.mainFrame()); },
    (current) => { current.closed = true; },
    () => { throw new Error("renderer unavailable"); },
  ];
  for (const action of actions) {
    const current = page(undefined, async (capture) => { action(capture); return Buffer.from("should-not-be-returned"); });
    const stub = fixture({ pages: [current] });
    const runtime = await createCloudBrowser({ playwright: stub.playwright });
    try {
      assert.equal(await runtime.screenshot(), undefined);
      assert.equal(current.listenerCount("framenavigated"), 0);
    } finally { await runtime.close(); }
  }
});

test("storage state rejects credential file paths and malformed data before launching", async () => {
  const invalidStates = [
    "/private/credentials.json", null, [], {}, { cookies: {}, origins: [] }, { cookies: [], origins: null },
    { cookies: [null], origins: [] }, { cookies: [{ ...state().cookies[0], expires: Infinity }], origins: [] },
    { cookies: [{ ...state().cookies[0], domain: "xiaohongshu.com.attacker.example" }], origins: [] },
    { cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] },
    { cookies: [], origins: [{ origin: "https://creator.xiaohongshu.com", localStorage: [{ name: "a", value: null }] }] },
  ];
  for (const storageState of invalidStates) {
    const stub = fixture();
    await assert.rejects(createCloudBrowser({ playwright: stub.playwright, storageState }), /授权资料无效/);
    assert.equal(stub.calls.length, 0);
  }
});

test("snapshot size is measured in UTF-8 bytes and rejects the whole oversized state", async () => {
  const oversized = state();
  oversized.origins[0].localStorage[0].value = "图".repeat(2 * 1024 * 1024);
  assert.ok(JSON.stringify(oversized).length < 5 * 1024 * 1024);
  const stub = fixture({ snapshot: async () => oversized });
  const runtime = await createCloudBrowser({ playwright: stub.playwright });
  try {
    await assert.rejects(runtime.snapshot(), /超过 5 MiB/);
    const untouched = fixture();
    await assert.rejects(createCloudBrowser({ playwright: untouched.playwright, storageState: oversized }), /超过 5 MiB/);
    assert.equal(untouched.calls.length, 0);
  } finally { await runtime.close(); }
});

test("malformed or unserializable snapshots are rejected without returning partial state", async () => {
  const cycle = state();
  cycle.self = cycle;
  for (const snapshot of [null, { cookies: [], origins: [null] }, cycle]) {
    const stub = fixture({ snapshot: async () => snapshot });
    const runtime = await createCloudBrowser({ playwright: stub.playwright });
    try { await assert.rejects(runtime.snapshot(), /授权资料无效/); }
    finally { await runtime.close(); }
  }
});

test("close is shared and still closes the browser when context cleanup fails", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const stub = fixture({ contextClose: async () => { await waiting; throw new Error("context failed"); } });
  const runtime = await createCloudBrowser({ playwright: stub.playwright });
  const first = runtime.close();
  assert.equal(runtime.close(), first);
  release();
  await first;
  await runtime.close();
  assert.equal(stub.calls.filter(([name]) => name === "context.close").length, 1);
  assert.equal(stub.calls.filter(([name]) => name === "browser.close").length, 1);
});

test("browser cleanup failure has a safe identifiable error and is not retried", async () => {
  const privateError = new Error("test-only private browser details");
  const stub = fixture({ browserClose: async () => { throw privateError; } });
  const runtime = await createCloudBrowser({ playwright: stub.playwright });
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  await assert.rejects(closing, (error) => {
    assert.ok(error instanceof CloudBrowserCleanupError);
    assert.equal(error.name, "CloudBrowserCleanupError");
    assert.equal(error.message.includes(privateError.message), false);
    return true;
  });
  await assert.rejects(runtime.close(), CloudBrowserCleanupError);
  assert.equal(stub.calls.filter(([name]) => name === "context.close").length, 1);
  assert.equal(stub.calls.filter(([name]) => name === "browser.close").length, 1);
});

test("context and route setup failures always dispose the launched browser", async () => {
  for (const field of ["contextError", "routeError"]) {
    const failure = new Error("setup failed");
    const stub = fixture({ [field]: failure });
    await assert.rejects(createCloudBrowser({ playwright: stub.playwright }), (error) => error === failure);
    assert.equal(stub.calls.filter(([name]) => name === "browser.close").length, 1);
    assert.equal(stub.calls.filter(([name]) => name === "context.close").length, field === "routeError" ? 1 : 0);
  }
});

test("trusted launch configuration still cannot enable a debug listener or persistent profile", async () => {
  for (const launchOptions of [{ args: ["--remote-debugging-port=9222"] }, { args: ["--remote-debugging-address=0.0.0.0"] }, { args: ["--user-data-dir=/private/profile"] }, { userDataDir: "/private/profile" }, { args: "--remote-debugging-port=9222" }]) {
    const stub = fixture();
    await assert.rejects(createCloudBrowser({ playwright: stub.playwright, launchOptions }), /启动配置无效/);
    assert.equal(stub.calls.length, 0);
  }
});
