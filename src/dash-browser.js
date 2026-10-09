// DASH (MPD) support for the browser download loop. The MPD is turned into
// one segment list per track (video, optional audio); each track is then
// written out as a local fMP4 HLS playlist, so the helper can mux it with
// the same ffmpeg path it uses for HLS. Only static (VOD), single-period,
// unencrypted MP4 streams are handled; everything else throws and the
// caller falls back to the helper's own ffmpeg download.

export function isDashManifest(text = "") {
  const head = String(text).trimStart();
  return !head.startsWith("#EXTM3U") && /<MPD\b/i.test(head);
}

/**
 * Lists the video qualities an MPD offers, best first, for the popup.
 * Returns { hasDrm, durationSeconds, variants: [{ url, quality, bandwidth }] }.
 */
export function listDashVariants(text = "", manifestUrl = "") {
  const hasDrm = /<ContentProtection\b/i.test(text);
  let mpd;
  try {
    mpd = findChild(parseXml(text), "MPD");
  } catch {
    mpd = null;
  }
  if (!mpd) return { hasDrm, durationSeconds: null, variants: [] };

  const period = children(mpd, "Period")[0];
  const durationSeconds = parseIsoDuration(period?.attrs.duration) || parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const byQuality = new Map();
  for (const rep of period ? collectRepresentations(period, "video") : []) {
    const quality = rep.height ? `${shortSide(rep)}p` : "";
    if (!quality) continue;
    const previous = byQuality.get(quality);
    if (!previous || rep.bandwidth > previous.bandwidth) {
      byQuality.set(quality, { url: manifestUrl, quality, bandwidth: rep.bandwidth || null });
    }
  }
  const variants = [...byQuality.values()].sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10));
  return { hasDrm, durationSeconds, variants };
}

/**
 * Picks the tracks to download and lists their segments.
 * Returns { durationSeconds, quality, trackKey, tracks: [{ type, init, segments, segmentBase }] }.
 * Tracks that use SegmentBase come back with segments = null and a
 * segmentBase { url, indexRange, initRange }; expandSegmentBase() fills them.
 */
export function buildDashTracks(text, manifestUrl, targetQuality = "") {
  if (/<ContentProtection\b/i.test(text)) throw new Error("DRM_PROTECTED_UNSUPPORTED");
  const mpd = findChild(parseXml(text), "MPD");
  if (!mpd) throw new Error("DASH_INVALID_MANIFEST");
  if ((mpd.attrs.type || "static") !== "static") throw new Error("DASH_LIVE_UNSUPPORTED");
  const periods = children(mpd, "Period");
  if (periods.length !== 1) throw new Error("DASH_MULTI_PERIOD_UNSUPPORTED");
  const period = periods[0];

  const durationSeconds = parseIsoDuration(period.attrs.duration) || parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const periodBase = resolveBase(resolveBase(manifestUrl, mpd), period);

  const video = pickVideo(collectRepresentations(period, "video"), targetQuality);
  const audio = pickDashAudio(collectRepresentations(period, "audio"));
  if (!video && !audio) throw new Error("DASH_NO_SUPPORTED_TRACKS");

  const tracks = [];
  if (video) tracks.push(buildTrack("video", video, periodBase, durationSeconds));
  if (audio) tracks.push(buildTrack("audio", audio, periodBase, durationSeconds));
  return {
    durationSeconds,
    quality: video?.height ? `${shortSide(video)}p` : "",
    // Identifies the chosen representations: one MPD serves every quality,
    // so the helper must not resume a job that picked different tracks.
    trackKey: [video?.id || "", audio?.id || ""].join("|"),
    tracks
  };
}

// Fills the segment list of SegmentBase tracks from their sidx box.
// fetchRange(url, byteRange) resolves to an ArrayBuffer with those bytes.
export async function expandSegmentBase(tracks, fetchRange) {
  for (const track of tracks) {
    if (track.segments) continue;
    const { url, indexRange, initRange } = track.segmentBase;
    const index = await fetchRange(url, indexRange);
    track.init = { url, byteRange: initRange || { offset: 0, length: indexRange.offset } };
    track.segments = parseSidx(index, indexRange.offset).map((ref) => ({ url, duration: ref.duration, byteRange: ref.byteRange }));
    if (!track.segments.length) throw new Error("DASH_NO_SEGMENTS");
  }
  return tracks;
}

/**
 * Names every file to download and builds the local playlists that point
 * at them. Segment names start with "seg-" because the helper counts those.
 */
export function buildDashAssetPlan(tracks) {
  const assets = [];
  const playlists = {};
  let segmentAssetCount = 0;
  for (const track of tracks) {
    const tag = track.type === "audio" ? "a" : "v";
    let initName = "";
    if (track.init) {
      initName = `init-${tag}.mp4`;
      assets.push({ url: track.init.url, name: initName, role: "map", byteRange: track.init.byteRange || null });
    }
    const names = track.segments.map((segment, index) => {
      const name = `seg-${tag}-${String(index).padStart(6, "0")}.m4s`;
      assets.push({ url: segment.url, name, role: "segment", byteRange: segment.byteRange || null });
      return name;
    });
    segmentAssetCount += names.length;
    playlists[track.type] = buildLocalPlaylist(initName, track.segments, names);
  }
  return { assets, segmentAssetCount, playlists };
}

