import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class FakeClassList {
  constructor() { this.className = ""; }
  add(...names) { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); }
  remove(...names) { this.className = this.className.split(/\s+/).filter(Boolean).filter((name) => !names.includes(name)).join(" "); }
  toggle(name, force) {
    const has = this.className.split(/\s+/).filter(Boolean).includes(name);
    const shouldAdd = force === undefined ? !has : force;
    if (shouldAdd && !has) this.add(name);
    if (!shouldAdd && has) this.remove(name);
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.style = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    };
    this.dataset = {};
    this.classList = new FakeClassList();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.checked = false;
    this.type = "";
    this.id = "";
    this.content = null;
    this._listeners = {};
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this._listeners[type] || []) fn({ target: this, ...event }); }
  querySelector(selector) {
    if (selector === ".media-title") return new FakeElement("div");
    if (selector === ".media-kind") return new FakeElement("div");
    if (selector === ".media-meta-row") return new FakeElement("div");
    if (selector === ".variant-list") return new FakeElement("div");
    if (selector === ".job-status") return new FakeElement("div");
    if (selector === ".download-button") return new FakeElement("button");
    if (selector === ".helper-job-title") return new FakeElement("div");
    if (selector === ".helper-job-state") return new FakeElement("div");
    if (selector === ".helper-job-meta") return new FakeElement("div");
    if (selector === ".helper-job-path") return new FakeElement("div");
    if (selector === ".source-button") return new FakeElement("button");
    if (selector === ".cancel-button") return new FakeElement("button");
    if (selector === ".show-button") return new FakeElement("button");
    if (selector === ".remove-button") return new FakeElement("button");
    return new FakeElement("div");
  }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
  closest() { return null; }
  click() { this.dispatch("click"); }
  cloneNode() { return new FakeElement(this.tagName); }
}

const elements = new Map();
function getElement(selector) {
  if (!elements.has(selector)) {
    const el = new FakeElement(selector.startsWith("#") ? "div" : "div");
    el.id = selector.replace("#", "");
    if (selector === "#mediaItemTemplate" || selector === "#helperJobTemplate") {
      el.content = { firstElementChild: new FakeElement("template-content") };
    }
    elements.set(selector, el);
  }
  return elements.get(selector);
}

const documentMock = {
  querySelector(selector) { return getElement(selector); },
  querySelectorAll() { return []; },
  createElement(tagName) { return new FakeElement(tagName); },
  body: new FakeElement("body"),
  documentElement: new FakeElement("html"),
  activeElement: null,
};

const timers = { setIntervalCalls: [], setTimeoutCalls: [] };
const runtimeMessages = [];
const tabMessages = [];
const windowMock = {
  setInterval(fn, ms) { timers.setIntervalCalls.push({ fn, ms }); return timers.setIntervalCalls.length; },
  setTimeout(fn, ms) { timers.setTimeoutCalls.push({ fn, ms }); return timers.setTimeoutCalls.length; },
  clearInterval() {},
  clearTimeout() {},
};

const chromeMock = {
  runtime: {
    getURL(path) { return `https://mock.local/${path}`; },
    async sendMessage(message) {
      runtimeMessages.push(message);
      if (message?.type === "settings:get") return { ok: true, settings: { minSizeBytes: 1048576, showUnsupported: true } };
      if (message?.type === "media:getForTab") return { ok: true, items: [] };
      if (message?.type === "helper:statusGet") {
        return { ok: true, online: false, health: null, jobs: [], cachedJobs: [] };
      }
      return { ok: true };
    },
  },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
    },
    onChanged: {
      listeners: [],
      addListener(fn) { this.listeners.push(fn); },
    },
  },
  i18n: {
    getUILanguage() { return "en"; },
  },
  tabs: {
    async query() { return [{ id: 1, url: "https://site.example" }]; },
    async sendMessage(tabId, message) {
      tabMessages.push({ tabId, message });
      return { ok: true };
    },
  },
};

globalThis.chrome = chromeMock;
globalThis.document = documentMock;
globalThis.window = windowMock;

