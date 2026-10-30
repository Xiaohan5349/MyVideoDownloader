// Browser API adapter; URLs and request context are never storage records.
export class BilibiliError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Collections put every episode into the view metadata, which can reach a few MB.
export const API_MAX_BYTES = 16 * 1024 * 1024;
export const QUALITY_ORDER = [16, 32, 64, 74, 80, 112, 116, 120, 125, 126, 127];
const fail = (code) => { throw new BilibiliError(code); };

export function parseBvUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("UNSUPPORTED_SOURCE"); }
  const match = /^\/(?:zh-Hans\/)?video\/(BV[\da-zA-Z]{10})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(url.hostname) || url.port || url.username || url.password || !match) fail("UNSUPPORTED_SOURCE");
  const parts = url.searchParams.getAll("p");
  if (parts.length > 1 || (parts.length && (!/^[1-9]\d*$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0]))))) fail("INVALID_PART");
  return { bvid: match[1], p: parts.length ? Number(parts[0]) : null };
}

function normalizeDetails(data, bvid) {
  if (data?.bvid !== bvid || !Array.isArray(data.pages) || !data.pages.length) fail("INVALID_VIDEO_DETAILS");
  const seen = new Set();
  const pages = data.pages.map((page) => {
    const cid = String(page.cid);
    if (!Number.isSafeInteger(page.page) || page.page < 1 || seen.has(page.page) || !/^[1-9]\d*$/.test(cid) || (typeof page.cid === "number" && !Number.isSafeInteger(page.cid))) fail("INVALID_VIDEO_DETAILS");
    seen.add(page.page);
    return { p: page.page, cid, title: String(page.part || `P${page.page}`).slice(0, 300), durationSeconds: Number(page.duration) > 0 ? Number(page.duration) : null };
  });
  return { bvid, title: String(data.title || bvid).slice(0, 300), pages };
}

export async function loadBilibiliDetails(value, { pageData, request = readBilibiliApi } = {}) {
  const parsed = parseBvUrl(value);
  let info;
  try { info = normalizeDetails(pageData, parsed.bvid); } catch { /* Partial MAIN data is only a hint. */ }
  if (!info) {
    let data;
    try { data = await request("/x/web-interface/view", { bvid: parsed.bvid }); }
    catch (error) {
      if (error.code !== "API_RESPONSE_TOO_LARGE") throw error;
      // Collections can make view metadata enormous. Keep the response cap and fetch only this video's parts.
      const pages = await request("/x/player/pagelist", { bvid: parsed.bvid });
      data = { bvid: parsed.bvid, title: pageData?.bvid === parsed.bvid ? pageData.title : parsed.bvid, pages };
    }
    info = normalizeDetails(data, parsed.bvid);
  }
  const selected = parsed.p === null ? (info.pages.length === 1 ? info.pages[0] : null) : info.pages.find((page) => page.p === parsed.p);
  if (parsed.p !== null && !selected) fail("INVALID_PART");
  return { ...info, selected, selection: selected ? "single" : "playlist" };
}

// Default file name (without extension) for one part: the video title, plus
// "P2 part title" when the video has several parts. A part title that only
// repeats the video title is left out.
export function bilibiliFileName(info, page) {
  if (info.pages.length < 2) return info.title;
  const partTitle = page.title && page.title !== info.title && page.title !== `P${page.p}` ? ` ${page.title}` : "";
  return `${info.title} - P${page.p}${partTitle}`;
}

export function selectBilibiliTracks(play, policy = { mode: "highest_h264" }, expectedSelection) {
  const cap = policy.mode === "highest_h264" ? QUALITY_ORDER.length - 1 : policy.mode === "at_most" ? QUALITY_ORDER.indexOf(Number(policy.qualityId)) : -1;
  if (cap < 0) fail("FORMAT_SELECTION_REQUIRED");
  const usableUrl = (stream) => {
    const candidates = [stream.baseUrl || stream.base_url, ...(stream.backupUrl || stream.backup_url || [])].flatMap((value) => {
      try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? [url] : []; } catch { return []; }
    });
    const allowed = candidates.find(url => (!url.port || url.port === "443") && ["bilivideo.com", "bilivideo.cn"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)));
    return (allowed || candidates[0])?.href || null;
  };
  const video = (play?.dash?.video || []).filter((stream) => {
    if (expectedSelection && (String(stream.id) !== expectedSelection.videoRepresentationId || stream.codecs !== expectedSelection.videoCodec)) return false;
    const rank = QUALITY_ORDER.indexOf(Number(stream.id));
    const avc = /^(avc1|avc3)\./i.test(stream.codecs || "");
    return rank >= 0 && rank <= cap && (avc || (!stream.codecs && stream.codecid === 7)) && usableUrl(stream);
  }).sort((a, b) => QUALITY_ORDER.indexOf(Number(b.id)) - QUALITY_ORDER.indexOf(Number(a.id)) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  const audio = (play?.dash?.audio || []).filter((stream) => (!expectedSelection || (String(stream.id) === expectedSelection.audioRepresentationId && stream.codecs === expectedSelection.audioCodec)) && /^mp4a\.40\.(2|5|29)$/i.test(stream.codecs || "") && usableUrl(stream))
    .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  if (!video || !audio) fail("FORMAT_SELECTION_REQUIRED");
  return {
    actualSelection: { qualityId: String(video.id), videoRepresentationId: String(video.id), audioRepresentationId: String(audio.id), videoCodec: video.codecs || "avc1", audioCodec: audio.codecs },
    tracks: [
      { trackId: "video", role: "video", representationId: String(video.id), codec: video.codecs || "avc1", url: usableUrl(video) },
      { trackId: "audio", role: "audio", representationId: String(audio.id), codec: audio.codecs, url: usableUrl(audio) }
    ]
  };
}

export async function loadBilibiliPlayback(source, policy, { request = readBilibiliApi, expectedSelection } = {}) {
  const play = await request("/x/player/playurl", { bvid: source.bvid, cid: String(source.cid), fnval: "4048", fnver: "0", fourk: "1", qn: "127" });
  return selectBilibiliTracks(play, policy, expectedSelection);
}

export async function readBilibiliApi(endpoint, query, { fetchImpl = fetch } = {}) {
  if (!["/x/web-interface/view", "/x/player/pagelist", "/x/player/playurl"].includes(endpoint)) fail("UNSUPPORTED_SOURCE");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let reader;
  try {
    const response = await fetchImpl(`https://api.bilibili.com${endpoint}?${new URLSearchParams(query)}`, { credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal });
    if (response.status === 401) fail("LOGIN_REQUIRED");
    if (response.status === 403) fail("ACCESS_DENIED");
    // 412 is Bilibili's risk control; it lifts after a while.
    if (response.status === 429 || response.status === 412) fail("RATE_LIMITED");
    if (!response.ok) fail("BILIBILI_API_FAILED");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > API_MAX_BYTES) fail("API_RESPONSE_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    const payload = JSON.parse(text + decoder.decode());
    if (payload.code === -101) fail("LOGIN_REQUIRED");
    if ([-10403, -403].includes(payload.code)) fail("ACCESS_DENIED");
    if ([-352, -412].includes(payload.code)) fail("RATE_LIMITED");
    if (payload.code !== 0 || !payload.data) fail("BILIBILI_API_FAILED");
    return payload.data;
  } catch (error) {
    if (error instanceof BilibiliError) throw error;
    fail(controller.signal.aborted ? "BODY_TIMEOUT" : "BILIBILI_API_FAILED");
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}
