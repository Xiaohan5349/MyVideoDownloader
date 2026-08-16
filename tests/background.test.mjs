import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGE = {
  MEDIA_ADD_DETECTED: "media:addDetected",
  DOWNLOADS_START: "downloads:start",
  DOWNLOADS_JOBS_CLEAR_MISSING: "downloads:jobClearMissing",
};

function createChromeMock() {
  const data = {};
  const listeners = {
    onMessage: null,
    onBeforeSendHeaders: null,
    onHeadersReceived: null,
    onTabRemoved: null,
    onTabUpdated: null,
  };

  const storage = {
    async get(keys = null) {
      if (keys === null || keys === undefined) return { ...data };
      const result = {};
      for (const key of [].concat(keys)) result[key] = data[key];
      return result;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete data[key];
    },
  };

  const mock = {
    data,
    listeners,
    storage: { local: storage },
    runtime: {
      onMessage: {
        addListener(fn) { listeners.onMessage = fn; },
      },
    },
    webRequest: {
      onBeforeSendHeaders: {
        addListener(fn) { listeners.onBeforeSendHeaders = fn; },
      },
      onHeadersReceived: {
        addListener(fn) { listeners.onHeadersReceived = fn; },
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) { listeners.onTabRemoved = fn; },
      },
      onUpdated: {
        addListener(fn) { listeners.onTabUpdated = fn; },
      },
      async query() { return mock.tabs.queryResult; },
      async get(tabId) {
        const tab = mock.tabs.tabsById?.[tabId];
        if (!tab) throw new Error("TAB_NOT_FOUND");
        return tab;
      },
      async sendMessage(tabId, message, options) {
        mock.tabs.sendMessageCalls.push({ tabId, message, options });
        if (mock.tabs.sendMessageError) throw mock.tabs.sendMessageError;
        return mock.tabs.sendMessageResult;
      },
      tabsById: {},
      queryResult: [],
      sendMessageCalls: [],
      sendMessageResult: { ok: true },
      sendMessageError: null,
    },
    permissions: {
      async contains() { return true; },
      async request() { return true; },
    },
    downloads: {
      async download() { return 42; },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
    reset() {
      for (const key of Object.keys(data)) delete data[key];
      mock.tabs.queryResult = [];
      mock.tabs.tabsById = {};
      mock.tabs.sendMessageCalls = [];
      mock.tabs.sendMessageResult = { ok: true };
      mock.tabs.sendMessageError = null;
    },
  };

  return mock;
}

const mock = createChromeMock();
globalThis.chrome = mock;
mock.tabs.tabsById[10] = { id: 10, url: "https://site.example", title: "Site" };
mock.tabs.queryResult = [{ id: 10, url: "https://site.example", title: "Site" }];

const backgroundModule = await import(pathToFileURL(path.join(__dirname, "..", "src", "background.js")).href);
const originalFetch = globalThis.fetch;

