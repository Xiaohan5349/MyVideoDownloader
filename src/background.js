import {
  MESSAGE, addUniqueMedia, classifyMedia, DIRECT_EXTENSIONS,
  estimateBytes, fallbackBandwidthForQuality, isSegmentFile, mergeSettings,
  normalizeMediaItem, parseDashManifest, parseHlsManifest, sanitizeFilename
} from "./shared.js";

console.log("[ds] Service worker started v1.11.1");

const SETTINGS_KEY = "settings";
const TAB_MEDIA_PREFIX = "tabMedia:";
const HELPER_URL = "http://127.0.0.1:8765";
const DEBUG = true;

// NOTE: tabMedia:* survives service-worker restarts. Media is scoped to the
// top-level page URL and pruned when the tab closes or navigates, so stale
// entries are filtered out instead of being bulk-deleted on every startup.

const requestHeadersById = new Map();
const requestHeadersByUrl = new Map();
const tabMediaMutationChains = new Map();
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
  enqueueTabMediaMutation(tabId, () => chrome.storage.local.remove(tabKey(tabId))).catch(() => {});
  // The download loop lives in this tab's content script, so it is gone now.
  return failActiveDownloadsForTab(tabId, "SOURCE_PAGE_CLOSED").catch(() => {});
});

// Full-page navigation destroys the old content script before it can send
// page:clearMedia. Clear tab media whenever the main frame starts loading,
// including same-URL reloads; same-document navigation stays content-driven.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    enqueueTabMediaMutation(tabId, () => chrome.storage.local.remove(tabKey(tabId))).catch(() => {});
  }
});

// --- Message handler ---

async function handleMessage(message, sender) {
  if (DEBUG) console.warn("[ds] handleMessage type=", message?.type);
  if (!message || typeof message !== "object") return { ok: false, error: "INVALID_MESSAGE" };

  // Content script navigation / rescan — clear stale data
  if (message.type === "page:clearMedia") {
    const tabId = message.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      if (message.keepNetwork) {
        // Rescan: keep webRequest and MAIN-world discoveries because DOM
        // rescanning cannot replay either of those sources.
        await enqueueTabMediaMutation(tabId, async () => {
          const current = await getMedia(tabId);
          await chrome.storage.local.set({
            [tabKey(tabId)]: current.filter((item) => item.source === "network" || item.source === "main")
          });
        });
      } else {
        await enqueueTabMediaMutation(tabId, () => chrome.storage.local.remove(tabKey(tabId)));
      }
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
    // enrich: false lists what is stored, for the popup's live refresh.
    const items = message.enrich === false ? await getMedia(tabId) : await enrichMediaForTab(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return {
      ok: true,
      items: items.filter((item) => shouldKeepMedia(item, settings) && mediaMatchesTab(item, tab?.url || ""))
    };
  }

  // Media that showed up while the popup was open: probe without waiting;
  // the results arrive through storage.
  if (message.type === MESSAGE.MEDIA_ENRICH) {
    if (typeof message.tabId !== "number") return { ok: false, error: "TAB_ID_MISSING" };
    await enrichMediaForTab(message.tabId, { urls: message.urls || [], wait: false });
    return { ok: true };
  }

  if (message.type === MESSAGE.DOWNLOADS_START) {
    return startDownload(message.item, message.variant, message.output);
  }

  // The page hosting a download loop is going away (navigation, reload,
  // bfcache). Fail the job now instead of waiting for the stall sweeper.
  if (message.type === "page:streamInterrupted") {
    await untrackActiveDownload(message.jobId);
    await reportBrowserDownloadFailure(message.jobId, "SOURCE_PAGE_CLOSED");
    return { ok: true };
  }

  if (message.type === "page:streamFinished") {
    await untrackActiveDownload(message.jobId);
    return { ok: true };
  }

  if (message.type === "offscreen:allowHosts") {
    await allowReplayRuleHosts(message.ruleId, message.hosts);
    return { ok: true };
  }

  if (message.type === "offscreen:finished") {
    await handleOffscreenFinished(message.jobId, message.outcome);
    return { ok: true };
  }

  if (message.type === MESSAGE.DOWNLOADS_JOB_RESUME) return resumeHelperJob(message.jobId);

  if (message.type === MESSAGE.DOWNLOADS_JOB_GET) return getHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_SHOW) return showHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_DELETE) return deleteHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_FORGET) return forgetHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOB_CANCEL) return cancelHelperJob(message.jobId);
  if (message.type === MESSAGE.DOWNLOADS_JOBS_CLEAR_MISSING) return clearMissingHelperJobs();
  if (message.type === MESSAGE.HELPER_STATUS_GET) return getHelperStatus();
  if (message.type === MESSAGE.HELPER_SETTINGS_UPDATE) return updateHelperSettings(message.settings || {});
  if (message.type === MESSAGE.HELPER_FOLDER_PICK) {
    const { reopenPopup, ...options } = message.options || {};
    const result = await pickHelperFolder(options);
    if (reopenPopup) await reopenDownloadDialog(result);
    return result;
  }
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
  const contentType = headerValue(details.responseHeaders, "content-type");
  const classifiedByContentType = classifyMedia("", contentType);

  // Skip internal helper traffic
  if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return;

  // Skip analytics, telemetry, logging, CDN assets. Extension checks are
  // path-only so a legitimate manifest with e.g. ?poster=cover.jpg survives.
  if (/\/log\/|analytics|telemetry|tracker|pixel|beacon|cdn\.plyr/i.test(url)) return;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (!classifiedByContentType && /\.(?:svg|png|jpe?g|gif|webp|css)$/.test(pathname)) return;
    if (!classifiedByContentType && /\.js$/.test(pathname)) return;
  } catch {}

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
    source: "network",
    size: responseContentLength(details.responseHeaders, details.statusCode),
    headers: requestHeadersById.get(details.requestId) || cachedHeadersForUrl(url)
  });
  requestHeadersById.delete(details.requestId);

  if (item) await addMedia(details.tabId, [item], { sourcePageUrl: tab.url || details.initiator || "" });
}

