export function parseHlsMediaPlaylist(text = "", manifestUrl = "") {
  const lines = String(text).split(/\r?\n/);
  const segments = [];
  const keys = [];
  const maps = [];
  const seenKeys = new Set();
  const seenMaps = new Set();
  let hasDrm = false;
  let isMaster = false;
  let pendingDuration = null;
  let durationSeconds = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      isMaster = true;
      pendingDuration = null;
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      hasDrm = hasDrm || isProtectedHlsKey(line);
      const method = readAttribute(line, "METHOD").toUpperCase();
      const uri = readAttribute(line, "URI");
      if (method === "AES-128" && uri && !isProtectedHlsKey(line)) {
        const resolved = resolveUrl(uri, manifestUrl);
        if (!seenKeys.has(resolved)) {
          seenKeys.add(resolved);
          keys.push({ url: resolved, line });
        }
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const uri = readAttribute(line, "URI");
      if (uri) {
        const resolved = resolveUrl(uri, manifestUrl);
        if (!seenMaps.has(resolved)) {
          seenMaps.add(resolved);
          maps.push({ url: resolved, line });
        }
      }
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      pendingDuration = Number(line.match(/^#EXTINF:([\d.]+)/i)?.[1]);
      if (!Number.isFinite(pendingDuration)) pendingDuration = null;
      continue;
    }

    if (!line.startsWith("#")) {
      if (!isMaster && (pendingDuration != null || segments.length > 0)) {
        const duration = pendingDuration || null;
        if (duration) durationSeconds += duration;
        segments.push({ url: resolveUrl(line, manifestUrl), duration });
      }
      pendingDuration = null;
    }
  }

  return {
    isMaster,
    hasDrm,
    durationSeconds: durationSeconds || null,
    keys,
    maps,
    segments
  };
}

export function buildLocalHlsPlaylist(text = "", manifestUrl = "", assetNameByUrl = new Map()) {
  const lines = String(text).split(/\r?\n/);
  return lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
      const uri = readAttribute(line, "URI");
      if (!uri) return rawLine;
      const localName = assetNameByUrl.get(resolveUrl(uri, manifestUrl));
      return localName ? replaceUriAttribute(rawLine, localName) : rawLine;
    }

    if (line.startsWith("#")) return rawLine;
    const localName = assetNameByUrl.get(resolveUrl(line, manifestUrl));
    return localName || rawLine;
  }).join("\n").replace(/\n+$/g, "");
}

export function isProtectedHlsKey(line = "") {
  return /METHOD=SAMPLE-AES/i.test(line) ||
    /KEYFORMAT=/i.test(line) ||
    /URI=["']?skd:\/\//i.test(line);
}

function readAttribute(line, key) {
  const match = String(line).match(new RegExp(`${key}=("([^"]*)"|'([^']*)'|[^,]+)`, "i"));
  return (match?.[2] ?? match?.[3] ?? match?.[1] ?? "").replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

function replaceUriAttribute(line, uri) {
  const escaped = String(uri).replace(/"/g, "%22");
  if (/URI="[^"]*"/i.test(line)) return line.replace(/URI="[^"]*"/i, `URI="${escaped}"`);
  if (/URI='[^']*'/i.test(line)) return line.replace(/URI='[^']*'/i, `URI="${escaped}"`);
  return line.replace(/URI=[^,]+/i, `URI="${escaped}"`);
}

function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}
