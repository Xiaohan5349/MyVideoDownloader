// ⚠️ SYNC-POINT: Functions below are duplicated from src/shared.js.
// MV3 content scripts cannot import ES modules. When changing
// classifyMedia, detectExtension, normalizeMediaItem, inferQualityLabel,
// or DIRECT_EXTENSIONS in shared.js, you MUST manually sync here.
const MESSAGE_MEDIA_ADD_DETECTED = "media:addDetected";
const DIRECT_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "m4v", "mkv", "avi", "flv", "wmv",
  "mpg", "mpeg", "3gp", "m2ts", "mts", "ts",
  "mp3", "m4a", "aac", "flac", "ogg", "wav"
]);

const seenUrls = new Set();
let scanTimer = null;
let currentUrl = location.href;
const SEGMENT_FETCH_TIMEOUT_MS = 30_000;
const SEGMENT_FETCH_RETRIES = 3;
let hlsBrowserModulePromise = null;

scanDocument();
observePageChanges();

// Listen for stream URLs found by inject-main.js (MAIN world)
document.addEventListener("ds-video-downloader-found", (event) => {
  try {
    const { findings } = event.detail || {};
    if (!findings?.length) return;
    const items = [];
    for (const f of findings) {
      const urls = extractM3u8Urls(f.text || "");
      for (const rawUrl of urls) {
        const url = absoluteUrl(rawUrl);
        if (!url || seenUrls.has(url)) continue;
        const classified = classifyMedia(url, "");
        if (!classified) continue;
        seenUrls.add(url);
        const item = normalizeMediaItem({
          url, sourcePageUrl: location.href, title: document.title || "video",
          extension: classified.extension, kind: classified.kind
        });
        if (item) items.push(item);
      }
    }
    if (items.length) {
      chrome.runtime.sendMessage({
        type: MESSAGE_MEDIA_ADD_DETECTED,
        sourcePageUrl: location.href,
        title: document.title || "video",
        items
      }).catch(() => {});
    }
  } catch (_) {}
});

