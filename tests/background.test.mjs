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

  const sessionData = {};
  const sessionStorage = {
    async get(keys = null) {
      if (keys === null || keys === undefined) return { ...sessionData };
      const result = {};
      for (const key of [].concat(keys)) result[key] = sessionData[key];
      return result;
    },
    async set(obj) {
      Object.assign(sessionData, obj);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete sessionData[key];
    },
  };

  const mock = {
    data,
    sessionData,
    listeners,
    storage: { local: storage, session: sessionStorage },
    runtime: {
      id: "ext-id",
      onMessage: {
        addListener(fn) { listeners.onMessage = fn; },
      },
      // Messages the background sends to the offscreen document.
      async sendMessage(message) {
        mock.runtime.sentMessages.push(message);
        return mock.runtime.offscreenResponse;
      },
      async getContexts() { return mock.runtime.contexts; },
      sentMessages: [],
      offscreenResponse: { ok: true },
      contexts: [],
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
      TAB_ID_NONE: -1,
      async create(props) {
        mock.tabs.createCalls.push(props);
        return { id: 77, ...props };
      },
      createCalls: [],
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
      async update(tabId, props) {
        mock.tabs.updateCalls.push({ tabId, props });
        return { id: tabId, ...props };
      },
      async sendMessage(tabId, message, options) {
        mock.tabs.sendMessageCalls.push({ tabId, message, options });
        if (mock.tabs.sendMessageError) throw mock.tabs.sendMessageError;
        if (mock.tabs.sendMessageDeferred) {
          return mock.tabs.sendMessageDeferred.promise;
        }
        return mock.tabs.sendMessageResult;
      },
      tabsById: {},
      queryResult: [],
      sendMessageCalls: [],
      updateCalls: [],
      sendMessageResult: { ok: true },
      sendMessageError: null,
      sendMessageDeferred: null,
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
      for (const key of Object.keys(sessionData)) delete sessionData[key];
      mock.tabs.updateCalls = [];
      mock.tabs.createCalls = [];
      mock.runtime.sentMessages = [];
      mock.runtime.offscreenResponse = { ok: true };
      mock.runtime.contexts = [];
      delete mock.offscreen;
      delete mock.declarativeNetRequest;
      mock.tabs.queryResult = [];
      mock.tabs.tabsById = {};
      mock.tabs.sendMessageCalls = [];
      mock.tabs.sendMessageResult = { ok: true };
      mock.tabs.sendMessageError = null;
      mock.tabs.sendMessageDeferred = null;
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

test("concurrent MEDIA_ADD_DETECTED calls do not overwrite each other", async () => {
  const handler = mock.listeners.onMessage;
  assert.ok(handler);

  const call = (url) => new Promise((resolve) => {
    handler({
      type: MESSAGE.MEDIA_ADD_DETECTED,
      items: [{ url, sourcePageUrl: "https://site.example", title: url, extension: "mp4", kind: "direct" }],
    }, { tab: { id: 10, url: "https://site.example", title: "Site" }, frameId: 0 }, resolve);
  });

  await Promise.all([
    call("https://cdn.example.com/a.mp4"),
    call("https://cdn.example.com/b.mp4"),
    call("https://cdn.example.com/c.mp4"),
  ]);

  const stored = await mock.storage.local.get("tabMedia:10");
  const urls = stored["tabMedia:10"].map((item) => item.url).sort();
  assert.deepEqual(urls, [
    "https://cdn.example.com/a.mp4",
    "https://cdn.example.com/b.mp4",
    "https://cdn.example.com/c.mp4",
  ]);
});

test("MEDIA_GET_FOR_TAB enriches unknown direct media size from the page", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/video.mp4",
      url: "https://cdn.example.com/video.mp4",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Direct",
      extension: "mp4",
      kind: "direct",
      tabId: 10,
      frameId: 0,
      size: null,
      quality: "",
      detectedAt: 5,
      headers: [],
      variants: []
    }]
  });
  mock.tabs.sendMessageResult = { ok: true, size: 456789012 };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, totalBytes: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  const response = await sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  assert.equal(response.ok, true);
  assert.equal(response.items[0].size, 456789012);
  assert.equal(response.items[0].sizeSource, "exact");
});

