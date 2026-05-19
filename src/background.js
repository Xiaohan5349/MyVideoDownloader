import {
  MESSAGE,
  addUniqueMedia,
  classifyMedia,
  estimateBytes,
  fallbackBandwidthForQuality,
  mergeSettings,
  normalizeMediaItem,
  parseDashManifest,
  parseHlsManifest,
  sanitizeFilename
} from "./shared.js";

const SETTINGS_KEY = "settings";
const TAB_MEDIA_PREFIX = "tabMedia:";
const HELPER_URL = "http://127.0.0.1:8765";
const requestHeadersById = new Map();
const MAX_CAPTURED_HEADERS = 500;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    requestHeadersById.set(details.requestId, sanitizeHeaders(details.requestHeaders || []));
    if (requestHeadersById.size > MAX_CAPTURED_HEADERS) {
      const firstKey = requestHeadersById.keys().next().value;
      requestHeadersById.delete(firstKey);
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    detectFromNetwork(details).catch((error) => {
      console.warn("[ds-video-downloader] network detection failed", error);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(tabKey(tabId));
});

async function handleMessage(message, sender) {
  if (!message || typeof message !== "object") return { ok: false, error: "INVALID_MESSAGE" };

  if (message.type === MESSAGE.MEDIA_ADD_DETECTED) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") return { ok: false, error: "TAB_ID_MISSING" };
    await addMedia(tabId, message.items || [], {
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
    return { ok: true, items: items.filter((item) => shouldKeepMedia(item, settings)) };
  }

  if (message.type === MESSAGE.DOWNLOADS_START) {
    return startDownload(message.item, message.variant);
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_GET) {
    return getHelperJob(message.jobId);
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_SHOW) {
    return showHelperJob(message.jobId);
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_DELETE) {
    return deleteHelperJob(message.jobId);
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_CANCEL) {
    return cancelHelperJob(message.jobId);
  }

  if (message.type === MESSAGE.HELPER_STATUS_GET) {
    return getHelperStatus();
  }

  if (message.type === MESSAGE.HELPER_SETTINGS_UPDATE) {
    return updateHelperSettings(message.settings || {});
  }

  if (message.type === MESSAGE.HELPER_FOLDER_PICK) {
    return pickHelperFolder();
  }

  if (message.type === MESSAGE.STREAM_VARIANTS_GET) {
    return getStreamVariants(message.item);
  }

  if (message.type === MESSAGE.SETTINGS_GET) {
    return { ok: true, settings: await getSettings() };
  }

  if (message.type === MESSAGE.SETTINGS_UPDATE) {
    const settings = mergeSettings({ ...(await getSettings()), ...(message.settings || {}) });
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return { ok: true, settings };
  }

  return { ok: false, error: "UNKNOWN_MESSAGE" };
}

async function detectFromNetwork(details) {
  if (details.tabId < 0) return;
  const contentType = headerValue(details.responseHeaders, "content-type");
  const classified = classifyMedia(details.url, contentType);
  if (!classified) return;

  const tab = await chrome.tabs.get(details.tabId).catch(() => null);
  const item = normalizeMediaItem({
    url: details.url,
    sourcePageUrl: tab?.url || details.initiator || "",
    title: tab?.title || "video",
    extension: classified.extension,
    kind: classified.kind,
    size: numberHeader(details.responseHeaders, "content-length"),
    headers: requestHeadersById.get(details.requestId) || []
  });
  requestHeadersById.delete(details.requestId);

  if (item) await addMedia(details.tabId, [item]);
}

async function addMedia(tabId, additions, fallback = {}) {
  const settings = await getSettings();
  const current = await getMedia(tabId);
  const next = addUniqueMedia(current, additions
    .map((item) => normalizeMediaItem(item, fallback))
    .filter((item) => shouldKeepMedia(item, settings)));
  await chrome.storage.local.set({ [tabKey(tabId)]: next.slice(0, 100) });
  await updateBadge(tabId, next);
}

function shouldKeepMedia(item, settings) {
  if (!item) return false;
  if (!settings.showUnsupported && item.isProtected) return false;
  if (item.kind === "direct" && item.size && item.size < settings.minSizeBytes) return false;
  return true;
}

async function getMedia(tabId) {
  const data = await chrome.storage.local.get(tabKey(tabId));
  return Array.isArray(data[tabKey(tabId)]) ? data[tabKey(tabId)] : [];
}

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

  const inspection = await inspectManifest(item);
  const helperInspection = inspection.ok && hasUsefulInspection(inspection)
    ? { ok: false }
    : await inspectWithHelper(item);
  const fallbackInspection = mergeInspections(inspection.ok ? inspection : null, helperInspection.ok ? helperInspection : null);
  if (!fallbackInspection) return item;
  return {
    ...item,
    variants: fallbackInspection.variants || item.variants || [],
    durationSeconds: fallbackInspection.durationSeconds || item.durationSeconds || null,
    estimatedSize: fallbackInspection.estimatedSize || fallbackInspection.totalBytes || item.estimatedSize || null,
    sizeSource: fallbackInspection.sizeSource || fallbackInspection.totalSizeSource || (fallbackInspection.estimatedSize || fallbackInspection.totalBytes ? "estimated" : item.sizeSource || ""),
    isProtected: Boolean(fallbackInspection.hasDrm),
    unsupportedReason: fallbackInspection.hasDrm ? "DRM-protected, unsupported" : item.unsupportedReason
  };
}

function hasUsefulInspection(inspection) {
  return Boolean(inspection.estimatedSize || inspection.totalBytes || inspection.variants?.length);
}

function mergeInspections(primary, helper) {
  if (!primary && !helper) return null;
  if (!primary) return helper;
  if (!helper) return primary;

  const variants = mergeVariants(primary.variants || [], helper.variants || []);
  return {
    ...primary,
    ...helper,
    hasDrm: Boolean(primary.hasDrm || helper.hasDrm),
    durationSeconds: helper.durationSeconds || primary.durationSeconds || null,
    estimatedSize: helper.estimatedSize || helper.totalBytes || primary.estimatedSize || primary.totalBytes || null,
    sizeSource: helper.sizeSource || helper.totalSizeSource || primary.sizeSource || "",
    variants: variants.length ? variants : primary.variants || helper.variants || []
  };
}

function mergeVariants(primaryVariants, helperVariants) {
  const byKey = new Map();
  for (const variant of primaryVariants) {
    byKey.set(variant.url || variant.quality || String(byKey.size), variant);
  }
  for (const variant of helperVariants) {
    const key = variant.url || variant.quality || String(byKey.size);
    byKey.set(key, { ...(byKey.get(key) || {}), ...variant });
  }
  return Array.from(byKey.values());
}

async function startDownload(item, variant = null) {
  const media = normalizeMediaItem(item);
  if (!media) return { ok: false, error: "INVALID_MEDIA" };
  if (media.isProtected) return { ok: false, error: media.unsupportedReason || "UNSUPPORTED_PROTECTED_MEDIA" };

  if (media.kind === "hls" || media.kind === "dash") {
    const helperResponse = await startHelperDownload(media, variant);
    if (helperResponse.ok || helperResponse.error !== "HELPER_OFFLINE") return helperResponse;

    const inspection = await inspectManifest(media);
    if (!inspection.ok) return inspection;
    await saveInspection(media, inspection);
    return {
      ok: false,
      error: inspection.hasDrm ? "DRM_PROTECTED_UNSUPPORTED" : "HELPER_OFFLINE",
      variants: inspection.variants
    };
  }

  const hasDownloads = await chrome.permissions.contains({ permissions: ["downloads"] });
  if (!hasDownloads) return { ok: false, error: "DOWNLOAD_PERMISSION_REQUIRED" };

  const filename = sanitizeFilename(media.title, media.extension);
  const downloadId = await chrome.downloads.download({
    url: media.url,
    filename,
    conflictAction: "uniquify",
    saveAs: true
  });
  return { ok: true, downloadId };
}

async function getStreamVariants(item) {
  const media = normalizeMediaItem(item);
  if (!media) return { ok: false, error: "INVALID_MEDIA" };
  const inspection = await inspectManifest(media);
  if (!inspection.ok) return inspection;
  await saveInspection(media, inspection);
  return { ok: true, variants: inspection.variants, hasDrm: inspection.hasDrm };
}

async function startHelperDownload(media, variant) {
  try {
    const response = await fetch(`${HELPER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: variant?.url || media.url,
        title: media.title,
        kind: media.kind,
        headers: media.headers || []
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}` };
    return { ok: true, helperJob: payload.job };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function inspectWithHelper(media) {
  try {
    const response = await fetch(`${HELPER_URL}/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: media.url,
        kind: media.kind,
        headers: media.headers || []
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}` };
    return {
      ok: true,
      hasDrm: payload.hasDrm,
      variants: payload.variants || [],
      durationSeconds: payload.durationSeconds || null,
      estimatedSize: payload.totalBytes || null
    };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
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
    const [healthResponse, jobsResponse] = await Promise.all([
      fetch(`${HELPER_URL}/health`),
      fetch(`${HELPER_URL}/jobs`)
    ]);
    const health = await healthResponse.json().catch(() => ({}));
    const jobs = await jobsResponse.json().catch(() => ({}));
    return {
      ok: healthResponse.ok && jobsResponse.ok,
      online: healthResponse.ok,
      health,
      jobs: Array.isArray(jobs.jobs) ? jobs.jobs : []
    };
  } catch {
    return { ok: true, online: false, health: null, jobs: [] };
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
    return response.ok ? { ok: true, settings: payload.settings || {} } : { ok: false, error: payload.error || `HELPER_${response.status}` };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function pickHelperFolder() {
  try {
    const response = await fetch(`${HELPER_URL}/pick-folder`, { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, settings: payload.settings || {} } : { ok: false, error: payload.error || `HELPER_${response.status}` };
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

async function inspectManifest(media) {
  try {
    const response = await fetch(media.url, {
      credentials: "include",
      headers: {
        ...headersToObject(media.headers || []),
        Accept: media.kind === "hls" ? "application/vnd.apple.mpegurl,*/*" : "application/dash+xml,*/*"
      }
    });
    if (!response.ok) {
      return { ok: false, error: response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `MANIFEST_FETCH_${response.status}` };
    }
    const text = await response.text();
    const parsed = media.kind === "hls" ? parseHlsManifest(text, media.url) : parseDashManifest(text, media.url);
    const enrichedVariants = media.kind === "hls"
      ? await enrichHlsVariants(parsed.variants || [], media.headers || [])
      : parsed.variants || [];
    const ownBandwidth = media.bandwidth || fallbackBandwidthForQuality(media.quality);
    const ownEstimate = estimateBytes(parsed.durationSeconds, ownBandwidth);
    return {
      ok: true,
      ...parsed,
      variants: enrichedVariants,
      estimatedSize: ownEstimate || largestVariantEstimate(enrichedVariants)
    };
  } catch {
    return { ok: false, error: "SERVER_PROTECTED_UNSUPPORTED" };
  }
}

async function enrichHlsVariants(variants, headers) {
  return Promise.all(variants.map(async (variant) => {
    if (variant.estimatedSize) return variant;
    const response = await fetch(variant.url, {
      credentials: "include",
      headers: {
        ...headersToObject(headers),
        Accept: "application/vnd.apple.mpegurl,*/*"
      }
    }).catch(() => null);
    if (!response?.ok) return variant;

    const text = await response.text().catch(() => "");
    const child = parseHlsManifest(text, variant.url);
    const bandwidth = variant.bandwidth || fallbackBandwidthForQuality(variant.quality);
    const estimatedSize = estimateBytes(child.durationSeconds, bandwidth);
    return {
      ...variant,
      durationSeconds: child.durationSeconds || null,
      estimatedSize,
      sizeSource: estimatedSize ? "estimated" : ""
    };
  }));
}

function largestVariantEstimate(variants) {
  const sizes = variants.map((variant) => variant.estimatedSize).filter((size) => Number.isFinite(size));
  return sizes.length ? Math.max(...sizes) : null;
}

async function saveInspection(media, inspection) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const matchingTab = tabs.find((tab) => tab.id != null && (tab.url === media.sourcePageUrl || media.sourcePageUrl?.startsWith(tab.url || "")));
  if (matchingTab?.id == null) return;

  const current = await getMedia(matchingTab.id);
  const next = current.map((item) => item.id === media.id
    ? {
        ...item,
        variants: inspection.variants || [],
        durationSeconds: inspection.durationSeconds || item.durationSeconds || null,
        estimatedSize: inspection.estimatedSize || item.estimatedSize || null,
        sizeSource: inspection.estimatedSize ? "estimated" : item.sizeSource || "",
        isProtected: Boolean(inspection.hasDrm),
        unsupportedReason: inspection.hasDrm ? "DRM-protected, unsupported" : item.unsupportedReason
      }
    : item);
  await chrome.storage.local.set({ [tabKey(matchingTab.id)]: next });
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(data[SETTINGS_KEY] || {});
}

async function updateBadge(tabId, items) {
  const count = items.filter((item) => !item.isProtected).length;
  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2f6f5e" }).catch(() => {});
}

function tabKey(tabId) {
  return `${TAB_MEDIA_PREFIX}${tabId}`;
}

function headerValue(headers = [], name) {
  const found = headers.find((header) => header.name?.toLowerCase() === name);
  return found?.value || "";
}

function numberHeader(headers, name) {
  const value = Number(headerValue(headers, name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function sanitizeHeaders(headers) {
  const allowed = new Set(["accept", "origin", "referer", "user-agent", "accept-language", "cookie"]);
  return headers
    .filter((header) => allowed.has(header.name?.toLowerCase()))
    .map((header) => ({ name: header.name, value: header.value || "" }));
}
