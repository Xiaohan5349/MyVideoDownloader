// Browser-side HLS/DASH downloader shared by the offscreen document (extension
// mode) and the page content script (page mode). It fetches segments with
// whatever network identity the importing context has and streams them to
// the local helper, which muxes them with ffmpeg.
import {
  buildHlsAssetPlan,
  buildLocalHlsPlaylist,
  parseHlsMediaPlaylist
} from "./hls-browser.js";
import {
  buildDashAssetPlan,
  buildDashTracks,
  expandSegmentBase,
  isDashManifest
} from "./dash-browser.js";

export const SEGMENT_FETCH_TIMEOUT_MS = 30_000;
export const SEGMENT_FETCH_RETRIES = 5;

// The CDN refused this context (auth status, HTML challenge page, or bytes
// that are not media). Extension mode reacts by handing off to page mode.
export class BlockedError extends Error {
  constructor(reason) {
    super(`BROWSER_BLOCKED: ${reason}`);
    this.name = "BlockedError";
    this.blocked = true;
  }
}

const BLOCKED_STATUSES = new Set([401, 403]);
const NON_MEDIA_TYPE = /^(?:text\/html|application\/(?:json|xml|xhtml\+xml))\b/i;
const MP4_BOXES = new Set(["ftyp", "styp", "moof", "moov", "mdat", "sidx", "emsg", "prft", "free"]);

export function looksLikeMediaSegment(bytes, contentType = "") {
  if (NON_MEDIA_TYPE.test(contentType || "")) return false;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4) return false;
  if (b[0] === 0x47) return true; // MPEG-TS sync byte
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // ID3-tagged packed audio
  if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return true; // ADTS AAC
  return b.length >= 8 && MP4_BOXES.has(String.fromCharCode(b[4], b[5], b[6], b[7]));
}

/**
 * Resolves the playlist, creates (or resumes) the helper job, and starts
 * uploading segments in the background.
 *
 * Returns { job, resumed, done } once the helper job exists; `done` resolves
 * to { status: "completed" | "cancelled" | "failed" | "blocked", error }.
 * Throws if the download cannot start (bad playlist, DRM, helper error, or a
 * BlockedError from the strict-mode probe).
 *
 * strict (extension mode): probe the first segment before creating the job,
 * treat 401/403 and non-media bytes as blocked without retrying.
 */