test("MEDIA_GET_FOR_TAB falls back to helper for unknown direct media size", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/video.mp4",
      url: "https://cdn.example.com/video.mp4",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Direct",
      extension: "mp4",
      kind: "direct",
      tabId: 10,
      frameId: 0,
      size: null,
      quality: "",
      detectedAt: 5,
      headers: [{ name: "Cookie", value: "session=test" }],
      variants: []
    }]
  });
  mock.tabs.sendMessageResult = { ok: false, size: null };
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:8765/inspect");
    const body = JSON.parse(options.body);
    assert.equal(body.kind, "direct");
    assert.ok(body.headers.some((header) => header.name.toLowerCase() === "cookie"));
    return new Response(JSON.stringify({ ok: true, totalBytes: 765432100 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  assert.equal(response.ok, true);
  assert.equal(response.items[0].size, 765432100);
  assert.equal(response.items[0].sizeSource, "exact");
});

test("MEDIA_GET_FOR_TAB asks the helper for the resolution of unlabeled direct media", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/clip.mp4",
      url: "https://cdn.example.com/clip.mp4",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Direct",
      extension: "mp4",
      kind: "direct",
      tabId: 10,
      frameId: 0,
      size: 456789012,
      quality: "",
      detectedAt: 5,
      headers: [{ name: "Referer", value: "https://site.example/" }],
      variants: []
    }]
  });
  const probes = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:8765/probe-quality");
    probes.push(JSON.parse(options.body));
    return Response.json({ ok: true, width: 1920, height: 1080, quality: "1080p" });
  };

  const response = await sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  assert.equal(response.items[0].quality, "1080p");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].url, "https://cdn.example.com/clip.mp4");
  assert.ok(probes[0].headers.some((header) => header.name.toLowerCase() === "referer"));

  // Once labeled, the item is not probed again.
  await sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  assert.equal(probes.length, 1);
});

test("a resolution probe that never answers does not cost the size", async (t) => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/slow.mp4",
      url: "https://cdn.example.com/slow.mp4",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Slow",
      extension: "mp4",
      kind: "direct",
      tabId: 10,
      frameId: 0,
      size: null,
      quality: "",
      detectedAt: 5,
      headers: [],
      variants: []
    }]
  });
  mock.tabs.sendMessageResult = { ok: true, size: 456789012 };
  let probeStarted = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/probe-quality")) {
      probeStarted = true;
      return new Promise(() => {}); // ffprobe hangs
    }
    return Response.json({ ok: true, totalBytes: null });
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // Probed in parallel with the size, not after it.
  assert.equal(probeStarted, true);
  t.mock.timers.tick(8000);
  const response = await pending;

  assert.equal(response.items[0].size, 456789012);
  assert.equal(response.items[0].quality, "");
});

test("a probed HLS playlist also gets a size estimate from its quality", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/single.m3u8",
      url: "https://cdn.example.com/single.m3u8",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Single",
      extension: "m3u8",
      kind: "hls",
      tabId: 10,
      frameId: 0,
      quality: "",
      detectedAt: 5,
      headers: [],
      variants: []
    }]
  });
  // 100 s media playlist without RESOLUTION.
  mock.tabs.sendMessageResult = { ok: true, text: "#EXTM3U\n#EXTINF:100,\na.ts\n#EXT-X-ENDLIST" };
  globalThis.fetch = async () => Response.json({ ok: true, width: 1280, height: 720, quality: "720p" });

  const response = await sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });
  assert.equal(response.items[0].quality, "720p");
  assert.equal(response.items[0].estimatedSize, 35_000_000); // 100 s × 2.8 Mbps
  assert.equal(response.items[0].sizeSource, "estimated");
});

