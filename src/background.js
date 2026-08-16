import {
  MESSAGE, addUniqueMedia, classifyMedia, DIRECT_EXTENSIONS,
  estimateBytes, fallbackBandwidthForQuality, isSegmentFile, mergeSettings,
  normalizeMediaItem, parseDashManifest, parseHlsManifest, sanitizeFilename
} from "./shared.js";

console.log("[ds] Service worker started v1.6.1");

const SETTINGS_KEY = "settings";
const TAB_MEDIA_PREFIX = "tabMedia:";
const HELPER_URL = "http://127.0.0.1:8765";
const DEBUG = true;

// Clear all stale tab media on startup (old data from previous versions)
chrome.storage.local.get(null).then((all) => {
  const keys = Object.keys(all).filter((k) => k.startsWith(TAB_MEDIA_PREFIX));
  if (keys.length) {
    chrome.storage.local.remove(keys);
    console.log("[ds] Cleared", keys.length, "stale tab caches");
  }
});

const requestHeadersById = new Map();
const requestHeadersByUrl = new Map();
const MAX_CAPTURED_HEADERS = 500;

// --- Message routing ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

// --- webRequest: capture headers ---

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => { rememberRequestHeaders(details); },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

// --- webRequest: detect media from network requests ---

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    detectFromNetwork(details).catch((error) => {
      console.warn("[ds-video-downloader] network detection failed", error);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object", "sub_frame"] },
  ["responseHeaders", "extraHeaders"]
);

// Cleanup stale tab data
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(tabKey(tabId));
});

// Full-page navigation destroys the old content script before it can send
// page:clearMedia. Clear tab media when the main frame starts loading a new
// URL; same-document navigations are still handled by the content script.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    chrome.storage.local.remove(tabKey(tabId));
  }
});

// --- Message handler ---

async function handleMessage(message, sender) {
  if (DEBUG) console.warn("[ds] handleMessage type=", message?.type);
  if (!message || typeof message !== "object") return { ok: false, error: "INVALID_MESSAGE" };

  // Content script navigation — clear stale data
  if (message.type === "page:clearMedia") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      await chrome.storage.local.remove(tabKey(tabId));
    }
    return { ok: true };
  }

  if (message.type === MESSAGE.MEDIA_ADD_DETECTED) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") return { ok: false, error: "TAB_ID_MISSING" };
    const frameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : null;
    const items = (message.items || []).map((item) => ({
      ...item,
      frameId,
      tabId,
      pageUrl: sender.tab?.url || message.pageUrl || ""
    }));
    await addMedia(tabId, items, {
      sourcePageUrl: sender.tab?.url || message.sourcePageUrl || "",
      title: sender.tab?.title || message.title || "video"
    });
    return { ok: true };
  }

  if (message.type === MESSAGE.MEDIA_GET_FOR_TAB) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") return { ok: false, error: "TAB_ID_MISSING" };
    const settings = await getSettings();
    const items = await enrichMediaForTab(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return {
      ok: true,
      items: items.filter((item) => shouldKeepMedia(item, settings) && mediaMatchesTab(item, tab?.url || ""))
    };
  }

  if (message.type === MESSAGE.DOWNLOADS_START) {
    return startDownload(message.item, message.variant);
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_GET) return getHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_SHOW) return showHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_DELETE) return deleteHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_FORGET) return forgetHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_CANCEL) return cancelHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOBS_CLEAR_MISSING) return clearMissingHelperJobs();
  if (message.type === MESSAGE.HELPER_STATUS_GET) return getHelperStatus();
  if (message.type === MESSAGE.HELPER_SETTINGS_UPDATE) return updateHelperSettings(message.settings || {});
  if (message.type === MESSAGE.HELPER_FOLDER_PICK) return pickHelperFolder();
  if (message.type === MESSAGE.STREAM_VARIANTS_GET) return getStreamVariants(message.item);
  if (message.type === MESSAGE.SETTINGS_GET) return { ok: true, settings: await getSettings() };

  if (message.type === MESSAGE.SETTINGS_UPDATE) {
    const settings = mergeSettings({ ...(await getSettings()), ...(message.settings || {}) });
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { ok: true, settings };
  }

  return { ok: false, error: "UNKNOWN_MESSAGE" };
}

