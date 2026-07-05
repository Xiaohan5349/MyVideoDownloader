export const MESSAGE = Object.freeze({
  MEDIA_ADD_DETECTED: "media:addDetected",
  MEDIA_GET_FOR_TAB: "media:getForTab",
  DOWNLOADS_START: "downloads:start",
  DOWNLOADS_JOB_GET: "downloads:jobGet",
  DOWNLOADS_JOB_SHOW: "downloads:jobShow",
  DOWNLOADS_JOB_DELETE: "downloads:jobDelete",
  DOWNLOADS_JOB_CANCEL: "downloads:jobCancel",
  HELPER_STATUS_GET: "helper:statusGet",
  HELPER_SETTINGS_UPDATE: "helper:settingsUpdate",
  HELPER_FOLDER_PICK: "helper:folderPick",
  STREAM_VARIANTS_GET: "streams:getVariants",
  SETTINGS_GET: "settings:get",
  SETTINGS_UPDATE: "settings:update"
});

export const DEFAULT_SETTINGS = Object.freeze({
  minSizeBytes: 1024 * 1024,
  showUnsupported: true,
  filenameTemplate: "{title}"
});

export const DIRECT_EXTENSIONS = new Set([
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

export const MANIFEST_EXTENSIONS = new Set(["m3u8", "mpd"]);

// Segment files: HLS/DASH fragments that should NOT show as standalone media.
// These are downloaded as part of a stream, not useful individually.
export const SEGMENT_EXTENSIONS = new Set([
  "m4s",  // DASH segment
  "jpeg", // obfuscated HLS segment (used by some CDNs)
  "jpg",
  "png",
  "gif",
  "webp",
  "mp2t"
]);

export function isSegmentFile(url = "", contentType = "") {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // Image/segment extensions used as obfuscated video segments
    if (/\.(m4s|jpeg|jpg|png|gif|webp|mp2t|vtt)(?:[?#]|$)/.test(path)) return true;
    // Numbered .ts segments (e.g. /602930.ts)
    if (/\/\d+\.ts(?:[?#]|$)/.test(path)) return true;
    // Named .ts segments (e.g. /seg-000001.ts, /segment_42.ts)
    if (/\/seg(?:ment)?[-_]?\d+\.ts(?:[?#]|$)/i.test(path)) return true;
    // Hex-named .ts segments (e.g. /98639578bfa59372.ts)
    if (/\/[0-9a-f]{8,}\.ts(?:[?#]|$)/i.test(path)) return true;
    // Non-video .ts files (e.g. /thumbvtt.ts)
    if (/\/(?:thumb|subtitle|caption|vtt|key|init)\.ts/i.test(path)) return true;
  } catch {}
  const ext = detectExtension(url, contentType);
  return ext ? SEGMENT_EXTENSIONS.has(ext) : false;
}

const MIME_TYPES = [
  ["application/vnd.apple.mpegurl", "m3u8"],
  ["application/x-mpegurl", "m3u8"],
  ["audio/mpegurl", "m3u8"],
  ["application/dash+xml", "mpd"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mov"],
  ["video/x-matroska", "mkv"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/aac", "aac"],
  ["audio/flac", "flac"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"]
];

export function detectExtension(url = "", contentType = "") {
  const cleanContentType = contentType.toLowerCase().split(";")[0].trim();
  for (const [mime, extension] of MIME_TYPES) {
    if (cleanContentType === mime) return extension;
  }

  try {
    const parsed = new URL(url);
    const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (match?.[1]) return match[1];
    const decoded = decodeURIComponent(parsed.href).toLowerCase();
    const embeddedMatch = decoded.match(/\.(m3u8|mpd|mp4|webm|mov|m4v)(?:[?#&]|$)/);
    if (embeddedMatch?.[1]) return embeddedMatch[1];
  } catch {
    const match = String(url).toLowerCase().split("?")[0].match(/\.([a-z0-9]{2,5})$/);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function classifyMedia(url = "", contentType = "") {
  const extension = detectExtension(url, contentType);
  if (!extension) return null;
  if (extension === "m3u8") return { extension, kind: "hls" };
  if (extension === "mpd") return { extension, kind: "dash" };
  if (DIRECT_EXTENSIONS.has(extension)) return { extension, kind: "direct" };
  return null;
}

export function sanitizeFilename(name = "video", extension = "") {
  const base = String(name || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
  const cleanExtension = String(extension || "").replace(/^\./, "").toLowerCase();
  return cleanExtension && !base.toLowerCase().endsWith(`.${cleanExtension}`)
    ? `${base}.${cleanExtension}`
    : base;
}

export function makeMediaId(url, sourcePageUrl = "") {
  return `${sourcePageUrl || "unknown"}::${url}`;
}

export function mergeSettings(raw = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined && value !== null)
    )
  };
}

export function normalizeMediaItem(input, fallback = {}) {
  if (!input?.url || typeof input.url !== "string") return null;
  const classified = classifyMedia(input.url, input.contentType || "");
  if (!classified) return null;
  const sourcePageUrl = input.sourcePageUrl || fallback.sourcePageUrl || "";
  const title = input.title || fallback.title || "video";
  const extension = input.extension?.replace(/^\./, "") || classified.extension;

  return {
    id: input.id || makeMediaId(input.url, sourcePageUrl),
    url: input.url,
    sourcePageUrl,
    title,
    extension,
    kind: input.kind || classified.kind,
    quality: input.quality || inferQualityLabel(input.url) || "",
    size: Number.isFinite(input.size) ? input.size : null,
    estimatedSize: Number.isFinite(input.estimatedSize) ? input.estimatedSize : null,
    sizeSource: input.sizeSource || "",
    durationSeconds: Number.isFinite(input.durationSeconds) ? input.durationSeconds : null,
    bandwidth: Number.isFinite(input.bandwidth) ? input.bandwidth : null,
    headers: Array.isArray(input.headers) ? input.headers : [],
    variants: Array.isArray(input.variants) ? input.variants : [],
    detectedAt: input.detectedAt || Date.now(),
    isProtected: Boolean(input.isProtected),
    unsupportedReason: input.unsupportedReason || ""
  };
}

export function addUniqueMedia(existing = [], additions = []) {
  const byId = new Map(existing.map((item) => [item.id || makeMediaId(item.url, item.sourcePageUrl), item]));
  for (const addition of additions) {
    const item = normalizeMediaItem(addition);
    if (!item) continue;
    byId.set(item.id, { ...byId.get(item.id), ...item });
  }
  return Array.from(byId.values()).sort((a, b) => b.detectedAt - a.detectedAt);
}

export function parseHlsManifest(text = "", manifestUrl = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  let pendingVariant = null;
  let hasDrm = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      hasDrm = hasDrm || isProtectedHlsKey(line);
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      pendingVariant = {
        bandwidth: readAttribute(line, "BANDWIDTH"),
        resolution: readAttribute(line, "RESOLUTION")
      };
      continue;
    }
    if (!line.startsWith("#") && pendingVariant) {
      variants.push({
        url: resolveUrl(line, manifestUrl),
        quality: qualityLabel(pendingVariant.resolution, pendingVariant.bandwidth),
        bandwidth: pendingVariant.bandwidth ? Number(pendingVariant.bandwidth) : null,
        estimatedSize: null,
        durationSeconds: null
      });
      pendingVariant = null;
    }
  }

  const durationSeconds = parseHlsDurationSeconds(lines);
  return { hasDrm, variants, durationSeconds };
}

export function inferQualityLabel(value = "") {
  const text = decodeURIComponent(String(value)).toLowerCase();
  const direct = text.match(/(?:^|[^0-9])((?:2160|1440|1080|720|576|540|480|360|240|180|144))p(?:[^0-9]|$)/);
  if (direct?.[1]) return `${direct[1]}p`;

  const resolution = text.match(/(?:^|[^0-9])(\d{3,5})x((?:2160|1440|1080|720|576|540|480|360|240|180|144))(?:[^0-9]|$)/);
  if (resolution?.[2]) return `${resolution[2]}p`;

  const folder = text.match(/(?:\/|_|-)((?:2160|1440|1080|720|576|540|480|360|240|180|144))(?:\/|_|-|$)/);
  if (folder?.[1]) return `${folder[1]}p`;

  return "";
}

export function parseDashManifest(text = "", manifestUrl = "") {
  const hasDrm = /<ContentProtection\b/i.test(text);
  const variants = [];
  const representationPattern = /<Representation\b([^>]*)>/gi;
  let match;

  while ((match = representationPattern.exec(text))) {
    const attrs = match[1] || "";
    const bandwidth = readXmlAttribute(attrs, "bandwidth");
    const width = readXmlAttribute(attrs, "width");
    const height = readXmlAttribute(attrs, "height");
    variants.push({
      url: manifestUrl,
      quality: qualityLabel(width && height ? `${width}x${height}` : "", bandwidth),
      bandwidth: bandwidth ? Number(bandwidth) : null
    });
  }

  return { hasDrm, variants };
}

function readAttribute(line, key) {
  const match = line.match(new RegExp(`${key}=([^,]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "") || "";
}

function isProtectedHlsKey(line) {
  return /METHOD=SAMPLE-AES/i.test(line) ||
    /KEYFORMAT=/i.test(line) ||
    /URI=["']?skd:\/\//i.test(line);
}

function readXmlAttribute(attrs, key) {
  const match = attrs.match(new RegExp(`(?:^|\\s)${key}=["']([^"']+)["']`, "i"));
  return match?.[1] || "";
}

function bitrateLabel(value) {
  const bitrate = Number(value);
  return Number.isFinite(bitrate) && bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : "";
}

function qualityLabel(resolution, bandwidth) {
  const match = String(resolution || "").match(/(\d{2,5})x(\d{2,5})/i);
  if (match?.[2]) return `${match[2]}p`;
  return bitrateLabel(bandwidth);
}

export function estimateBytes(durationSeconds, bandwidth) {
  const duration = Number(durationSeconds);
  const bitrate = Number(bandwidth);
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(bitrate) && bitrate > 0
    ? Math.round((duration * bitrate) / 8)
    : null;
}

export function fallbackBandwidthForQuality(quality = "") {
  const height = Number(String(quality).match(/(\d+)p/)?.[1]);
  if (!Number.isFinite(height)) return null;
  if (height >= 2160) return 16_000_000;
  if (height >= 1440) return 8_000_000;
  if (height >= 1080) return 5_000_000;
  if (height >= 720) return 2_800_000;
  if (height >= 480) return 1_400_000;
  if (height >= 360) return 800_000;
  return 450_000;
}

function parseHlsDurationSeconds(lines) {
  const total = lines
    .filter((line) => line.startsWith("#EXTINF"))
    .map((line) => Number(line.match(/^#EXTINF:([\d.]+)/i)?.[1]))
    .reduce((sum, duration) => Number.isFinite(duration) ? sum + duration : sum, 0);
  return total > 0 ? total : null;
}

function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}