test("MEDIA_GET_FOR_TAB keeps same-title direct media with different URLs", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [
      {
        id: "https://site.example::https://cdn.example.com/a.mp4",
        url: "https://cdn.example.com/a.mp4",
        sourcePageUrl: "https://site.example",
        pageUrl: "https://site.example",
        title: "Same Title",
        extension: "mp4",
        kind: "direct",
        quality: "360p",
        size: 2 * 1024 * 1024,
        detectedAt: 3,
        headers: [],
        variants: []
      },
      {
        id: "https://site.example::https://cdn.example.com/b.mp4",
        url: "https://cdn.example.com/b.mp4",
        sourcePageUrl: "https://site.example",
        pageUrl: "https://site.example",
        title: "Same Title",
        extension: "mp4",
        kind: "direct",
        quality: "720p",
        size: 3 * 1024 * 1024,
        detectedAt: 2,
        headers: [],
        variants: []
      }
    ]
  });

  const response = await sendRuntimeMessage({
    type: "media:getForTab",
    tabId: 10,
  });
  assert.equal(response.ok, true);
  assert.equal(response.items.length, 2);
  assert.deepEqual(response.items.map((item) => item.url).sort(), [
    "https://cdn.example.com/a.mp4",
    "https://cdn.example.com/b.mp4"
  ]);
});

test("enrichment write-back merges with media detected during manifest inspection", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [{
      id: "https://site.example::https://cdn.example.com/master.m3u8",
      url: "https://cdn.example.com/master.m3u8",
      sourcePageUrl: "https://site.example",
      pageUrl: "https://site.example",
      title: "Stream",
      extension: "m3u8",
      kind: "hls",
      tabId: 10,
      frameId: 0,
      quality: "",
      detectedAt: 5,
      headers: [],
      variants: []
    }]
  });

  let releaseManifestFetch;
  mock.tabs.sendMessageDeferred = {
    promise: new Promise((resolve) => { releaseManifestFetch = resolve; })
  };

  const getPromise = sendRuntimeMessage({ type: "media:getForTab", tabId: 10 });

  // Wait until the manifest fetch is in flight, then detect a new video.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await sendRuntimeMessage(
    {
      type: MESSAGE.MEDIA_ADD_DETECTED,
      items: [{ url: "https://cdn.example.com/new.mp4", sourcePageUrl: "https://site.example", title: "New", extension: "mp4", kind: "direct" }]
    },
    { tab: { id: 10, url: "https://site.example", title: "Site" }, frameId: 0 }
  );

  releaseManifestFetch({ ok: false });
  const response = await getPromise;

  assert.equal(response.ok, true);
  const stored = await mock.storage.local.get("tabMedia:10");
  const urls = stored["tabMedia:10"].map((item) => item.url).sort();
  assert.deepEqual(urls, [
    "https://cdn.example.com/master.m3u8",
    "https://cdn.example.com/new.mp4"
  ]);
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.equal(stored["tabMedia:10"], undefined);
});

