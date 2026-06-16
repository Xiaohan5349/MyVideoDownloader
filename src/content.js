// ⚠️ SYNC-POINT: Functions below are duplicated from src/shared.js.
// MV3 content scripts cannot import ES modules. When changing
// classifyMedia, detectExtension, normalizeMediaItem, inferQualityLabel,
// or DIRECT_EXTENSIONS in shared.js, you MUST manually sync here.
const MESSAGE_MEDIA_ADD_DETECTED = "media:addDetected";
const DIRECT_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
  "avi",
  "flv",
  "wmv",
  "mpg",
  "mpeg",
  "3gp",
  "m2ts",
  "mts",
  "ts",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "wav"
]);

const seenUrls = new Set();
let scanTimer = null;
let currentUrl = location.href;

scanDocument();
observePageChanges();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "page:rescan") {
    scanDocument();
    sendResponse({ ok: true });
  }
});

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
  scheduleScan();
}

function scheduleScan() {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(scanDocument, 250);
}

function scanDocument() {
  const items = [];
  scanAttribute(document.querySelectorAll("video[src], audio[src], source[src]"), "src", items);
  scanAttribute(document.querySelectorAll("a[href]"), "href", items);

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
      url,
      sourcePageUrl: location.href,
      title: readableTitle(node),
      extension: classified.extension,
      kind: classified.kind
    });
    if (item) items.push(item);
  }
}

function readableTitle(node) {
  return (
    node.getAttribute("download") ||
    node.getAttribute("title") ||
    node.getAttribute("aria-label") ||
    closestText(node) ||
    document.title ||
    "video"
  );
}

function closestText(node) {
  const container = node.closest?.("a, figure, article, section, div");
  const text = container?.textContent?.replace(/\s+/g, " ").trim();
  return text && text.length < 80 ? text : "";
}

function absoluteUrl(rawUrl) {
  try {
    return new URL(rawUrl, location.href).href;
  } catch {
    return "";
  }
}

function classifyMedia(url = "", contentType = "") {
  const extension = detectExtension(url, contentType);
  if (!extension) return null;
  if (extension === "m3u8") return { extension, kind: "hls" };
  if (extension === "mpd") return { extension, kind: "dash" };
  if (DIRECT_EXTENSIONS.has(extension)) return { extension, kind: "direct" };
  return null;
}

function detectExtension(url = "", contentType = "") {
  const cleanContentType = contentType.toLowerCase().split(";")[0].trim();
  if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"].includes(cleanContentType)) return "m3u8";
  if (cleanContentType === "application/dash+xml") return "mpd";
  if (cleanContentType === "video/mp4") return "mp4";
  if (cleanContentType === "video/webm") return "webm";
  if (cleanContentType === "video/quicktime") return "mov";
  if (cleanContentType === "audio/mpeg") return "mp3";

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeMediaItem(input) {
  const classified = classifyMedia(input.url, "");
  if (!classified) return null;
  const sourcePageUrl = input.sourcePageUrl || "";
  return {
    id: `${sourcePageUrl || "unknown"}::${input.url}`,
    url: input.url,
    sourcePageUrl,
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
  const direct = text.match(/(?:^|[^0-9])((?:2160|1440|1080|720|576|540|480|360|240|144))p(?:[^0-9]|$)/);
  if (direct?.[1]) return `${direct[1]}p`;

  const resolution = text.match(/(?:^|[^0-9])(\d{3,5})x((?:2160|1440|1080|720|576|540|480|360|240|144))(?:[^0-9]|$)/);
  if (resolution?.[2]) return `${resolution[2]}p`;

  const folder = text.match(/(?:\/|_|-)((?:2160|1440|1080|720|576|540|480|360|240|144))(?:\/|_|-|$)/);
  if (folder?.[1]) return `${folder[1]}p`;

  return "";
}