function extractM3u8Urls(text) {
  if (!text) return [];
  const urls = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd)(?:[^\s"'<>\\]*)/gi;
  for (const m of String(text).matchAll(re)) urls.add(m[0]);
  return Array.from(urls);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Rescan page
  if (message?.type === "page:rescan") {
    seenUrls.clear();
    scanDocument();
    sendResponse({ ok: true });
    return;
  }

  // Fetch a URL from content script context (has page's Referer/TLS/cookies)
  // The background and helper CANNOT access Cloudflare-protected CDNs.
  if (message?.type === "page:fetchText") {
    fetchTextFromPage(message.url || "")
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true; // async response
  }

  // Full HLS download: fetch manifest → parse segments → fetch + upload
  if (message?.type === "page:downloadStream") {
    console.warn("[ds-content] page:downloadStream received url=", (message.payload?.manifestUrl || "").slice(0, 80));
    handleStreamDownload(message.payload || {})
      .then((result) => {
        console.warn("[ds-content] page:downloadStream result ok=", result?.ok, "error=", result?.error);
        sendResponse(result);
      })
      .catch((err) => {
        console.warn("[ds-content] page:downloadStream error=", err.message);
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true;
  }
});

// --- Simple fetch from page context ---
async function fetchTextFromPage(url) {
  console.warn("[ds-content] fetchTextFromPage url=", url.slice(0, 100));
  // Minimal fetch: no custom headers, no credentials flag.
  // Custom headers + credentials:include triggers CORS preflight
  // which can cause "Failed to fetch" on protected CDNs.
  // The browser sends cookies for the target domain automatically.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEGMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    console.warn("[ds-content] fetchTextFromPage status=", response.status);
    if (!response.ok) {
      throw new Error(response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `FETCH_${response.status}`);
    }
    return await response.text();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("FETCH_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// --- Full stream download from page context ---
async function handleStreamDownload(payload) {
  const { helperUrl, manifestUrl, quality, title, sourcePageUrl } = payload;
  console.warn("[ds-content] handleStreamDownload start manifestUrl=", manifestUrl?.slice(0, 80));
  if (!helperUrl || !manifestUrl) throw new Error("INVALID_DOWNLOAD_REQUEST");

  // Step 1: Fetch master playlist
  const masterText = await fetchTextFromPage(manifestUrl);
  console.warn("[ds-content] master playlist fetched, length=", masterText.length);

  // Step 2: Parse with simple inline parser
  const master = parseHlsMaster(masterText, manifestUrl);
  if (master.hasDrm) throw new Error("DRM_PROTECTED_UNSUPPORTED");

  // Step 3: Pick variant
  let variantUrl = manifestUrl;
  if (master.variants.length) {
    const picked = pickVariant(master.variants, quality);
    variantUrl = picked.url;
  }

  // Step 4: Fetch media playlist
  const mediaText = await fetchTextFromPage(variantUrl);

  // Step 5: Build a complete local asset plan, including accessible AES-128 keys and init maps.
  const {
    buildHlsAssetPlan,
    buildLocalHlsPlaylist,
    parseHlsMediaPlaylist
  } = await getHlsBrowserModule();
  const mediaPlaylist = parseHlsMediaPlaylist(mediaText, variantUrl);
  if (mediaPlaylist.hasDrm) throw new Error("DRM_PROTECTED_UNSUPPORTED");
  if (!mediaPlaylist.segments.length) throw new Error("HLS_NO_SEGMENTS");
  const plan = buildHlsAssetPlan(mediaPlaylist);

  // Step 6: Create helper job
  const startRes = await fetch(`${helperUrl}/browser-downloads/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: variantUrl,
      title: title || "video",
      totalSegments: plan.segmentAssetCount,
      durationSeconds: mediaPlaylist.durationSeconds,
      sourcePageUrl: sourcePageUrl || location.href
    })
  });
  const startPayload = await startRes.json().catch(() => ({}));
  if (!startRes.ok) throw new Error(startPayload.error || `HELPER_${startRes.status}`);
  const job = startPayload.job;

  // Step 7: Fetch and upload segments in parallel (8 at a time)
  const concurrency = 8;
  const assets = plan.assets;

  let completed = 0;
  const total = assets.length;
  const failed = [];
  let cancelled = false;

  // Parallel fetch + upload with concurrency control
  const running = new Set();
  let idx = 0;

  async function processOne(asset) {
    // Check cancelled
    try {
      const checkRes = await fetch(`${helperUrl}/jobs/${encodeURIComponent(job.id)}`);
      if (checkRes.ok) {
        const j = await checkRes.json().catch(() => ({}));
        if (j.status === "cancelled" || j.status === "failed") {
          cancelled = true;
          return;
        }
      }
    } catch (_) {}

    const data = await fetchSegmentWithRetry(asset.url);

    // Upload to helper
    const upRes = await fetchWithTimeout(
      `${helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/files/${encodeURIComponent(asset.name)}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: data },
      SEGMENT_FETCH_TIMEOUT_MS
    );
    if (!upRes.ok) throw new Error(`UPLOAD_${upRes.status}`);

    completed += 1;
  }

  // Simple concurrency loop
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) {
    workers.push((async () => {
      while (idx < total && !cancelled) {
        const currentIdx = idx++;
        try {
          await processOne(assets[currentIdx]);
        } catch (e) {
          console.warn("[ds-video-downloader] segment failed", currentIdx, e.message);
          failed.push({ index: currentIdx, error: e.message });
        }
      }
    })());
  }
  await Promise.all(workers);

  if (cancelled) return { ok: false, error: "JOB_CANCELLED" };
  if (failed.length) {
    await fetch(`${helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `SEGMENT_DOWNLOAD_FAILED: ${failed.length}/${total}` })
    }).catch(() => {});
    return { ok: false, error: "SEGMENT_DOWNLOAD_FAILED" };
  }

  // Step 8: Build local playlist and complete
  const localPlaylist = buildLocalHlsPlaylist(mediaText, variantUrl, plan.assetNameByUrl);
  const completeRes = await fetch(
    `${helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistText: localPlaylist })
    }
  );
  if (!completeRes.ok) throw new Error(`HELPER_COMPLETE_${completeRes.status}`);

  return { ok: true, helperJob: job, completed, total };
}

function getHlsBrowserModule() {
  if (!hlsBrowserModulePromise) {
    hlsBrowserModulePromise = import(chrome.runtime.getURL("src/hls-browser.js"));
  }
  return hlsBrowserModulePromise;
}

async function fetchSegmentWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= SEGMENT_FETCH_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEGMENT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`SEGMENT_${response.status}`);
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("SEGMENT_TIMEOUT") : error;
      if (attempt < SEGMENT_FETCH_RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SEGMENT_DOWNLOAD_FAILED");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("HELPER_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// --- Inline HLS parsing (no ES module imports in content scripts) ---

function parseHlsMaster(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const variants = [];
  let hasDrm = false;
  let pending = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      if (/METHOD=SAMPLE-AES/i.test(line) || /KEYFORMAT=/i.test(line) || /URI=["']?skd:\/\//i.test(line)) {
        hasDrm = true;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bandwidth = readAttr(line, "BANDWIDTH");
      const resolution = readAttr(line, "RESOLUTION");
      pending = { bandwidth: Number(bandwidth) || null, resolution };
      continue;
    }
    if (!line.startsWith("#") && pending) {
      const quality = qualityFromResolution(pending.resolution);
      variants.push({
        url: resolveUrl(line, baseUrl),
        quality,
        bandwidth: pending.bandwidth
      });
      pending = null;
    }
  }

  return { hasDrm, variants };
}

function pickVariant(variants, targetQuality) {
  if (targetQuality) {
    const found = variants.find((v) => v.quality === targetQuality);
    if (found) return found;
  }
  // Pick highest quality
  return [...variants].sort((a, b) => variantScore(b) - variantScore(a))[0];
}

function variantScore(v) {
  const h = Number((v.quality || "").match(/(\d+)p/)?.[1] || 0);
  return h + (v.bandwidth || 0) / 10000000;
}

function qualityFromResolution(resolution) {
  if (!resolution) return "";
  const m = String(resolution).match(/(\d{2,5})x(\d{2,5})/i);
  return m?.[2] ? `${m[2]}p` : "";
}

function readAttr(line, key) {
  const m = line.match(new RegExp(`${key}=([^,]+)`, "i"));
  return m?.[1]?.replace(/^"|"$/g, "") || "";
}

function resolveUrl(url, base) {
  try { return new URL(url, base).href; } catch { return url; }
}

// --- DOM scanning (original logic, unchanged) ---

function observePageChanges() {
  const observer = new MutationObserver(() => scheduleScan());
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href"] });
  }
  window.addEventListener("popstate", handlePotentialNavigation);
  window.addEventListener("hashchange", handlePotentialNavigation);
  window.setInterval(handlePotentialNavigation, 1000);
}