// --- Media management ---

function addMedia(tabId, additions, fallback = {}) {
  return enqueueTabMediaMutation(tabId, () => addMediaInternal(tabId, additions, fallback));
}

function enqueueTabMediaMutation(tabId, operation) {
  const previous = tabMediaMutationChains.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  const tracked = task.finally(() => {
    if (tabMediaMutationChains.get(tabId) === tracked) tabMediaMutationChains.delete(tabId);
  });
  tabMediaMutationChains.set(tabId, tracked);
  tracked.catch(() => {});
  return tracked;
}

async function addMediaInternal(tabId, additions, fallback = {}) {
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

// How long the popup's scan waits for sizes and resolutions.
const ENRICH_WAIT_MS = 8000;
// How long an item's probes may keep running after the scan stopped waiting;
// their results are still stored, and the open popup updates from storage.
const ENRICH_BACKGROUND_MS = 30_000;
// `${tabId}|${url}` -> running enrichment, so overlapping scans share it.
const enrichmentsInFlight = new Map();

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// urls: only these items (null = all). wait: false starts the probes and
// returns at once.
async function enrichMediaForTab(tabId, { urls = null, wait = true } = {}) {
  const snapshot = await getMedia(tabId);
  const targets = urls ? snapshot.filter((item) => urls.includes(item.url)) : snapshot;
  const tasks = targets.map((item) => enrichAndStore(tabId, item));
  if (wait) await withTimeout(Promise.all(tasks), ENRICH_WAIT_MS, null);
  const latest = await getMedia(tabId);
  // Media detected while the scan waited is in the answer but was not in the
  // snapshot: probe it too, its results arrive through storage.
  if (!urls) {
    const probed = new Set(snapshot.map((item) => item.url));
    for (const item of latest) {
      if (!probed.has(item.url)) enrichAndStore(tabId, item);
    }
  }
  return latest;
}

// Each result is written as soon as it is known: the size first, then the
// resolution, so a slow probe never hides a size that already arrived.
function enrichAndStore(tabId, item) {
  const key = `${tabId}|${item.url}`;
  if (!enrichmentsInFlight.has(key)) {
    const store = (enriched) => (enriched !== item ? storeEnrichedMedia(tabId, enriched) : null);
    const task = enrichMediaItem(item, { timeoutMs: ENRICH_BACKGROUND_MS, onDetails: store })
      .then(store)
      .catch(() => {})
      .finally(() => enrichmentsInFlight.delete(key));
    enrichmentsInFlight.set(key, task);
  }
  return enrichmentsInFlight.get(key);
}

// Probing happens outside the write queue so new detections can keep
// flowing. Only the merge + write is serialized.
function storeEnrichedMedia(tabId, item) {
  return enqueueTabMediaMutation(tabId, async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!mediaMatchesTab(item, tab?.url || "")) return;
    const latest = await getMedia(tabId);
    await chrome.storage.local.set({ [tabKey(tabId)]: addUniqueMedia(latest, [item]).slice(0, 30) });
  });
}

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "flac", "ogg", "wav"]);