// --- Network detection ---

async function detectFromNetwork(details) {
  if (details.tabId < 0) return;

  const url = details.url;

  // Skip internal helper traffic
  if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return;

  // Skip analytics, telemetry, logging, CDN assets
  if (/\/log\/|analytics|telemetry|tracker|pixel|beacon|cdn\.plyr|\.svg|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.css|\.js(?:\?|$)/i.test(url)) return;

  const contentType = headerValue(details.responseHeaders, "content-type");

  // Skip HLS/DASH segment files aggressively
  if (isSegmentFile(url, contentType)) return;

  // .ts files from webRequest are ALWAYS HLS segments — never useful standalone
  if (/\.ts(?:[?#]|$)/i.test(url.split("?")[0])) return;

  if (DEBUG) console.warn("[ds] detectFromNetwork url=", url.slice(0, 120), "type=", details.type);

  let classified = classifyMedia(url, contentType);

  // URL-pattern fallback for cases where content-type is missing
  if (!classified) {
    const lower = url.toLowerCase().split("?")[0];
    if (/\.m3u8$/.test(lower)) classified = { extension: "m3u8", kind: "hls" };
    else if (/\.mpd$/.test(lower)) classified = { extension: "mpd", kind: "dash" };
  }

  if (!classified) return;

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  if (!tab) return;

  const item = normalizeMediaItem({
    url,
    sourcePageUrl: tab.url || details.initiator || "",
    title: tab.title || "video",
    extension: classified.extension,
    kind: classified.kind,
    frameId: Number.isInteger(details.frameId) && details.frameId >= 0 ? details.frameId : null,
    tabId: details.tabId,
    pageUrl: tab.url || "",
    size: numberHeader(details.responseHeaders, "content-length"),
    headers: requestHeadersById.get(details.requestId) || cachedHeadersForUrl(url)
  });
  requestHeadersById.delete(details.requestId);

  if (item) await addMedia(details.tabId, [item], { sourcePageUrl: tab.url || details.initiator || "" });
}

// --- Media management ---

async function addMedia(tabId, additions, fallback = {}) {
  const settings = await getSettings();
  const tabUrl = fallback.sourcePageUrl || "";
  const current = (await getMedia(tabId)).filter((item) => mediaMatchesTab(item, tabUrl));
  const next = addUniqueMedia(current, additions
    .map((item) => withCachedHeaders(normalizeMediaItem(item, fallback)))
    .filter((item) => shouldKeepMedia(item, settings)));
  await chrome.storage.local.set({ [tabKey(tabId)]: next.slice(0, 30) });
  await updateBadge(tabId, next);
}

function mediaMatchesTab(item, tabUrl) {
  if (!tabUrl || !item) return true;
  if (item.pageUrl) return item.pageUrl === tabUrl;
  // Legacy items from before pageUrl was tracked only know their source page.
  return !item.sourcePageUrl || item.sourcePageUrl === tabUrl;
}

function shouldKeepMedia(item, settings) {
  if (!item) return false;
  if (!settings.showUnsupported && item.isProtected) return false;
  // Only filter by size when we actually know the size.
  // Items with unknown size (null) are kept — better to show too many than hide a real video.
  if (item.kind === "direct" && item.size && item.size < settings.minSizeBytes) return false;
  return true;
}

async function getMedia(tabId) {
  const data = await chrome.storage.local.get(tabKey(tabId));
  return Array.isArray(data[tabKey(tabId)]) ? data[tabKey(tabId)] : [];
}

// --- Manifest inspection via CONTENT SCRIPT ---
// We CANNOT fetch from background (Cloudflare blocks non-page contexts).
// ALL external fetches go through the content script.

async function enrichMediaForTab(tabId) {
  const items = await getMedia(tabId);
  const enriched = await Promise.all(items.map((item) => enrichMediaItem(item)));
  const changed = enriched.some((item, index) => JSON.stringify(item) !== JSON.stringify(items[index]));
  if (changed) await chrome.storage.local.set({ [tabKey(tabId)]: enriched });
  return enriched;
}

async function enrichMediaItem(item) {
  if (item.kind !== "hls" && item.kind !== "dash") return item;
  if ((item.variants?.length || 0) && (item.estimatedSize || item.size)) return item;

  // Use content script to fetch manifest text
  const tabId = await resolveTabId(item);
  if (typeof tabId !== "number") return item;

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "page:fetchText",
      url: item.url
    }, { frameId: item.frameId ?? 0 });
    if (!response?.ok || !response.text) return item;

    const parsed = item.kind === "hls"
      ? parseHlsManifest(response.text, item.url)
      : parseDashManifest(response.text, item.url);

    // For HLS, also try to fetch each variant's child playlist for size estimates
    let variants = parsed.variants || [];
    if (item.kind === "hls" && variants.length) {
      variants = await enrichVariantsFromContent(tabId, variants, item.frameId ?? 0);
    }

    const bandwidth = item.bandwidth || fallbackBandwidthForQuality(item.quality);
    const estimatedSize = estimateBytes(parsed.durationSeconds, bandwidth);

    return {
      ...item,
      variants,
      durationSeconds: parsed.durationSeconds || item.durationSeconds || null,
      estimatedSize: estimatedSize || null,
      sizeSource: estimatedSize ? "estimated" : "",
      isProtected: Boolean(parsed.hasDrm),
      unsupportedReason: parsed.hasDrm ? "DRM-protected, unsupported" : item.unsupportedReason
    };
  } catch {
    // Content script might not respond — keep original item
    return item;
  }
}