function handlePotentialNavigation() {
  if (currentUrl === location.href) return;
  currentUrl = location.href;
  seenUrls.clear();
  // Tell background to clear stale media for this tab
  chrome.runtime.sendMessage({
    type: "page:clearMedia",
    sourcePageUrl: location.href
  }).catch(() => {});
  scheduleScan();
}

function scheduleScan() {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(scanDocument, 250);
}

function scanDocument() {
  const items = [];
  scanAttribute(document.querySelectorAll("video[src], audio[src], source[src]"), "src", items);
  // Intentionally NOT scanning <a href> — too many false positives on listing pages
  scanScriptText(document.querySelectorAll("script"), items);

  if (!items.length) return;
  chrome.runtime.sendMessage({
    type: MESSAGE_MEDIA_ADD_DETECTED,
    sourcePageUrl: location.href,
    title: document.title || "video",
    items
  });
}

function scanAttribute(nodes, attribute, items) {
  for (const node of nodes) {
    const rawUrl = node.getAttribute(attribute);
    if (!rawUrl) continue;
    const url = absoluteUrl(rawUrl);
    if (!url || seenUrls.has(url)) continue;
    const classified = classifyMedia(url, node.getAttribute("type") || "");
    if (!classified) continue;
    seenUrls.add(url);
    const item = normalizeMediaItem({
      url, sourcePageUrl: location.href, title: readableTitle(node),
      extension: classified.extension, kind: classified.kind
    });
    if (item) items.push(item);
  }
}

function readableTitle(node) {
  return node.getAttribute("download") || node.getAttribute("title") ||
    node.getAttribute("aria-label") || closestText(node) || document.title || "video";
}