test("same-URL reload clears the previous page media", async () => {
  await mock.storage.local.set({ "tabMedia:10": [{ id: "old", title: "Old" }] });
  const handler = mock.listeners.onTabUpdated;
  assert.ok(handler, "tabs.onUpdated listener should be registered");
  handler(10, { status: "loading" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.equal(stored["tabMedia:10"], undefined);
});

test("network detection uses Content-Range total for 206 responses", async () => {
  const listener = mock.listeners.onHeadersReceived;
  assert.ok(listener, "webRequest.onHeadersReceived listener should be registered");
  listener({
    tabId: 10,
    requestId: "range-request",
    url: "https://cdn.example.com/video.mp4",
    type: "media",
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Range", value: "bytes 0-999/123456789" },
      { name: "Content-Length", value: "1000" },
    ],
    initiator: "https://site.example",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  const item = stored["tabMedia:10"]?.find((entry) => entry.url === "https://cdn.example.com/video.mp4");
  assert.equal(item.size, 123456789);
});

test("network detection keeps partial direct media when total size is unknown", async () => {
  const listener = mock.listeners.onHeadersReceived;
  listener({
    tabId: 10,
    requestId: "partial-without-total",
    url: "https://cdn.example.com/video.mp4",
    type: "media",
    statusCode: 206,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "102400" },
    ],
    initiator: "https://site.example",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  const item = stored["tabMedia:10"]?.find((entry) => entry.url === "https://cdn.example.com/video.mp4");
  assert.ok(item, "partial media should not be discarded by the minimum-size filter");
  assert.equal(item.size, null);
});

test("network detection keeps direct video with an image-like URL suffix", async () => {
  const listener = mock.listeners.onHeadersReceived;
  listener({
    tabId: 10,
    requestId: "disguised-direct",
    url: "https://cdn.example.com/video.jpg",
    type: "media",
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "123456789" },
    ],
    initiator: "https://site.example",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  const item = stored["tabMedia:10"]?.find((entry) => entry.url === "https://cdn.example.com/video.jpg");
  assert.equal(item.kind, "direct");
  assert.equal(item.extension, "mp4");
});

test("network detection keeps m3u8 URLs whose query contains an image extension", async () => {
  const listener = mock.listeners.onHeadersReceived;
  listener({
    tabId: 10,
    requestId: "m3u8-poster-request",
    url: "https://cdn.example.com/master.m3u8?poster=cover.jpg",
    type: "xmlhttprequest",
    responseHeaders: [{ name: "Content-Type", value: "application/vnd.apple.mpegurl" }],
    initiator: "https://site.example",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.ok(stored["tabMedia:10"]?.some((entry) => entry.url === "https://cdn.example.com/master.m3u8?poster=cover.jpg"));
});

test("page:clearMedia keepNetwork preserves network-detected media only", async () => {
  await mock.storage.local.set({
    "tabMedia:10": [
      { id: "dom-item", url: "https://cdn.example.com/dom.mp4", source: "dom", sourcePageUrl: "https://site.example", pageUrl: "https://site.example", title: "DOM", kind: "direct", extension: "mp4" },
      { id: "net-item", url: "https://cdn.example.com/net.mp4", source: "network", sourcePageUrl: "https://site.example", pageUrl: "https://site.example", title: "Net", kind: "direct", extension: "mp4" },
      { id: "main-item", url: "https://cdn.example.com/main.m3u8", source: "main", sourcePageUrl: "https://site.example", pageUrl: "https://site.example", title: "Main", kind: "hls", extension: "m3u8" }
    ]
  });

  const response = await sendRuntimeMessage(
    { type: "page:clearMedia", tabId: 10, keepNetwork: true },
    { tab: { id: 10, url: "https://site.example" } }
  );
  assert.equal(response.ok, true);
  const stored = await mock.storage.local.get("tabMedia:10");
  assert.deepEqual(stored["tabMedia:10"].map((item) => item.id).sort(), ["main-item", "net-item"]);
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

test("DOWNLOADS_START for DASH uses the browser download path like HLS", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ ok: true, token: "token-dash" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  mock.tabs.sendMessageResult = { ok: true, helperJob: { id: "dash-job-1" } };

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
  assert.equal(mock.tabs.sendMessageCalls.length, 1);
  assert.equal(mock.tabs.sendMessageCalls[0].message.type, "page:downloadStream");
  assert.equal(mock.tabs.sendMessageCalls[0].message.payload.manifestUrl, "https://cdn.example.com/video.mpd");
});

// ─── Active browser downloads: source-tab lifecycle ───

function mockHelperFetch(calls) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ ok: true, token: "token-life" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/browser-downloads\/[^/]+\/fail$/.test(String(url))) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function startTrackedHlsDownload(jobId) {
  mock.tabs.sendMessageResult = { ok: true, helperJob: { id: jobId } };
  return sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: {
      url: "https://cdn.example.com/master.m3u8",
      sourcePageUrl: "https://site.example",
      title: "Tracked",
      extension: "m3u8",
      kind: "hls",
      frameId: 0,
      tabId: 10,
    },
  });
}

function failCalls(calls) {
  return calls.filter((call) => /\/browser-downloads\/[^/]+\/fail$/.test(call.url));
}

test("a started HLS download keeps its source tab from being discarded", async () => {
  mockHelperFetch([]);
  const response = await startTrackedHlsDownload("job-keep");

  assert.equal(response.ok, true);
  assert.deepEqual(mock.tabs.updateCalls, [{ tabId: 10, props: { autoDiscardable: false } }]);
});

test("closing the source tab fails its active download as SOURCE_PAGE_CLOSED", async () => {
  const calls = [];
  mockHelperFetch(calls);
  await startTrackedHlsDownload("job-closed");

  await mock.listeners.onTabRemoved(99);
  assert.equal(failCalls(calls).length, 0, "other tabs must not affect the download");

  await mock.listeners.onTabRemoved(10);
  const fails = failCalls(calls);
  assert.equal(fails.length, 1);
  assert.ok(fails[0].url.endsWith("/browser-downloads/job-closed/fail"));
  assert.equal(JSON.parse(fails[0].options.body).error, "SOURCE_PAGE_CLOSED");
});

test("page:streamInterrupted reports SOURCE_PAGE_CLOSED for that job", async () => {
  const calls = [];
  mockHelperFetch(calls);
  await startTrackedHlsDownload("job-hidden");

  const response = await sendRuntimeMessage(
    { type: "page:streamInterrupted", jobId: "job-hidden" },
    { tab: { id: 10 }, frameId: 0 }
  );

  assert.equal(response.ok, true);
  const fails = failCalls(calls);
  assert.equal(fails.length, 1);
  assert.ok(fails[0].url.endsWith("/browser-downloads/job-hidden/fail"));
  assert.equal(JSON.parse(fails[0].options.body).error, "SOURCE_PAGE_CLOSED");
});

test("page:streamFinished restores discarding and stops tracking the job", async () => {
  const calls = [];
  mockHelperFetch(calls);
  await startTrackedHlsDownload("job-done");

  await sendRuntimeMessage(
    { type: "page:streamFinished", jobId: "job-done" },
    { tab: { id: 10 }, frameId: 0 }
  );
  await mock.listeners.onTabRemoved(10);

  assert.deepEqual(mock.tabs.updateCalls.at(-1), { tabId: 10, props: { autoDiscardable: true } });
  assert.equal(failCalls(calls).length, 0);
});

test("HELPER_STATUS_GET includes the helper's total job count in stats", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true, downloadDir: "D:/Videos" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/jobs?")) {
      return new Response(JSON.stringify({
        ok: true,
        jobs: [{ id: "a", status: "completed" }],
        total: 37,
        stats: { active: 0, completed: 30, failed: 7, downloadedBytes: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await sendRuntimeMessage({ type: "helper:statusGet" });

  assert.equal(response.stats.total, 37);
  assert.equal(response.stats.active, 0);
});

// ─── Extension mode: offscreen document + header-replay rules ───

function enableOffscreen() {
  const state = { created: [], rules: [] };
  mock.offscreen = {
    Reason: { BLOBS: "BLOBS" },
    async createDocument(options) {
      state.created.push(options);
      mock.runtime.contexts = [{ contextType: "OFFSCREEN_DOCUMENT" }];
    },
  };
  mock.declarativeNetRequest = {
    async updateSessionRules({ addRules = [], removeRuleIds = [] }) {
      state.rules = state.rules.filter((rule) => !removeRuleIds.includes(rule.id));
      state.rules.push(...addRules);
    },
    async getSessionRules(filter = {}) {
      return filter.ruleIds ? state.rules.filter((rule) => filter.ruleIds.includes(rule.id)) : [...state.rules];
    },
  };
  return state;
}

const HLS_ITEM = {
  url: "https://cdn.example.com/master.m3u8",
  sourcePageUrl: "https://site.example",
  title: "Stream",
  extension: "m3u8",
  kind: "hls",
  frameId: 0,
  tabId: 10,
};

function captureHeaders(url, headers) {
  mock.listeners.onBeforeSendHeaders({
    requestId: `req-${url}`,
    url,
    requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  });
}

function offscreenStarts() {
  return mock.runtime.sentMessages.filter((m) => m.type === "offscreen:downloadStream");
}

test("HLS downloads prefer the offscreen document with a header-replay rule", async () => {
  const state = enableOffscreen();
  captureHeaders(HLS_ITEM.url, {
    Referer: "https://site.example/watch",
    Origin: "https://site.example",
    Cookie: "sid=abc",
  });
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-off" } };

  const response = await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });

  assert.equal(response.ok, true);
  assert.equal(response.helperJob.id, "job-off");
  assert.equal(response.mode, "extension");
  assert.equal(mock.tabs.sendMessageCalls.length, 0, "page mode is not used");
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].url, "src/offscreen.html");

  const [start] = offscreenStarts();
  assert.equal(start.target, "offscreen");
  assert.equal(start.payload.manifestUrl, HLS_ITEM.url);
  assert.equal(state.rules.length, 1);
  const [rule] = state.rules;
  assert.equal(start.payload.ruleId, rule.id);
  assert.deepEqual(rule.condition.requestDomains, ["cdn.example.com"]);
  assert.deepEqual(rule.condition.tabIds, [-1], "only requests made outside tabs");
  const set = Object.fromEntries(rule.action.requestHeaders.map((h) => [h.header, h.value]));
  assert.deepEqual(set, { referer: "https://site.example/watch", origin: "https://site.example", cookie: "sid=abc" });
  assert.equal(mock.tabs.updateCalls.length, 0, "the source tab may still be discarded");
});

test("without captured headers the rule falls back to the source page as referer and origin", async () => {
  const state = enableOffscreen();
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-plain" } };

  await sendRuntimeMessage({
    type: MESSAGE.DOWNLOADS_START,
    item: { ...HLS_ITEM, url: "https://other-cdn.example/x/master.m3u8", sourcePageUrl: "https://site.example/watch/9" },
  });

  const set = Object.fromEntries(state.rules[0].action.requestHeaders.map((h) => [h.header, h.value]));
  assert.deepEqual(set, { referer: "https://site.example/watch/9", origin: "https://site.example" });
});

test("a refused offscreen start falls back to the page and drops the rule", async () => {
  const state = enableOffscreen();
  mockHelperFetch([]);
  mock.runtime.offscreenResponse = { ok: false, error: "BROWSER_BLOCKED: HTTP 403", blocked: true };
  mock.tabs.sendMessageResult = { ok: true, helperJob: { id: "job-page" } };

  const response = await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });

  assert.equal(response.ok, true);
  assert.equal(response.helperJob.id, "job-page");
  assert.equal(response.mode, "page");
  assert.equal(mock.tabs.sendMessageCalls.length, 1);
  assert.equal(state.rules.length, 0);
});