export async function startHlsDownload(options) {
  const o = {
    authHeaders: {},
    quality: "",
    downloadMode: "page",
    strict: false,
    allowUrls: async () => {},
    concurrency: defaultConcurrency(),
    retries: SEGMENT_FETCH_RETRIES,
    timeoutMs: SEGMENT_FETCH_TIMEOUT_MS,
    retryDelayMs: defaultRetryDelay,
    credentials: undefined,
    ...options
  };
  if (!o.helperUrl || !o.manifestUrl) throw new Error("INVALID_DOWNLOAD_REQUEST");
  const net = {
    fetchImpl: o.fetchImpl || ((...args) => fetch(...args)),
    credentials: o.credentials,
    timeoutMs: o.timeoutMs
  };

  await o.allowUrls([o.manifestUrl]);
  const manifestText = await fetchPlaylist(net, o.manifestUrl, o.strict);
  const { plan, start, completion } = isDashManifest(manifestText)
    ? await prepareDash(net, o, manifestText)
    : await prepareHls(net, o, manifestText);
  await o.allowUrls([...new Set(plan.assets.map((asset) => asset.url))]);

  // Encrypted segments are ciphertext, so only plain streams can be checked.
  const validate = o.strict && !plan.assets.some((asset) => asset.role === "key");
  const prefetched = new Map();
  if (o.strict) {
    // Probe before creating a helper job so a blocked CDN falls back to page
    // mode without leaving a failed job behind. The bytes are reused below.
    const probe = plan.assets.find((asset) => asset.role === "segment");
    prefetched.set(probe.name, await fetchSegment(net, probe, { ...o, validate }));
  }

  const startRes = await net.fetchImpl(`${o.helperUrl}/browser-downloads/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...o.authHeaders },
    body: JSON.stringify({
      ...start,
      title: o.title || "video",
      totalSegments: plan.segmentAssetCount,
      sourcePageUrl: o.sourcePageUrl,
      downloadMode: o.downloadMode
    })
  });
  const startPayload = await startRes.json().catch(() => ({}));
  if (!startRes.ok) throw new Error(startPayload.error || `HELPER_${startRes.status}`);

  const ctx = {
    o,
    net,
    job: startPayload.job,
    plan,
    completion,
    prefetched,
    validate,
    alreadyReceived: new Set(startPayload.receivedFiles || [])
  };
  const done = runDownload(ctx).catch(async (error) => {
    const message = error?.message || "BROWSER_HLS_FAILED";
    await reportFailure(ctx, message);
    return { status: "failed", error: message };
  });
  return { job: ctx.job, resumed: Boolean(startPayload.resumed), done };
}

async function runDownload(ctx) {
  const { o, net, job, plan, prefetched, validate, alreadyReceived } = ctx;
  const jobUrl = `${o.helperUrl}/jobs/${encodeURIComponent(job.id)}`;
  // "cancelled" or a BlockedError; either one stops every worker.
  let stop = null;

  async function processOne(asset) {
    // Check whether the helper job is still running before fetching. The
    // authenticated poll also serves as the helper's stall heartbeat.
    try {
      const checkRes = await net.fetchImpl(jobUrl, { headers: o.authHeaders });
      if (checkRes.ok) {
        const current = await checkRes.json().catch(() => ({}));
        if (current.status === "cancelled" || current.status === "failed") {
          stop = stop || "cancelled";
          return;
        }
      }
    } catch (_) {}

    let data = prefetched.get(asset.name);
    prefetched.delete(asset.name);
    if (!data) data = await fetchSegment(net, asset, { ...o, validate: validate && asset.role === "segment" });

    const upRes = await fetchWithTimeout(
      net,
      `${o.helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/files/${encodeURIComponent(asset.name)}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream", ...o.authHeaders }, body: data },
      "HELPER_TIMEOUT"
    );
    if (!upRes.ok) throw new Error(`UPLOAD_${upRes.status}`);
  }

  async function runAssetBatch(batch) {
    const failed = [];
    let cursor = 0;
    const workers = [];
    for (let i = 0; i < Math.min(o.concurrency, batch.length); i += 1) {
      workers.push((async () => {
        while (cursor < batch.length && !stop) {
          const entry = batch[cursor];
          cursor += 1;
          try {
            await processOne(entry.asset);
          } catch (error) {
            if (error?.blocked) {
              stop = stop || error;
              return;
            }
            console.warn("[ds-video-downloader] segment failed", entry.index, error?.message);
            failed.push({ index: entry.index, error: error?.message });
          }
        }
      })());
    }
    await Promise.all(workers);
    return failed;
  }

  // On resume, skip files the helper already has from the previous attempt.
  const batch = plan.assets
    .map((asset, index) => ({ index, asset }))
    .filter((entry) => !alreadyReceived.has(entry.asset.name));
  let failed = await runAssetBatch(batch);

  // Retry transient segment failures twice before giving up
  let retryRound = 0;
  while (!stop && failed.length && retryRound < 2) {
    retryRound += 1;
    console.warn(`[ds-video-downloader] retrying ${failed.length} failed segments, round ${retryRound}`);
    failed = await runAssetBatch(failed.map((entry) => ({ index: entry.index, asset: plan.assets[entry.index] })));
  }

  if (stop === "cancelled") return { status: "cancelled" };
  if (stop?.blocked) {
    await reportFailure(ctx, stop.message);
    return { status: "blocked", error: stop.message };
  }
  if (failed.length) {
    const error = `SEGMENT_DOWNLOAD_FAILED: ${failed.length}/${plan.assets.length}`;
    await reportFailure(ctx, error);
    return { status: "failed", error };
  }

  const completeRes = await net.fetchImpl(`${o.helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...o.authHeaders },
    body: JSON.stringify(ctx.completion)
  });
  if (!completeRes.ok) {
    const completePayload = await completeRes.json().catch(() => ({}));
    const error = completePayload.error === "SEGMENTS_INCOMPLETE"
      ? "SEGMENTS_INCOMPLETE"
      : `HELPER_COMPLETE_${completeRes.status}`;
    // Mark the helper job failed so it cannot sit in "running" until the
    // stall sweeper kills it with a misleading DOWNLOAD_STALLED error.
    await reportFailure(ctx, error);
    return { status: "failed", error };
  }
  return { status: "completed" };
}

// Each prepare step returns the files to fetch (plan), the stream fields for
// /browser-downloads/start, and the /complete body with the local playlists.
async function prepareHls(net, o, masterText) {
  const master = parseHlsMaster(masterText, o.manifestUrl);
  if (master.hasDrm) throw new Error("DRM_PROTECTED_UNSUPPORTED");

  let variantUrl = o.manifestUrl;
  let mediaText = masterText;
  if (master.variants.length) {
    variantUrl = pickVariant(master.variants, o.quality).url;
    await o.allowUrls([variantUrl]);
    mediaText = await fetchPlaylist(net, variantUrl, o.strict);
  }

  const mediaPlaylist = parseHlsMediaPlaylist(mediaText, variantUrl);
  if (mediaPlaylist.hasDrm) throw new Error("DRM_PROTECTED_UNSUPPORTED");
  if (!mediaPlaylist.segments.length) throw new Error("HLS_NO_SEGMENTS");
  const plan = buildHlsAssetPlan(mediaPlaylist);
  return {
    plan,
    start: { url: variantUrl, durationSeconds: mediaPlaylist.durationSeconds },
    completion: { playlistText: buildLocalHlsPlaylist(mediaText, variantUrl, plan.assetNameByUrl) }
  };
}

async function prepareDash(net, o, mpdText) {
  const dash = buildDashTracks(mpdText, o.manifestUrl, o.quality);
  const indexed = dash.tracks.filter((track) => track.segmentBase);
  if (indexed.length) {
    await o.allowUrls(indexed.map((track) => track.segmentBase.url));
    await expandSegmentBase(dash.tracks, (url, byteRange) => fetchSegment(net, { url, byteRange }, { ...o, validate: false }));
  }
  const plan = buildDashAssetPlan(dash.tracks);
  return {
    plan,
    start: {
      url: o.manifestUrl,
      kind: "dash",
      quality: dash.quality,
      trackKey: dash.trackKey,
      durationSeconds: dash.durationSeconds
    },
    completion: {
      playlistText: plan.playlists.video || plan.playlists.audio,
      audioPlaylistText: plan.playlists.video ? plan.playlists.audio || "" : ""
    }
  };
}

function reportFailure({ o, net, job }, error) {
  return net.fetchImpl(`${o.helperUrl}/browser-downloads/${encodeURIComponent(job.id)}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...o.authHeaders },
    body: JSON.stringify({ error })
  }).catch(() => {});
}

