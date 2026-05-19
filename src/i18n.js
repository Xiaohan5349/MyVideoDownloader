const USER_LANGUAGE_KEY = "userLanguage";
let messages = new Map();

async function loadLocale(locale) {
  try {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const response = await fetch(url);
    const data = await response.json();
    const map = new Map();
    for (const [key, entry] of Object.entries(data)) {
      map.set(key, entry.message || key);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function initI18n() {
  const result = await chrome.storage.local.get(USER_LANGUAGE_KEY);
  const lang = result[USER_LANGUAGE_KEY] || chrome.i18n.getUILanguage() || "en";
  const locale = lang.startsWith("zh") ? "zh_CN" : "en";
  messages = await loadLocale(locale);
  document.documentElement.lang = locale === "zh_CN" ? "zh-CN" : "en";
}

export async function getUserLanguage() {
  const result = await chrome.storage.local.get(USER_LANGUAGE_KEY);
  return result[USER_LANGUAGE_KEY] || chrome.i18n.getUILanguage() || "en";
}

export async function setUserLanguage(lang) {
  await chrome.storage.local.set({ [USER_LANGUAGE_KEY]: lang });
}

export function getMessage(key, subs = {}) {
  let message = messages.get(key) || key;
  message = message.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return name in subs ? String(subs[name]) : "";
  });
  return message;
}

export async function applyLanguageUI(root = document) {
  await initI18n();
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = getMessage(key);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const key = el.getAttribute("data-i18n-title");
    if (key) el.title = getMessage(key);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.placeholder = getMessage(key);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    const key = el.getAttribute("data-i18n-aria");
    if (key) el.setAttribute("aria-label", getMessage(key));
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[USER_LANGUAGE_KEY]) return;
  applyLanguageUI().catch(() => {});
});