test("DRM reported by the offscreen document is final", async () => {
  enableOffscreen();
  mock.runtime.offscreenResponse = { ok: false, error: "DRM_PROTECTED_UNSUPPORTED" };

  const response = await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });

  assert.equal(response.error, "DRM_PROTECTED_UNSUPPORTED");
  assert.equal(mock.tabs.sendMessageCalls.length, 0);
});

test("offscreen:allowHosts adds segment hosts to the job's rule", async () => {
  const state = enableOffscreen();
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-hosts" } };
  await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });
  const ruleId = state.rules[0].id;

  const response = await sendRuntimeMessage({
    type: "offscreen:allowHosts",
    ruleId,
    hosts: ["seg1.example.net", "cdn.example.com"],
  });

  assert.equal(response.ok, true);
  assert.equal(state.rules.length, 1);
  assert.deepEqual([...state.rules[0].condition.requestDomains].sort(), ["cdn.example.com", "seg1.example.net"]);
});

test("a blocked offscreen download hands the remaining segments to the page", async () => {
  const state = enableOffscreen();
  mockHelperFetch([]);
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-handoff" } };
  await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });
  mock.tabs.sendMessageResult = { ok: true, helperJob: { id: "job-handoff" }, resumed: true };

  await sendRuntimeMessage({
    type: "offscreen:finished",
    jobId: "job-handoff",
    outcome: { status: "blocked", error: "BROWSER_BLOCKED: HTTP 403" },
  });

  assert.equal(state.rules.length, 0);
  assert.equal(mock.tabs.sendMessageCalls.length, 1);
  assert.equal(mock.tabs.sendMessageCalls[0].message.type, "page:downloadStream");
  assert.equal(mock.tabs.sendMessageCalls[0].message.payload.manifestUrl, HLS_ITEM.url);
  assert.deepEqual(mock.tabs.updateCalls.at(-1), { tabId: 10, props: { autoDiscardable: false } });
});

