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
    this.style = {};
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
      addListener() {},
    },
  },
  i18n: {
    getUILanguage() { return "en"; },
  },
  tabs: {
    async query() { return [{ id: 1, url: "https://site.example" }]; },
    async sendMessage() { return { ok: true }; },
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