// Chooses the audio track to pair with the video. reps are
// { id, bandwidth, lang, ... } from every audio AdaptationSet.
export function pickDashAudio(reps) {
  // TODO(user): pick the audio track (see the conversation for trade-offs).
  return [...reps].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
}

function pickVideo(reps, targetQuality) {
  const ranked = [...reps].sort((a, b) => shortSide(b) - shortSide(a) || b.bandwidth - a.bandwidth);
  return ranked.find((rep) => targetQuality && `${shortSide(rep)}p` === targetQuality) || ranked[0] || null;
}

function shortSide(rep) {
  return rep.width && rep.height ? Math.min(rep.width, rep.height) : rep.height || 0;
}

// Every MP4 Representation of the given type ("video" / "audio") in the
// period, with AdaptationSet attributes and segment info inherited.
function collectRepresentations(period, type) {
  const reps = [];
  for (const set of children(period, "AdaptationSet")) {
    for (const rep of children(set, "Representation")) {
      const mime = rep.attrs.mimeType || set.attrs.mimeType || "";
      const width = Number(rep.attrs.width || set.attrs.width) || 0;
      const height = Number(rep.attrs.height || set.attrs.height) || 0;
      const codecs = rep.attrs.codecs || set.attrs.codecs || "";
      const contentType = set.attrs.contentType || mime.split("/")[0] ||
        (width || height ? "video" : /^(?:mp4a|ac-3|ec-3|opus)/i.test(codecs) ? "audio" : "");
      if (contentType !== type) continue;
      if (mime && !/\/mp4$/i.test(mime)) continue; // WebM segments cannot go through an HLS playlist
      reps.push({
        id: rep.attrs.id || "",
        bandwidth: Number(rep.attrs.bandwidth) || 0,
        width,
        height,
        lang: rep.attrs.lang || set.attrs.lang || "",
        set,
        node: rep
      });
    }
  }
  return reps;
}

function buildTrack(type, rep, periodBase, periodSeconds) {
  const baseUrl = resolveBase(resolveBase(periodBase, rep.set), rep.node);
  const template = mergeTemplates(findChild(rep.set, "SegmentTemplate"), findChild(rep.node, "SegmentTemplate"));
  if (template) return { type, ...templateSegments(template, rep, baseUrl, periodSeconds) };

  const list = findChild(rep.node, "SegmentList") || findChild(rep.set, "SegmentList");
  if (list) return { type, ...listSegments(list, baseUrl, periodSeconds) };

  const base = findChild(rep.node, "SegmentBase") || findChild(rep.set, "SegmentBase");
  const indexRange = parseRange(base?.attrs.indexRange);
  if (!indexRange) throw new Error("DASH_SEGMENT_INDEX_MISSING");
  const initRange = parseRange(findChild(base, "Initialization")?.attrs.range);
  return { type, init: null, segments: null, segmentBase: { url: baseUrl, indexRange, initRange } };
}

function mergeTemplates(outer, inner) {
  if (!outer && !inner) return null;
  return {
    attrs: { ...(outer?.attrs || {}), ...(inner?.attrs || {}) },
    timeline: findChild(inner, "SegmentTimeline") || findChild(outer, "SegmentTimeline")
  };
}

function templateSegments(template, rep, baseUrl, periodSeconds) {
  const { attrs, timeline } = template;
  const timescale = Number(attrs.timescale) || 1;
  const startNumber = attrs.startNumber != null ? Number(attrs.startNumber) : 1;
  const fill = (pattern, number, time) => resolveUrl(expandTemplate(pattern, rep, number, time), baseUrl);
  const init = attrs.initialization ? { url: fill(attrs.initialization, startNumber, 0) } : null;
  if (!attrs.media) throw new Error("DASH_TEMPLATE_INVALID");

  const segments = [];
  if (timeline) {
    let time = 0;
    let number = startNumber;
    const endTime = periodSeconds ? periodSeconds * timescale + Number(attrs.presentationTimeOffset || 0) : Infinity;
    for (const s of children(timeline, "S")) {
      if (s.attrs.t != null) time = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      let repeat = Number(s.attrs.r || 0);
      if (!(d > 0)) throw new Error("DASH_TEMPLATE_INVALID");
      if (repeat < 0) {
        if (!Number.isFinite(endTime)) throw new Error("DASH_TEMPLATE_INVALID");
        repeat = Math.ceil((endTime - time) / d) - 1;
      }
      for (let i = 0; i <= repeat; i += 1) {
        segments.push({ url: fill(attrs.media, number, time), duration: d / timescale });
        time += d;
        number += 1;
      }
    }
  } else {
    const segmentSeconds = Number(attrs.duration) / timescale;
    if (!(segmentSeconds > 0) || !(periodSeconds > 0)) throw new Error("DASH_TEMPLATE_INVALID");
    const count = Math.ceil(periodSeconds / segmentSeconds - 1e-6);
    for (let i = 0; i < count; i += 1) {
      const duration = Math.min(segmentSeconds, periodSeconds - i * segmentSeconds);
      segments.push({ url: fill(attrs.media, startNumber + i, i * Number(attrs.duration)), duration });
    }
  }
  if (!segments.length) throw new Error("DASH_NO_SEGMENTS");
  return { init, segments };
}