// Size/manifest details and the resolution probe each get their own timeout,
// so a slow ffprobe never throws away a size that is already known.
// onDetails: called with the size/manifest result before the resolution probe ends.
async function enrichMediaItem(item, { timeoutMs = ENRICH_WAIT_MS, onDetails } = {}) {
  const started = Date.now();
  // A direct file can be probed at once; a playlist first has to show it has no variants.
  const earlyProbe = item.kind === "direct" && needsQualityProbe(item) ? probeMediaQuality(item) : null;
  const details = await withTimeout(enrichMediaDetails(item), timeoutMs, item);
  await onDetails?.(details);
  const probe = earlyProbe || (needsQualityProbe(details) ? probeMediaQuality(details) : null);
  if (!probe) return details;
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - started));
  return withQuality(details, await withTimeout(probe, remainingMs, ""));
}

// Direct files and single-quality HLS playlists carry no resolution, so the
// helper reads it from the video stream itself.
function needsQualityProbe(item) {
  if (item.quality || item.isProtected || item.variants?.length) return false;
  if (item.kind === "hls") return true;
  return item.kind === "direct" && !AUDIO_EXTENSIONS.has(item.extension);
}

// Resolves to a label like "1080p", or "" when the helper cannot read one.
async function probeMediaQuality(item) {
  try {
    const response = await fetch(`${HELPER_URL}/probe-quality`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, kind: item.kind, headers: helperHeadersForMedia(item) })
    });
    const payload = await response.json().catch(() => ({}));
    return response.ok && payload.quality ? payload.quality : "";
  } catch {
    return "";
  }
}

function withQuality(item, quality) {
  if (!quality || item.quality) return item;
  // A playlist's size estimate needs a bitrate; the quality now gives one.
  const estimatedSize = item.size || item.estimatedSize
    ? null
    : estimateBytes(item.durationSeconds, fallbackBandwidthForQuality(quality));
  return estimatedSize
    ? { ...item, quality, estimatedSize, sizeSource: "estimated" }
    : { ...item, quality };
}