test("a completed offscreen download only drops its rule", async () => {
  const state = enableOffscreen();
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-ok" } };
  await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });

  await sendRuntimeMessage({ type: "offscreen:finished", jobId: "job-ok", outcome: { status: "completed" } });

  assert.equal(state.rules.length, 0);
  assert.equal(mock.tabs.sendMessageCalls.length, 0);
});

test("closing the source tab does not stop an offscreen download", async () => {
  const calls = [];
  mockHelperFetch(calls);
  enableOffscreen();
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-bg" } };
  await sendRuntimeMessage({ type: MESSAGE.DOWNLOADS_START, item: HLS_ITEM });

  await mock.listeners.onTabRemoved(10);

  assert.equal(failCalls(calls).length, 0);
});

// ─── Resume button ───

function mockHelperJob(job, calls = []) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith(`/jobs/${job.id}`)) {
      return new Response(JSON.stringify(job), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/auth")) {
      return new Response(JSON.stringify({ ok: true, token: "token-resume" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const RESUMABLE_JOB = {
  id: "job-r",
  status: "failed",
  resumable: true,
  inputMode: "browser",
  url: "https://cdn.example.com/v/720.m3u8?token=old",
  sourcePageUrl: "https://site.example",
  outputPath: "D:/Videos/Movie-1a2b3c4d.mp4",
};

test("DOWNLOADS_JOB_RESUME restarts a resumable job from its stored stream", async () => {
  enableOffscreen();
  mockHelperJob(RESUMABLE_JOB);
  mock.runtime.offscreenResponse = { ok: true, helperJob: { id: "job-r" }, resumed: true };

  const response = await sendRuntimeMessage({ type: "downloads:jobResume", jobId: "job-r" });

  assert.equal(response.ok, true);
  assert.equal(response.resumed, true);
  const [start] = offscreenStarts();
  assert.equal(start.payload.manifestUrl, RESUMABLE_JOB.url);
  assert.equal(start.payload.sourcePageUrl, RESUMABLE_JOB.sourcePageUrl);
});

test("DOWNLOADS_JOB_RESUME opens the source page when no browser path works, never the helper", async () => {
  const calls = [];
  enableOffscreen();
  mockHelperJob(RESUMABLE_JOB, calls);
  mock.runtime.offscreenResponse = { ok: false, error: "BROWSER_BLOCKED: HTTP 403", blocked: true };
  mock.tabs.queryResult = [];
  mock.tabs.tabsById = {};

  const response = await sendRuntimeMessage({ type: "downloads:jobResume", jobId: "job-r" });

  assert.equal(response.ok, false);
  assert.equal(response.error, "SOURCE_PAGE_OPENED");
  assert.deepEqual(mock.tabs.createCalls, [{ url: "https://site.example" }]);
  assert.equal(calls.filter((c) => c.url.endsWith("/download")).length, 0, "no helper-direct fallback");
});

test("DOWNLOADS_JOB_RESUME refuses a job that is not resumable", async () => {
  mockHelperJob({ ...RESUMABLE_JOB, resumable: false });

  const response = await sendRuntimeMessage({ type: "downloads:jobResume", jobId: "job-r" });

  assert.equal(response.ok, false);
  assert.equal(response.error, "JOB_NOT_RESUMABLE");
});