async function enrichVariantsFromContent(tabId, variants, frameId = 0) {
  return Promise.all(variants.map(async (variant) => {
    if (variant.estimatedSize) return variant;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "page:fetchText",
        url: variant.url
      }, { frameId });
      if (!response?.ok || !response.text) return variant;
      const child = parseHlsManifest(response.text, variant.url);
      const bandwidth = variant.bandwidth || fallbackBandwidthForQuality(variant.quality);
      const estimatedSize = estimateBytes(child.durationSeconds, bandwidth);
      return {
        ...variant,
        durationSeconds: child.durationSeconds || null,
        estimatedSize,
        sizeSource: estimatedSize ? "estimated" : ""
      };
    } catch {
      return variant;
    }
  }));
}

// --- Download ---

async function startDownload(item, variant = null) {
  const media = normalizeMediaItem(item);
  console.warn("[ds] startDownload kind=", media?.kind, "url=", (media?.url || "").slice(0, 100), "variant=", variant?.quality || "none");
  if (!media) return { ok: false, error: "INVALID_MEDIA" };
  if (media.isProtected) return { ok: false, error: media.unsupportedReason || "UNSUPPORTED_PROTECTED_MEDIA" };

  if (media.kind === "hls" || media.kind === "dash") {
    return startStreamDownload(media, variant);
  }

  // Direct download
  const hasDownloads = await chrome.permissions.contains({ permissions: ["downloads"] });
  if (!hasDownloads) return { ok: false, error: "DOWNLOAD_PERMISSION_REQUIRED" };
  const filename = sanitizeFilename(media.title, media.extension);
  const downloadId = await chrome.downloads.download({
    url: media.url, filename, conflictAction: "uniquify", saveAs: true
  });
  return { ok: true, downloadId };
}

async function startStreamDownload(media, variant) {
  // The content-script path only speaks HLS (m3u8). DASH downloads go
  // straight to the local helper, which is the only DASH-capable path.
  if (media.kind === "dash") {
    console.warn("[ds] startStreamDownload DASH → helper");
    return startHelperDownload(media, variant);
  }

  const authToken = await getHelperToken();
  if (!authToken) {
    console.warn("[ds] startStreamDownload FALLBACK=helper (no auth token)");
    return { ok: false, error: "HELPER_OFFLINE", variants: media.variants || [] };
  }

  console.warn("[ds] startStreamDownload tabSearch url=", (media.sourcePageUrl || "").slice(0, 60));
  const tabId = await resolveTabId(media);
  console.warn("[ds] startStreamDownload tabId=", tabId);

  if (typeof tabId !== "number") {
    console.warn("[ds] startStreamDownload FALLBACK=helper (tab not found)");
    return startHelperDownload(media, variant);
  }

  try {
    const downloadUrl = variant?.url || media.url;
    console.warn("[ds] startStreamDownload → content script url=", downloadUrl.slice(0, 100));
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "page:downloadStream",
      payload: {
        helperUrl: HELPER_URL,
        manifestUrl: downloadUrl,
        quality: variant?.quality || media.quality || "",
        title: media.title,
        sourcePageUrl: media.sourcePageUrl,
        authToken
      }
    }, { frameId: media.frameId ?? 0 });

    console.warn("[ds] startStreamDownload contentScriptResult ok=", response?.ok, "error=", response?.error);

    if (response?.ok) {
      return { ok: true, helperJob: response.helperJob };
    }
    if (["SERVER_PROTECTED_UNSUPPORTED", "DRM_PROTECTED_UNSUPPORTED", "JOB_CANCELLED", "SEGMENT_DOWNLOAD_FAILED", "SEGMENTS_INCOMPLETE"].includes(response?.error) ||
        response?.error?.startsWith("HELPER_COMPLETE_")) {
      return response;
    }
    console.warn("[ds] startStreamDownload FALLBACK=helper (content script returned error)");
    return startHelperDownload(media, variant);
  } catch (err) {
    console.warn("[ds] startStreamDownload FALLBACK=helper (exception:", err.message, ")");
    return startHelperDownload(media, variant);
  }
}