function listSegments(list, baseUrl, periodSeconds) {
  const timescale = Number(list.attrs.timescale) || 1;
  const initNode = findChild(list, "Initialization");
  const init = initNode
    ? { url: resolveUrl(initNode.attrs.sourceURL || "", baseUrl), byteRange: parseRange(initNode.attrs.range) }
    : null;
  const urls = children(list, "SegmentURL");
  const fallbackSeconds = Number(list.attrs.duration) / timescale || (periodSeconds ? periodSeconds / urls.length : 1);
  const segments = urls.map((node) => ({
    url: resolveUrl(node.attrs.media || "", baseUrl),
    duration: fallbackSeconds,
    byteRange: parseRange(node.attrs.mediaRange)
  }));
  if (!segments.length) throw new Error("DASH_NO_SEGMENTS");
  return { init, segments };
}

function expandTemplate(pattern, rep, number, time) {
  return String(pattern).replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$|\$\$/g, (match, name, width) => {
    if (match === "$$") return "$";
    const value = { RepresentationID: rep.id, Number: number, Bandwidth: rep.bandwidth, Time: time }[name];
    return width ? String(value).padStart(Number(width), "0") : String(value);
  });
}

function buildLocalPlaylist(initName, segments, names) {
  const target = Math.max(1, Math.ceil(Math.max(...segments.map((s) => s.duration || 0))));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  if (initName) lines.push(`#EXT-X-MAP:URI="${initName}"`);
  segments.forEach((segment, index) => {
    lines.push(`#EXTINF:${(segment.duration || target).toFixed(3)},`, names[index]);
  });
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

// --- sidx (ISO BMFF segment index) ---

// bytes: the indexRange contents; fileOffset: where they start in the file.
export function parseSidx(bytes, fileOffset) {
  const view = new DataView(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
  let boxStart = 0;
  while (boxStart + 8 <= view.byteLength) {
    const size = view.getUint32(boxStart);
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + boxStart + 4, 4));
    if (type === "sidx") break;
    if (size < 8) throw new Error("DASH_SIDX_INVALID");
    boxStart += size;
  }
  if (boxStart + 8 > view.byteLength) throw new Error("DASH_SIDX_INVALID");

  const boxSize = view.getUint32(boxStart);
  const version = view.getUint8(boxStart + 8);
  let pos = boxStart + 16; // header, version/flags, reference_ID
  const timescale = view.getUint32(pos);
  pos += 4;
  let firstOffset;
  if (version === 0) {
    firstOffset = view.getUint32(pos + 4);
    pos += 8;
  } else {
    firstOffset = Number(view.getBigUint64(pos + 8));
    pos += 16;
  }
  const count = view.getUint16(pos + 2);
  pos += 4;

  let offset = fileOffset + boxStart + boxSize + firstOffset;
  const refs = [];
  for (let i = 0; i < count; i += 1) {
    const word = view.getUint32(pos);
    if (word >>> 31) throw new Error("DASH_SIDX_HIERARCHICAL_UNSUPPORTED");
    const length = word & 0x7fffffff;
    refs.push({ byteRange: { offset, length }, duration: view.getUint32(pos + 4) / timescale });
    offset += length;
    pos += 12;
  }
  return refs;
}

// --- Minimal XML reader (enough for MPDs; no DOMParser in the tests) ---

export function parseXml(text) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = token.exec(String(text)))) {
    const top = stack[stack.length - 1];
    if (match[1] != null) {
      top.text += match[1];
    } else if (match[2]) {
      const name = localName(match[2]);
      const index = stack.map((node) => node.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
    } else if (match[3]) {
      const node = { name: localName(match[3]), attrs: parseAttributes(match[4]), children: [], text: "" };
      top.children.push(node);
      if (!match[5]) stack.push(node);
    } else if (match[6]) {
      top.text += decodeEntities(match[6]);
    }
  }
  return root;
}

function parseAttributes(source = "") {
  const attrs = {};
  for (const [, name, , double, single] of source.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[localName(name)] = decodeEntities(double ?? single ?? "");
  }
  return attrs;
}

function localName(name) {
  return name.includes(":") && !name.startsWith("xmlns") ? name.split(":").pop() : name;
}

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

function children(node, name) {
  return (node?.children || []).filter((child) => child.name === name);
}

function findChild(node, name) {
  return children(node, name)[0] || null;
}

function resolveBase(base, node) {
  const text = findChild(node, "BaseURL")?.text.trim();
  return text ? resolveUrl(text, base) : base;
}

function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function parseRange(value) {
  const match = String(value || "").match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end >= start ? { offset: start, length: end - start + 1 } : null;
}

export function parseIsoDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return null;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  const seconds = Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  return seconds > 0 ? seconds : null;
}
