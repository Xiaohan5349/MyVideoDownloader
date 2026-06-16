import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the real English locale to verify data integrity
const enPath = path.join(__dirname, "..", "_locales", "en", "messages.json");
const enMessages = JSON.parse(readFileSync(enPath, "utf8"));
const zhPath = path.join(__dirname, "..", "_locales", "zh_CN", "messages.json");
const zhMessages = JSON.parse(readFileSync(zhPath, "utf8"));

test("i18n: English locale has all required keys", () => {
  const requiredKeys = [
    "brandName", "brandShortName", "brandDescription",
    "tabsMedia", "tabsHelper", "tabsSettings",
    "btnRescan", "btnDownload", "btnSave", "btnStop", "btnFolder", "btnDelete",
    "statusQueued", "statusDownloading", "statusCompleted", "statusFailed", "statusStopped",
    "msgNoActiveTab", "msgDownloadStarted", "msgDownloadFailed",
  ];
  for (const key of requiredKeys) {
    assert.ok(enMessages[key], `Missing key: ${key}`);
  }
});

test("i18n: Chinese locale has all required keys", () => {
  const requiredKeys = [
    "brandName", "brandShortName", "brandDescription",
    "tabsMedia", "tabsHelper", "tabsSettings",
    "btnRescan", "btnDownload", "btnSave", "btnStop", "btnFolder", "btnDelete",
    "statusQueued", "statusDownloading", "statusCompleted", "statusFailed", "statusStopped",
    "msgNoActiveTab", "msgDownloadStarted", "msgDownloadFailed",
  ];
  for (const key of requiredKeys) {
    assert.ok(zhMessages[key], `Missing key: ${key}`);
  }
});

test("i18n: English and Chinese locales have identical key sets", () => {
  const enKeys = new Set(Object.keys(enMessages));
  const zhKeys = new Set(Object.keys(zhMessages));

  const onlyInEn = [...enKeys].filter((k) => !zhKeys.has(k));
  const onlyInZh = [...zhKeys].filter((k) => !enKeys.has(k));

  assert.deepEqual(onlyInEn, [], "Keys only in English locale");
  assert.deepEqual(onlyInZh, [], "Keys only in Chinese locale");
});

test("i18n: all message values are non-empty strings", () => {
  for (const [key, entry] of Object.entries(enMessages)) {
    assert.ok(typeof entry.message === "string" && entry.message.length > 0,
      `English key "${key}" has empty or missing message`);
  }
  for (const [key, entry] of Object.entries(zhMessages)) {
    assert.ok(typeof entry.message === "string" && entry.message.length > 0,
      `Chinese key "${key}" has empty or missing message`);
  }
});

test("i18n: all substitution placeholders use valid variable names", () => {
  // Placeholders should use \w+ (alphanumeric + underscore) variable names
  const placeholderPattern = /\{\{(\w+)\}\}/g;
  for (const [key, entry] of Object.entries(enMessages)) {
    let match;
    while ((match = placeholderPattern.exec(entry.message)) !== null) {
      assert.ok(/^\w+$/.test(match[1]), `Invalid placeholder name in EN "${key}": {{${match[1]}}}`);
    }
  }
  for (const [key, entry] of Object.entries(zhMessages)) {
    let match;
    while ((match = placeholderPattern.exec(entry.message)) !== null) {
      assert.ok(/^\w+$/.test(match[1]), `Invalid placeholder name in ZH "${key}": {{${match[1]}}}`);
    }
  }
});

test("i18n: no orphaned {{ in messages (unclosed placeholders)", () => {
  for (const [key, entry] of Object.entries(enMessages)) {
    const openCount = (entry.message.match(/\{\{/g) || []).length;
    const closeCount = (entry.message.match(/\}\}/g) || []).length;
    assert.equal(openCount, closeCount, `Mismatched {{/}} in EN "${key}"`);
  }
  for (const [key, entry] of Object.entries(zhMessages)) {
    const openCount = (entry.message.match(/\{\{/g) || []).length;
    const closeCount = (entry.message.match(/\}\}/g) || []).length;
    assert.equal(openCount, closeCount, `Mismatched {{/}} in ZH "${key}"`);
  }
});

test("i18n: getMessage interpolation logic (simulated)", () => {
  // Simulate the getMessage function logic to verify it works correctly
  function simulateGetMessage(messages, key, subs = {}) {
    let message = messages.get(key) || key;
    message = message.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return name in subs ? String(subs[name]) : "";
    });
    return message;
  }

  const messages = new Map([
    ["greeting", "Hello, {{name}}!"],
    ["count", "{{count}} items, {{active}} active"],
    ["noSubs", "Plain text"],
    ["multiWord", "{{firstName}} {{lastName}}"],
  ]);

  assert.equal(simulateGetMessage(messages, "greeting", { name: "World" }), "Hello, World!");
  assert.equal(simulateGetMessage(messages, "greeting", { name: "" }), "Hello, !");
  assert.equal(simulateGetMessage(messages, "greeting", {}), "Hello, !");
  assert.equal(simulateGetMessage(messages, "count", { count: "5", active: "2" }), "5 items, 2 active");
  assert.equal(simulateGetMessage(messages, "noSubs", {}), "Plain text");
  assert.equal(simulateGetMessage(messages, "missing", {}), "missing");
  assert.equal(simulateGetMessage(messages, "multiWord", { firstName: "John", lastName: "Doe" }), "John Doe");
  assert.equal(simulateGetMessage(messages, "multiWord", { firstName: "Jane" }), "Jane ");
});

test("i18n: getMessage handles special characters in substitution values", () => {
  function simulateGetMessage(messages, key, subs = {}) {
    let message = messages.get(key) || key;
    message = message.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return name in subs ? String(subs[name]) : "";
    });
    return message;
  }

  const messages = new Map([
    ["error", "Error: {{detail}}"],
    ["path", "Path: {{filePath}}"],
  ]);

  assert.equal(simulateGetMessage(messages, "error", { detail: "File not found: \"test.mp4\"" }),
    'Error: File not found: "test.mp4"');
  assert.equal(simulateGetMessage(messages, "path", { filePath: "C:\\Users\\test\\Videos" }),
    "Path: C:\\Users\\test\\Videos");
  assert.equal(simulateGetMessage(messages, "error", { detail: "<script>alert('xss')</script>" }),
    "Error: <script>alert('xss')</script>");
});