function sendRuntimeMessage(message, sender = {}) {
  const handler = mock.listeners.onMessage;
  assert.ok(handler, "runtime.onMessage listener should be registered");
  return new Promise((resolve) => {
    const returnValue = handler(message, sender, resolve);
    if (returnValue !== true) resolve(undefined);
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.reset();
  mock.tabs.tabsById[10] = { id: 10, url: "https://site.example", title: "Site" };
  mock.tabs.queryResult = [{ id: 10, url: "https://site.example", title: "Site" }];
});

test("MEDIA_ADD_DETECTED stores frameId and tabId on detected items", async () => {
  const response = await sendRuntimeMessage(
    {
      type: MESSAGE.MEDIA_ADD_DETECTED,
      items: [{
        url: "https://cdn.example.com/video.mp4",
        sourcePageUrl: "https://site.example",
        title: "Video",
        extension: "mp4",
        kind: "direct",
      }],
    },
    { tab: { id: 10, url: "https://site.example", title: "Site" }, frameId: 3 }
  );

  assert.equal(response.ok, true);
  const stored = await mock.storage.local.get("tabMedia:10");
  const items = stored["tabMedia:10"];
  assert.equal(items.length, 1);
  assert.equal(items[0].frameId, 3);
  assert.equal(items[0].tabId, 10);
  assert.equal(items[0].kind, "direct");
});

test("MEDIA_ADD_DETECTED replaces media from a previous page URL", async () => {
  await sendRuntimeMessage(
    {
      type: MESSAGE.MEDIA_ADD_DETECTED,
      items: [{
        url: "https://cdn.example.com/video-a.mp4",
        sourcePageUrl: "https://site.example/a",
        title: "Video A",
        extension: "mp4",
        kind: "direct",
      }],
    },
    { tab: { id: 10, url: "https://site.example/a", title: "A" }, frameId: 0 }
  );

  await sendRuntimeMessage(
    {
      type: MESSAGE.MEDIA_ADD_DETECTED,
      items: [{
        url: "https://cdn.example.com/video-b.mp4",
        sourcePageUrl: "https://site.example/b",
        title: "Video B",
        extension: "mp4",
        kind: "direct",
      }],
    },
    { tab: { id: 10, url: "https://site.example/b", title: "B" }, frameId: 0 }
  );

  const stored = await mock.storage.local.get("tabMedia:10");
  assert.equal(stored["tabMedia:10"].length, 1);
  assert.equal(stored["tabMedia:10"][0].title, "Video B");
});

test("tab main-frame navigation clears the previous page media", async () => {
  await mock.storage.local.set({ "tabMedia:10": [{ id: "old", title: "Old" }] });
  const handler = mock.listeners.onTabUpdated;
  assert.ok(handler, "tabs.onUpdated listener should be registered");
  handler(10, { status: "loading", url: "https://site.example/new" });
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.equal(stored["tabMedia:10"], undefined);
});

test("page:clearMedia removes the tab media cache", async () => {
  await mock.storage.local.set({ "tabMedia:10": [{ url: "x", id: "x" }] });
  const response = await sendRuntimeMessage(
    { type: "page:clearMedia" },
    { tab: { id: 10 } }
  );
  assert.equal(response.ok, true);
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.equal(stored["tabMedia:10"], undefined);
});

test("DOWNLOADS_START for HLS passes frameId and authToken to the content script", async () => {
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ ok: true, token: "token-123" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  mock.tabs.sendMessageResult = { ok: true, helperJob: { id: "job-1" } };

  const response = await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: {
      url: "https://cdn.example.com/master.m3u8",
      sourcePageUrl: "https://site.example",
      title: "Stream",
      extension: "m3u8",
      kind: "hls",
      frameId: 3,
      tabId: 10,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.helperJob.id, "job-1");
  assert.equal(mock.tabs.sendMessageCalls.length, 1);
  assert.deepEqual(mock.tabs.sendMessageCalls[0].options, { frameId: 3 });
  assert.equal(mock.tabs.sendMessageCalls[0].message.payload.authToken, "token-123");
});

test("DOWNLOADS_START for HLS returns HELPER_OFFLINE when /auth is unavailable", async () => {
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  const response = await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: {
      url: "https://cdn.example.com/master.m3u8",
      sourcePageUrl: "https://site.example",
      title: "Stream",
      extension: "m3u8",
      kind: "hls",
      frameId: 0,
      tabId: 10,
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "HELPER_OFFLINE");
  assert.equal(mock.tabs.sendMessageCalls.length, 0);
});

test("SEGMENTS_INCOMPLETE from the content script is not retried via helper fallback", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ ok: true, token: "token-incomplete" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  mock.tabs.sendMessageResult = { ok: false, error: "SEGMENTS_INCOMPLETE" };

  const response = await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: {
      url: "https://cdn.example.com/master.m3u8",
      sourcePageUrl: "https://site.example",
      title: "Incomplete",
      extension: "m3u8",
      kind: "hls",
      frameId: 0,
      tabId: 10,
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "SEGMENTS_INCOMPLETE");
});

test("DOWNLOADS_JOBS_CLEAR_MISSING calls the helper clear-missing endpoint", async () => {
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/jobs/clear-missing")) {
      return new Response(JSON.stringify({ ok: true, removedCount: 2 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_JOBS_CLEAR_MISSING,
  });

  assert.equal(response.ok, true);
  assert.equal(response.removedCount, 2);
});

test("DOWNLOADS_START for DASH goes directly to the helper", async () => {
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/download")) {
      return new Response(JSON.stringify({ ok: true, job: { id: "dash-job-1" } }), {
        status: 202, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: {
      url: "https://cdn.example.com/video.mpd",
      sourcePageUrl: "https://site.example",
      title: "DASH Stream",
      extension: "mpd",
      kind: "dash",
      frameId: 0,
      tabId: 10,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.helperJob.id, "dash-job-1");
  assert.equal(mock.tabs.sendMessageCalls.length, 0);
});