async function startHelperDownload(media, variant) {
  const downloadUrl = variant?.url || media.url;
  console.warn("[ds] startHelperDownload url=", downloadUrl.slice(0, 100));
  try {
    const response = await fetch(`${HELPER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: downloadUrl,
        title: media.title,
        kind: media.kind,
        sourcePageUrl: media.sourcePageUrl,
        headers: helperHeadersForMedia({ ...media, url: downloadUrl })
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}`, variants: media.variants || [] };
    return { ok: true, helperJob: payload.job };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE", variants: media.variants || [] };
  }
}

async function getStreamVariants(item) {
  const media = normalizeMediaItem(item);
  if (!media) return { ok: false, error: "INVALID_MEDIA" };
  const enriched = await enrichMediaItem(media);
  return {
    ok: true,
    variants: enriched.variants || [],
    hasDrm: enriched.isProtected
  };
}

// --- Helper API calls (localhost, no external fetching) ---

async function getHelperToken() {
  try {
    const response = await fetch(`${HELPER_URL}/auth`);
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return typeof payload?.token === "string" ? payload.token : null;
  } catch {
    return null;
  }
}

async function getHelperJob(jobId) {
  if (!jobId) return { ok: false, error: "JOB_ID_MISSING" };
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}` };
    return { ok: true, job: payload };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function getHelperStatus() {
  try {
    const [healthRes, jobsRes] = await Promise.all([
      fetch(`${HELPER_URL}/health`),
      fetch(`${HELPER_URL}/jobs?limit=20`)
    ]);
    const health = await healthRes.json().catch(() => ({}));
    const jobs = await jobsRes.json().catch(() => ({}));
    const jobsList = Array.isArray(jobs.jobs) ? jobs.jobs : [];

    if (healthRes.ok) {
      const recent = jobsList
        .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
        .slice(0, 20);
      await chrome.storage.local.set({ recentJobs: recent }).catch(() => {});
    }

    return {
      ok: healthRes.ok && jobsRes.ok,
      online: healthRes.ok,
      health,
      jobs: jobsList,
      stats: jobs.stats || null
    };
  } catch {
    const cached = await chrome.storage.local.get("recentJobs").catch(() => ({}));
    return {
      ok: true, online: false, health: null, jobs: [],
      cachedJobs: cached.recentJobs || []
    };
  }
}

async function updateHelperSettings(settings) {
  try {
    const response = await fetch(`${HELPER_URL}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok
      ? { ok: true, settings: payload.settings || {} }
      : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function pickHelperFolder() {
  try {
    const response = await fetch(`${HELPER_URL}/pick-folder`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    return response.ok
      ? { ok: true, settings: payload.settings || {} }
      : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function showHelperJob(jobId) {
  if (!jobId) return { ok: false, error: "JOB_ID_MISSING" };
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/show`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    return response.ok ? { ok: true } : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function deleteHelperJob(jobId) {
  if (!jobId) return { ok: false, error: "JOB_ID_MISSING" };
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    return response.ok ? { ok: true } : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function forgetHelperJob(jobId) {
  if (!jobId) return { ok: false, error: "JOB_ID_MISSING" };
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/history`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    return response.ok ? { ok: true } : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function clearMissingHelperJobs() {
  try {
    const response = await fetch(`${HELPER_URL}/jobs/clear-missing`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    return response.ok
      ? { ok: true, removedCount: payload.removedCount || 0 }
      : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function cancelHelperJob(jobId) {
  if (!jobId) return { ok: false, error: "JOB_ID_MISSING" };
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, job: payload.job } : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

// --- Utilities ---

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(data[SETTINGS_KEY] || {});
}

async function findTabForUrl(sourcePageUrl) {
  if (!sourcePageUrl) return null;
  let target = null;
  try { target = new URL(sourcePageUrl); } catch { return null; }

  const tabs = await chrome.tabs.query({}).catch(() => []);
  let originFallback = null;

  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    if (tab.url === sourcePageUrl) return tab.id;
    try {
      const tabUrl = new URL(tab.url);
      if (tabUrl.origin === target.origin) {
        if (tabUrl.pathname === target.pathname && tabUrl.search === target.search) return tab.id;
        if (!originFallback) originFallback = tab.id;
      }
    } catch {}
  }

  return originFallback;
}

async function resolveTabId(item) {
  if (Number.isInteger(item?.tabId)) {
    const tab = await chrome.tabs.get(item.tabId).catch(() => null);
    if (tab) return item.tabId;
  }
  return findTabForUrl(item?.sourcePageUrl);
}

function tabKey(tabId) { return `${TAB_MEDIA_PREFIX}${tabId}`; }

function headerValue(headers = [], name) {
  const found = headers.find((h) => h.name?.toLowerCase() === name);
  return found?.value || "";
}

function numberHeader(headers, name) {
  const v = Number(headerValue(headers, name));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function sanitizeHeaders(headers) {
  const allowed = new Set(["accept", "origin", "referer", "user-agent", "accept-language", "cookie", "range"]);
  return headers
    .filter((h) => allowed.has(h.name?.toLowerCase()))
    .map((h) => ({ name: h.name, value: h.value || "" }));
}

function rememberRequestHeaders(details) {
  const headers = sanitizeHeaders(details.requestHeaders || []);
  requestHeadersById.set(details.requestId, headers);
  requestHeadersByUrl.set(details.url, headers);
  while (requestHeadersById.size > MAX_CAPTURED_HEADERS) requestHeadersById.delete(requestHeadersById.keys().next().value);
  while (requestHeadersByUrl.size > MAX_CAPTURED_HEADERS) requestHeadersByUrl.delete(requestHeadersByUrl.keys().next().value);
}

function cachedHeadersForUrl(url) {
  return requestHeadersByUrl.get(url) || [];
}

function withCachedHeaders(item) {
  if (!item) return null;
  if (item.headers?.length) return item;
  return { ...item, headers: cachedHeadersForUrl(item.url) };
}

function helperHeadersForMedia(media) {
  const headers = sanitizeHeaders(media.headers?.length ? media.headers : cachedHeadersForUrl(media.url));
  const byName = new Map(headers.map((h) => [h.name.toLowerCase(), h]));
  const add = (name, value) => {
    if (!value || byName.has(name.toLowerCase())) return;
    byName.set(name.toLowerCase(), { name, value });
  };
  add("Accept", media.kind === "dash" ? "application/dash+xml,*/*" : "application/vnd.apple.mpegurl,*/*");
  add("Referer", media.sourcePageUrl || "");
  add("Origin", originForUrl(media.sourcePageUrl));
  add("User-Agent", typeof navigator !== "undefined" ? navigator.userAgent : "");
  add("Accept-Language", typeof navigator !== "undefined" ? navigator.language : "");
  return Array.from(byName.values());
}

function originForUrl(value) {
  try { return new URL(value).origin; } catch { return ""; }
}

function headersToObject(headers = []) {
  const obj = {};
  for (const h of headers) {
    if (!h?.name || /[\r\n]/.test(h.name) || /[\r\n]/.test(h.value || "")) continue;
    obj[h.name] = h.value || "";
  }
  return obj;
}

async function updateBadge(tabId, items) {
  const count = items.filter((item) => !item.isProtected).length;
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2f6f5e" }).catch(() => {});
}