async function fetchPlaylist(net, url, strict) {
  const response = await fetchWithTimeout(net, url, withCredentials(net, { cache: "no-store" }), "FETCH_TIMEOUT");
  if (strict && BLOCKED_STATUSES.has(response.status)) throw new BlockedError(`HTTP ${response.status}`);
  if (!response.ok) {
    throw new Error(response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `FETCH_${response.status}`);
  }
  const text = (await response.text()).replace(/^﻿/, "");
  if (strict && !text.trimStart().startsWith("#EXTM3U") && !isDashManifest(text)) throw new BlockedError("NOT_A_PLAYLIST");
  return text;
}

async function fetchSegment(net, asset, { strict, validate, retries, retryDelayMs }) {
  const { byteRange } = asset;
  const headers = byteRange
    ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` }
    : undefined;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        net,
        asset.url,
        withCredentials(net, { cache: "no-store", ...(headers ? { headers } : {}) }),
        "SEGMENT_TIMEOUT"
      );
      const contentType = response.headers.get("content-type") || "";
      if (strict && BLOCKED_STATUSES.has(response.status)) throw new BlockedError(`HTTP ${response.status}`);
      if (strict && NON_MEDIA_TYPE.test(contentType)) throw new BlockedError(`content-type ${contentType}`);
      if (!response.ok) throw new Error(`SEGMENT_${response.status}`);

      const buffer = byteRange
        ? await readByteRange(response, byteRange)
        : await response.arrayBuffer();
      if (validate && !looksLikeMediaSegment(buffer, contentType)) throw new BlockedError("NOT_MEDIA");
      return buffer;
    } catch (error) {
      if (error?.blocked) throw error;
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw lastError || new Error("SEGMENT_DOWNLOAD_FAILED");
}

async function readByteRange(response, byteRange) {
  const expectedStart = byteRange.offset;
  const expectedEnd = byteRange.offset + byteRange.length - 1;

  if (response.status === 206) {
    const range = response.headers.get("content-range") || "";
    const match = range.match(/bytes\s+(\d+)-(\d+)\//i);
    if (!match || Number(match[1]) !== expectedStart || Number(match[2]) !== expectedEnd) {
      throw new Error("SEGMENT_RANGE_MISMATCH");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== byteRange.length) throw new Error("SEGMENT_RANGE_MISMATCH");
    return buffer;
  }

  if (response.status === 200) {
    // Some CDNs ignore Range and return the whole resource. Slice the
    // requested bytes locally instead of writing a corrupt oversized file.
    const full = await response.arrayBuffer();
    if (expectedStart >= full.byteLength || full.byteLength < expectedEnd + 1) {
      throw new Error("SEGMENT_RANGE_OUT_OF_BOUNDS");
    }
    return full.slice(expectedStart, expectedEnd + 1);
  }

  throw new Error(`SEGMENT_${response.status}`);
}

function withCredentials(net, init) {
  return net.credentials ? { ...init, credentials: net.credentials } : init;
}

async function fetchWithTimeout(net, url, init, timeoutCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), net.timeoutMs);
  try {
    return await net.fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(timeoutCode);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultRetryDelay(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 500);
}

// Keep ArrayBuffer memory bounded, but allow faster devices to use more
// workers (3-6). Segment size is unknown until fetched, so this is driven
// by available device memory rather than per-segment size.
function defaultConcurrency() {
  const memoryGB = Number(globalThis.navigator?.deviceMemory || 4);
  if (memoryGB >= 8) return 6;
  if (memoryGB >= 4) return 4;
  return 3;
}

// --- Master playlist parsing ---

export function parseHlsMaster(text, baseUrl) {
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
      variants.push({
        url: resolveUrl(line, baseUrl),
        quality: qualityFromResolution(pending.resolution),
        bandwidth: pending.bandwidth
      });
      pending = null;
    }
  }

  return { hasDrm, variants };
}

export function pickVariant(variants, targetQuality) {
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