async function enrichMediaDetails(item) {
  if (item.kind === "direct" && !item.size) return enrichDirectMediaSize(item);
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

async function enrichDirectMediaSize(item) {
  const tabId = await resolveTabId(item);
  if (typeof tabId !== "number") return item;

  const pageProbe = chrome.tabs.sendMessage(tabId, {
      type: "page:fetchSize",
      url: item.url
    }, { frameId: item.frameId ?? 0 })
    .then((response) => positiveSize(response?.ok ? response.size : null))
    .catch(() => null);

  const helperProbe = fetch(`${HELPER_URL}/inspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: item.url,
      kind: "direct",
      headers: helperHeadersForMedia(item)
    })
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    return positiveSize(response.ok ? payload.totalBytes : null);
  }).catch(() => null);

  const size = await firstSize([pageProbe, helperProbe]);
  return size ? { ...item, size, sizeSource: "exact" } : item;
}

// The first probe that finds a size wins; a slower one cannot delay it.
function firstSize(probes) {
  return new Promise((resolve) => {
    let pending = probes.length;
    for (const probe of probes) {
      probe.then((size) => {
        if (size) resolve(size);
        else if (--pending === 0) resolve(null);
      });
    }
  });
}

function positiveSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : null;
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

// output: { filename, downloadDir } chosen in the popup's download dialog
// (both optional; the helper falls back to the title and its saved folder).
// output.viaBrowser: the user asked to retry a direct file with Chrome.
async function startDownload(item, variant = null, output = {}) {
  const media = normalizeMediaItem(item);
  console.warn("[ds] startDownload kind=", media?.kind, "url=", (media?.url || "").slice(0, 100), "variant=", variant?.quality || "none");
  if (!media) return { ok: false, error: "INVALID_MEDIA" };
  if (media.isProtected) return { ok: false, error: media.unsupportedReason || "UNSUPPORTED_PROTECTED_MEDIA" };
  const target = outputTarget(output);

  if (media.kind === "hls" || media.kind === "dash") {
    return startStreamDownload(media, variant, { output: target });
  }

  if (!output?.viaBrowser) {
    const helper = await startHelperDirectDownload(media, target);
    if (helper.error !== "HELPER_OFFLINE") return helper;
    console.warn("[ds] helper offline, downloading the direct file with Chrome");
  }
  return startBrowserFileDownload(media, target);
}

function outputTarget(output) {
  return {
    filename: String(output?.filename || "").trim(),
    downloadDir: String(output?.downloadDir || "").trim()
  };
}

// The helper writes the file into any folder and shows it in the job list.
// Failures other than HELPER_OFFLINE carry browserFallback so the popup can
// offer "Download with browser".
async function startHelperDirectDownload(media, output) {
  try {
    const response = await fetch(`${HELPER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: media.url,
        kind: "direct",
        title: media.title,
        extension: media.extension,
        sourcePageUrl: media.sourcePageUrl,
        headers: helperHeadersForMedia(media),
        ...output
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}`, browserFallback: true };
    return { ok: true, helperJob: payload.job };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

// Chrome can only save inside its own download folder, so the chosen folder
// is ignored here; the name is kept and Chrome's Save As prompt is skipped.
async function startBrowserFileDownload(media, output) {
  const hasDownloads = await chrome.permissions.contains({ permissions: ["downloads"] });
  if (!hasDownloads) return { ok: false, error: "DOWNLOAD_PERMISSION_REQUIRED" };
  const filename = sanitizeFilename(output.filename || media.title, media.extension);
  const downloadId = await chrome.downloads.download({
    url: media.url, filename, conflictAction: "uniquify", saveAs: false
  });
  return { ok: true, downloadId };
}

async function startStreamDownload(media, variant, { allowHelperFallback = true, output = {} } = {}) {
  // HLS and DASH share both browser paths. MPD layouts the browser loop does
  // not handle (live, multi-period, WebM) end up in the helper fallback.
  // Extension mode first: the offscreen document fetches the segments, so
  // the download survives the source tab being frozen, discarded or closed.
  const extension = await startOffscreenDownload(media, variant, output);
  if (extension.ok || extension.error === "DRM_PROTECTED_UNSUPPORTED") return extension;
  console.warn("[ds] extension mode unavailable, using page mode:", extension.error);
  return startPageDownload(media, variant, { allowHelperFallback, output });
}

async function startOffscreenDownload(media, variant, output = {}) {
  if (!chrome.offscreen || !chrome.declarativeNetRequest) return { ok: false, error: "OFFSCREEN_UNAVAILABLE" };
  const manifestUrl = variant?.url || media.url;
  let ruleId = null;
  try {
    await ensureOffscreenDocument();
    ruleId = await addReplayRule(media, manifestUrl);
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "offscreen:downloadStream",
      payload: {
        helperUrl: HELPER_URL,
        manifestUrl,
        quality: variant?.quality || media.quality || "",
        title: media.title,
        sourcePageUrl: media.sourcePageUrl,
        ruleId,
        ...output
      }
    });
    if (!response?.ok || !response.helperJob?.id) {
      await removeReplayRule(ruleId);
      return { ok: false, error: response?.error || "OFFSCREEN_FAILED" };
    }
    await trackActiveDownload(response.helperJob.id, {
      mode: "extension",
      ruleId,
      tabId: media.tabId,
      media: handoffMedia(media),
      variant: variant?.url ? { url: variant.url, quality: variant.quality || "" } : null
    });
    return { ok: true, helperJob: response.helperJob, resumed: Boolean(response.resumed), mode: "extension" };
  } catch (error) {
    await removeReplayRule(ruleId);
    return { ok: false, error: error?.message || "OFFSCREEN_FAILED" };
  }
}

// Enough of a media item to restart it in page mode after a handoff.
function handoffMedia(media) {
  const { url, kind, title, sourcePageUrl, frameId, tabId, quality } = media;
  return { url, kind, title, sourcePageUrl, frameId, tabId, quality };
}

async function startPageDownload(media, variant, { allowHelperFallback = true, output = {} } = {}) {
  const fallback = () => (allowHelperFallback
    ? startHelperDownload(media, variant, output)
    : { ok: false, error: "SOURCE_PAGE_REQUIRED" });

  const authToken = await getHelperToken();
  if (!authToken) {
    console.warn("[ds] startPageDownload FALLBACK=helper (no auth token)");
    return { ok: false, error: "HELPER_OFFLINE", variants: media.variants || [] };
  }

  console.warn("[ds] startPageDownload tabSearch url=", (media.sourcePageUrl || "").slice(0, 60));
  const tabId = await resolveTabId(media);
  console.warn("[ds] startPageDownload tabId=", tabId);

  if (typeof tabId !== "number") {
    console.warn("[ds] startPageDownload FALLBACK (tab not found)");
    return fallback();
  }

  try {
    const downloadUrl = variant?.url || media.url;
    console.warn("[ds] startPageDownload → content script url=", downloadUrl.slice(0, 100));
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "page:downloadStream",
      payload: {
        helperUrl: HELPER_URL,
        manifestUrl: downloadUrl,
        quality: variant?.quality || media.quality || "",
        title: media.title,
        sourcePageUrl: media.sourcePageUrl,
        authToken,
        ...output
      }
    }, { frameId: media.frameId ?? 0 });

    console.warn("[ds] startPageDownload contentScriptResult ok=", response?.ok, "error=", response?.error);

    if (response?.ok) {
      // The content script answers as soon as the helper job exists and keeps
      // downloading afterwards, so a later port closure can no longer trigger
      // a duplicate helper fallback below.
      if (response.helperJob?.id) await trackActiveDownload(response.helperJob.id, { mode: "page", tabId });
      return { ok: true, helperJob: response.helperJob, resumed: Boolean(response.resumed), mode: "page" };
    }
    if (["SERVER_PROTECTED_UNSUPPORTED", "DRM_PROTECTED_UNSUPPORTED", "JOB_CANCELLED", "SEGMENT_DOWNLOAD_FAILED", "SEGMENTS_INCOMPLETE"].includes(response?.error) ||
        response?.error?.startsWith("HELPER_COMPLETE_")) {
      return response;
    }
    console.warn("[ds] startPageDownload FALLBACK (content script returned error)");
    return fallback();
  } catch (err) {
    console.warn("[ds] startPageDownload FALLBACK (exception:", err.message, ")");
    return fallback();
  }
}

// --- Resume button ---

async function resumeHelperJob(jobId) {
  const result = await getHelperJob(jobId);
  if (!result.ok) return result;
  const job = result.job;
  if (job.resumable && job.inputMode === "direct") return resumeDirectHelperJob(job);
  if (!job.resumable || job.inputMode !== "browser") return { ok: false, error: "JOB_NOT_RESUMABLE" };

  const isDash = job.streamKind === "dash";
  const media = normalizeMediaItem({
    url: job.url,
    kind: isDash ? "dash" : "hls",
    extension: isDash ? "mpd" : "m3u8",
    sourcePageUrl: job.sourcePageUrl || "",
    headers: cachedHeadersForUrl(job.url)
  });
  if (!media) return { ok: false, error: "JOB_NOT_RESUMABLE" };
  // One MPD serves every quality; ask for the one the job started with.
  const variant = isDash && job.quality ? { url: job.url, quality: job.quality } : null;

  // Never fall back to a fresh helper-direct job: it would not resume.
  const started = await startStreamDownload(media, variant, { allowHelperFallback: false });
  if (started.ok || started.error === "DRM_PROTECTED_UNSUPPORTED" || started.error === "HELPER_OFFLINE") return started;

  // Usually an expired CDN token or a page-only site. Clicking download on
  // the page uses a fresh manifest URL and still resumes this job.
  if (/^https?:\/\//i.test(job.sourcePageUrl || "")) {
    await openOrFocusTab(job.sourcePageUrl);
    return { ok: false, error: "SOURCE_PAGE_OPENED" };
  }
  return started;
}

// The helper keeps the finished chunks; send the headers again because the
// job file never stores cookies.
async function resumeDirectHelperJob(job) {
  const headers = helperHeadersForMedia({ url: job.url, kind: "direct", sourcePageUrl: job.sourcePageUrl || "" });
  try {
    const response = await fetch(`${HELPER_URL}/jobs/${encodeURIComponent(job.id)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: payload.error || `HELPER_${response.status}` };
    return { ok: true, helperJob: payload.job, resumed: Boolean(payload.resumed) };
  } catch {
    return { ok: false, error: "HELPER_OFFLINE" };
  }
}

async function openOrFocusTab(url) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const existing = tabs.find((tab) => tab.url === url);
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url });
}