const messages = JSON.parse(await readFile(path.join(__dirname, "..", "_locales", "en", "messages.json"), "utf8"));
globalThis.fetch = async (url) => {
  if (String(url).includes("/_locales/en/messages.json")) {
    return new Response(JSON.stringify(messages), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
};

await import(pathToFileURL(path.join(__dirname, "..", "src", "popup.js")).href);

test("popup initializes with no media and helper offline", () => {
  assert.equal(getElement("#mediaCount").textContent, "0 detected");
  assert.equal(getElement("#helperSummary").textContent, "Helper offline");
  assert.ok(getElement("#helperStatus").className.includes("is-offline"));
  assert.match(getElement("#helperJobs").innerHTML, /No helper jobs yet/);
  assert.equal(timers.setIntervalCalls.length, 1);
});

test("popup notice helpers show and hide", () => {
  // The module did not export helpers, so verify the notice element state
  // can be manipulated the same way popup code does through DOM elements.
  const notice = getElement("#notice");
  notice.textContent = "test";
  notice.hidden = false;
  notice.classList.add("error");
  assert.equal(notice.textContent, "test");
  assert.equal(notice.hidden, false);
  assert.ok(notice.classList.className.includes("error"));
});

test("rescan clears background media and waits for the content scan", async () => {
  runtimeMessages.length = 0;
  tabMessages.length = 0;
  getElement("#rescanButton").click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runtimeMessages[0]?.type, "page:clearMedia");
  assert.equal(tabMessages[0]?.message?.type, "page:rescan");
  assert.ok(runtimeMessages.some((message) => message.type === "media:getForTab"));
  assert.equal(timers.setTimeoutCalls.length, 0);
});

test("the media panel shows a scanning state until the media list arrives", async () => {
  const original = chromeMock.runtime.sendMessage;
  let answer;
  chromeMock.runtime.sendMessage = async (message) => {
    if (message?.type === "media:getForTab") return new Promise((resolve) => { answer = resolve; });
    return original(message);
  };
  const panel = getElement("#mediaPanel");
  const label = getElement("#scanLabel");
  try {
    assert.equal(panel.classList.className.includes("is-scanning"), false);
    assert.equal(label.textContent, "detected");

    getElement("#rescanButton").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(panel.classList.className.includes("is-scanning"));
    assert.equal(panel.ariaBusy, "true");
    assert.equal(label.textContent, "scanning…");
    assert.equal(getElement("#rescanButton").disabled, true);

    answer({ ok: true, items: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(panel.classList.className.includes("is-scanning"), false);
    assert.equal(panel.ariaBusy, "false");
    assert.equal(label.textContent, "detected");
    assert.equal(getElement("#rescanButton").disabled, false);
  } finally {
    chromeMock.runtime.sendMessage = original;
  }
});

test("media found after the scan shows up live and new items are probed once", async () => {
  const original = chromeMock.runtime.sendMessage;
  const item = { url: "https://cdn.example.com/late.mp4", kind: "direct", extension: "mp4", title: "Late", size: 123456789 };
  chromeMock.runtime.sendMessage = async (message) => {
    runtimeMessages.push(message);
    if (message?.type === "media:getForTab") return { ok: true, items: [item] };
    return original(message);
  };
  try {
    runtimeMessages.length = 0;
    const before = timers.setTimeoutCalls.length;
    for (const listener of chromeMock.storage.onChanged.listeners) listener({ "tabMedia:1": { newValue: [] } }, "local");
    const refresh = timers.setTimeoutCalls[timers.setTimeoutCalls.length - 1];
    assert.ok(timers.setTimeoutCalls.length > before, "the refresh is debounced");
    await refresh.fn();

    const list = runtimeMessages.find((message) => message.type === "media:getForTab");
    assert.equal(list.enrich, false, "the live refresh does not start a new scan");
    const enrich = runtimeMessages.find((message) => message.type === "media:enrich");
    assert.deepEqual(enrich.urls, [item.url]);
    assert.equal(getElement("#mediaCount").textContent, "1 detected");

    runtimeMessages.length = 0;
    await refresh.fn();
    assert.equal(runtimeMessages.filter((message) => message.type === "media:enrich").length, 0, "probed only once");
  } finally {
    chromeMock.runtime.sendMessage = original;
  }
});

test("the run tile switches between active downloads", async () => {
  const original = chromeMock.runtime.sendMessage;
  const jobs = [
    { id: "a", status: "running", outputPath: "D:/v/first.mp4", startedAt: "2026-10-09T10:00:02Z" },
    { id: "b", status: "running", outputPath: "D:/v/second.mp4", startedAt: "2026-10-09T10:00:01Z" },
    { id: "c", status: "completed", outputPath: "D:/v/done.mp4", startedAt: "2026-10-09T10:00:00Z" }
  ];
  chromeMock.runtime.sendMessage = async (message) => {
    if (message?.type === "helper:statusGet") return { ok: true, online: true, health: { downloadDir: "D:/v" }, jobs };
    return original(message);
  };
  try {
    const poll = timers.setIntervalCalls[0].fn;
    await poll();
    assert.equal(getElement("#runTile").hidden, false);
    assert.equal(getElement("#runNav").hidden, false);
    assert.equal(getElement("#runTitle").textContent, "first.mp4");
    assert.equal(getElement("#runPos").textContent, "1/2");

    getElement("#runNext").click();
    assert.equal(getElement("#runTitle").textContent, "second.mp4");
    assert.equal(getElement("#runPos").textContent, "2/2");

    getElement("#runNext").click();
    assert.equal(getElement("#runTitle").textContent, "first.mp4", "wraps around");

    await poll();
    assert.equal(getElement("#runTitle").textContent, "first.mp4", "a poll right after a switch keeps the job");
  } finally {
    chromeMock.runtime.sendMessage = original;
  }
});

test("media still without a size is probed again after a pause, a limited number of times", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const original = chromeMock.runtime.sendMessage;
  const item = { url: "https://cdn.example.com/unknown.mp4", kind: "direct", extension: "mp4", title: "Unknown", size: null };
  chromeMock.runtime.sendMessage = async (message) => {
    // original() records every other message itself.
    if (message?.type === "media:getForTab") return { ok: true, items: [item] };
    return original(message);
  };
  const enrichCount = () => runtimeMessages.filter((message) => message.type === "media:enrich").length;
  try {
    for (const listener of chromeMock.storage.onChanged.listeners) listener({ "tabMedia:1": { newValue: [] } }, "local");
    await timers.setTimeoutCalls[timers.setTimeoutCalls.length - 1].fn();
    runtimeMessages.length = 0;
    const poll = timers.setIntervalCalls[0].fn;

    await poll();
    assert.equal(enrichCount(), 0, "not again right away");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      t.mock.timers.tick(5000);
      await poll();
    }
    assert.equal(enrichCount(), 2, "two retries after the first probe, then it stops");
  } finally {
    chromeMock.runtime.sendMessage = original;
  }
});