function closestText(node) {
  const container = node.closest?.("a, figure, article, section, div");
  const text = container?.textContent?.replace(/\s+/g, " ").trim();
  return text && text.length < 80 ? text : "";
}

function absoluteUrl(rawUrl) {
  try { return new URL(rawUrl, location.href).href; } catch { return ""; }
}

function classifyMedia(url = "", contentType = "") {
  const ext = detectExtension(url, contentType);
  if (!ext) return null;
  if (ext === "m3u8") return { extension: ext, kind: "hls" };
  if (ext === "mpd") return { extension: ext, kind: "dash" };
  // .ts files are HLS segments — never useful standalone from DOM scan
  if (ext === "ts") return null;
  if (DIRECT_EXTENSIONS.has(ext)) return { extension: ext, kind: "direct" };
  return null;
}

function detectExtension(url = "", contentType = "") {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"].includes(ct)) return "m3u8";
  if (ct === "application/dash+xml") return "mpd";
  if (ct === "video/mp4") return "mp4";
  if (ct === "video/webm") return "webm";
  if (ct === "video/quicktime") return "mov";
  if (ct === "audio/mpeg") return "mp3";
  try {
    const parsed = new URL(url);
    const m = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (m?.[1]) return m[1];
    const decoded = decodeURIComponent(parsed.href).toLowerCase();
    const em = decoded.match(/\.(m3u8|mpd|mp4|webm|mov|m4v)(?:[?#&]|$)/);
    return em?.[1] || null;
  } catch { return null; }
}

function normalizeMediaItem(input) {
  const classified = classifyMedia(input.url, "");
  if (!classified) return null;
  return {
    id: `${input.sourcePageUrl || "unknown"}::${input.url}`,
    url: input.url,
    sourcePageUrl: input.sourcePageUrl || "",
    title: input.title || "video",
    extension: input.extension || classified.extension,
    kind: input.kind || classified.kind,
    quality: inferQualityLabel(input.url),
    size: null,
    headers: [],
    detectedAt: Date.now(),
    isProtected: false,
    unsupportedReason: ""
  };
}

function inferQualityLabel(value = "") {
  const text = decodeURIComponent(String(value)).toLowerCase();
  const direct = text.match(/(?:^|[^0-9])((?:2160|1440|1080|720|576|540|480|360|240|180|144))p(?:[^0-9]|$)/);
  if (direct?.[1]) return `${direct[1]}p`;
  const resolution = text.match(/(?:^|[^0-9])(\d{3,5})x((?:2160|1440|1080|720|576|540|480|360|240|180|144))(?:[^0-9]|$)/);
  if (resolution?.[2]) return `${resolution[2]}p`;
  const folder = text.match(/(?:\/|_|-)((?:2160|1440|1080|720|576|540|480|360|240|180|144))(?:\/|_|-|$)/);
  if (folder?.[1]) return `${folder[1]}p`;
  return "";
}

function scanScriptText(nodes, items) {
  for (const node of nodes) {
    const text = node.textContent || "";
    if (!text || text.length > 2000000) continue;
    for (const rawUrl of extractMediaUrls(text)) {
      const url = absoluteUrl(rawUrl);
      if (!url || seenUrls.has(url)) continue;
      const classified = classifyMedia(url, "");
      if (!classified) continue;
      seenUrls.add(url);
      const item = normalizeMediaItem({
        url, sourcePageUrl: location.href, title: document.title || "video",
        extension: classified.extension, kind: classified.kind
      });
      if (item) items.push(item);
    }
  }
}

function extractMediaUrls(text) {
  const normalized = decodeScriptText(text);
  const urls = new Set();
  const absPat = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:[?#][^\s"'<>\\]*)?/gi;
  const relPat = /(?:^|[\s"'(])((?:\/|\.\.?\/)[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:[?#][^\s"'<>\\]*)?)/gi;
  for (const m of normalized.matchAll(absPat)) {
    urls.add(m[0].startsWith("//") ? `${location.protocol}${m[0]}` : m[0]);
  }
  for (const m of normalized.matchAll(relPat)) {
    if (m[1]) urls.add(m[1]);
  }
  return Array.from(urls).filter(Boolean).map((v) => String(v).replace(/[),.;\]]+$/g, "").replace(/^["']|["']$/g, ""));
}

function decodeScriptText(text) {
  return String(text).replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
}