// --- Offscreen document and header-replay rules ---

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) ?? [];
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: [chrome.offscreen.Reason?.BLOBS || "BLOBS"],
      justification: "Fetch HLS segments as binary data and hand them to the local helper"
    }).catch((error) => {
      // A concurrent call already created it.
      if (!/single offscreen document/i.test(error?.message || "")) throw error;
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

// Replays the page's Referer/Origin/Cookie on the offscreen document's
// requests so the CDN sees them as the page's own. Scoped to requests made
// outside tabs and to the stream's hosts; page traffic is never modified.
function replayHeadersFor(media, manifestUrl) {
  const captured = [media.headers, cachedHeadersForUrl(manifestUrl), cachedHeadersForUrl(media.url)]
    .find((headers) => headers?.length) || [];
  const value = (name) => captured.find((h) => h.name?.toLowerCase() === name)?.value || "";
  return [
    ["referer", value("referer") || media.sourcePageUrl || ""],
    ["origin", value("origin") || originForUrl(media.sourcePageUrl)],
    ["cookie", value("cookie")]
  ]
    .filter(([, headerValue]) => headerValue)
    .map(([header, headerValue]) => ({ header, operation: "set", value: headerValue }));
}

async function addReplayRule(media, manifestUrl) {
  const requestHeaders = replayHeadersFor(media, manifestUrl);
  const host = replayableHost(manifestUrl);
  if (!requestHeaders.length || !host) return null;
  const id = 1 + Math.floor(Math.random() * 2_000_000_000);
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders },
      condition: {
        requestDomains: [host],
        tabIds: [chrome.tabs.TAB_ID_NONE ?? -1],
        resourceTypes: ["xmlhttprequest", "other"]
      }
    }]
  });
  return id;
}

async function allowReplayRuleHosts(ruleId, hosts) {
  if (!Number.isInteger(ruleId) || !Array.isArray(hosts) || !chrome.declarativeNetRequest) return;
  const [rule] = await chrome.declarativeNetRequest.getSessionRules({ ruleIds: [ruleId] });
  if (!rule) return;
  const current = rule.condition.requestDomains || [];
  const domains = [...new Set([...current, ...hosts.map(replayableHost).filter(Boolean)])];
  if (domains.length === current.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{ ...rule, condition: { ...rule.condition, requestDomains: domains } }]
  });
}

async function removeReplayRule(ruleId) {
  if (!Number.isInteger(ruleId) || !chrome.declarativeNetRequest) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
}

// Accepts a URL or a bare host; never rewrites traffic to the local helper.
function replayableHost(value) {
  let host = "";
  try { host = new URL(value).hostname; } catch { host = String(value || ""); }
  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host === "localhost" || host === "127.0.0.1") return "";
  return host;
}

// Session rules survive service-worker restarts; drop any whose job is no
// longer tracked (e.g. the extension reloaded mid-download).
async function cleanupOrphanReplayRules() {
  if (!chrome.declarativeNetRequest?.getSessionRules) return;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const stored = await chrome.storage.session.get(ACTIVE_DOWNLOADS_KEY);
  const live = new Set(Object.values(stored[ACTIVE_DOWNLOADS_KEY] || {}).map((entry) => entry.ruleId));
  const stale = rules.map((rule) => rule.id).filter((id) => !live.has(id));
  if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
}

// --- Active browser-fed downloads (jobId -> mode, source tab, rule) ---
// Kept in session storage so a service-worker restart does not forget them.

const ACTIVE_DOWNLOADS_KEY = "activeBrowserDownloads";
let activeDownloadsChain = Promise.resolve();

function mutateActiveDownloads(mutator) {
  const next = activeDownloadsChain.then(async () => {
    const stored = await chrome.storage.session.get(ACTIVE_DOWNLOADS_KEY);
    const active = stored[ACTIVE_DOWNLOADS_KEY] || {};
    const result = mutator(active);
    await chrome.storage.session.set({ [ACTIVE_DOWNLOADS_KEY]: active });
    return result;
  });
  // One failed storage call must not poison every later mutation.
  activeDownloadsChain = next.catch(() => {});
  return next;
}

async function trackActiveDownload(jobId, entry) {
  await mutateActiveDownloads((active) => { active[jobId] = entry; });
  // Page mode: Memory Saver would otherwise discard the tab and kill the
  // download loop. Extension mode does not depend on the tab.
  if (entry.mode === "page") await chrome.tabs.update(entry.tabId, { autoDiscardable: false }).catch(() => {});
}

async function untrackActiveDownload(jobId) {
  const { entry, tabStillBusy } = await mutateActiveDownloads((active) => {
    const entry = active[jobId];
    delete active[jobId];
    const tabStillBusy = Object.values(active)
      .some((other) => other.mode === "page" && other.tabId === entry?.tabId);
    return { entry, tabStillBusy };
  });
  await removeReplayRule(entry?.ruleId);
  if (entry?.mode === "page" && typeof entry.tabId === "number" && !tabStillBusy) {
    await chrome.tabs.update(entry.tabId, { autoDiscardable: true }).catch(() => {});
  }
  return entry || null;
}

async function failActiveDownloadsForTab(tabId, error) {
  const jobIds = await mutateActiveDownloads((active) => {
    const ids = Object.keys(active).filter((jobId) => active[jobId].mode === "page" && active[jobId].tabId === tabId);
    for (const jobId of ids) delete active[jobId];
    return ids;
  });
  await Promise.all(jobIds.map((jobId) => reportBrowserDownloadFailure(jobId, error)));
}

// The offscreen document finished a job. If the CDN blocked it (or it
// failed), the helper has kept the segments, so page mode resumes the rest.
async function handleOffscreenFinished(jobId, outcome) {
  const entry = await untrackActiveDownload(jobId);
  const status = outcome?.status;
  if (entry?.mode !== "extension" || !entry.media) return;
  if (status !== "blocked" && status !== "failed") return;
  console.warn("[ds] extension mode stopped (", outcome?.error, "), handing off to page mode");
  await startPageDownload(entry.media, entry.variant, { allowHelperFallback: false });
}

async function reportBrowserDownloadFailure(jobId, error) {
  if (!jobId) return;
  await fetch(`${HELPER_URL}/browser-downloads/${encodeURIComponent(jobId)}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error })
  }).catch(() => {});
}

async function startHelperDownload(media, variant, output = {}) {
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
        headers: helperHeadersForMedia({ ...media, url: downloadUrl }),
        ...output
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
      // /jobs reports the total at the top level, not inside stats.
      stats: jobs.stats ? { ...jobs.stats, total: Number.isInteger(jobs.total) ? jobs.total : jobsList.length } : null
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

// The folder picker takes focus, which closes the popup and its download
// dialog. The popup saved the dialog in session storage before asking; store
// the chosen folder there and reopen the popup so it restores the dialog.
async function reopenDownloadDialog(pickResult) {
  const key = "pendingDownloadDialog";
  const stored = await chrome.storage.session.get(key).catch(() => ({}));
  const state = stored?.[key];
  if (!state) return;
  if (pickResult?.ok && pickResult.settings?.downloadDir) {
    await chrome.storage.session.set({ [key]: { ...state, downloadDir: pickResult.settings.downloadDir } });
  }
  // Fails while the popup is still open, or without a focused Chrome window;
  // the dialog then comes back the next time the user opens the popup.
  await chrome.action.openPopup?.().catch(() => {});
}

// options: { initialDir, persist } — see pickDownloadFolder in helper/server.js.
async function pickHelperFolder(options = {}) {
  try {
    const response = await fetch(`${HELPER_URL}/pick-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options)
    });
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

function responseContentLength(headers, statusCode = 200) {
  const contentRange = headerValue(headers, "content-range");
  if (contentRange) {
    const total = Number(contentRange.split("/").pop());
    if (Number.isFinite(total) && total > 0) return total;
  }
  // A partial response's Content-Length is only the current byte range, not
  // the media size. Keep it unknown when the server omits Content-Range.
  if (statusCode === 206) return null;
  return numberHeader(headers, "content-length");
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
  const accept = media.kind === "dash"
    ? "application/dash+xml,*/*"
    : media.kind === "hls"
      ? "application/vnd.apple.mpegurl,*/*"
      : "video/*,audio/*,application/octet-stream,*/*";
  add("Accept", accept);
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

// Runs once per service-worker start, after every declaration above.
cleanupOrphanReplayRules().catch(() => {});
