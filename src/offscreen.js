import {
  buildLocalHlsPlaylist,
  parseHlsMediaPlaylist
} from "./hls-browser.js";
import {
  estimateBytes,
  fallbackBandwidthForQuality,
  parseHlsManifest
} from "./shared.js";

const BROWSER_HLS_START = "browserHls:start";
const activeJobs = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== BROWSER_HLS_START) return false;

  startBrowserHlsDownload(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.code || error.message || String(error) }));
  return true;
});

async function startBrowserHlsDownload(payload) {
  const { media, variant, helperUrl, headers = [] } = payload;
  if (!media?.url || !helperUrl) return { ok: false, error: "INVALID_BROWSER_HLS_REQUEST" };

  const plan = await buildDownloadPlan(media, variant, headers);
  const startResponse = await fetch(`${helperUrl}/browser-downloads/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: plan.playlistUrl,
      title: media.title || "video",
      durationSeconds: plan.durationSeconds,
      totalSegments: plan.segmentAssetCount,
      totalBytes: plan.estimatedSize,
      totalSizeSource: plan.estimatedSize ? "estimated" : "unknown"
    })
  });
  const startPayload = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) return { ok: false, error: startPayload.error || `HELPER_${startResponse.status}` };

  const job = startPayload.job;
  activeJobs.set(job.id, true);
  runBrowserJob(helperUrl, job.id, plan, headers).finally(() => {
    activeJobs.delete(job.id);
  });

  return { ok: true, helperJob: job, mode: "browser-hls" };
}

async function buildDownloadPlan(media, variant, headers) {
  let playlistUrl = variant?.url || media.url;
  let playlistText = await fetchText(playlistUrl, headers);
  const master = parseHlsManifest(playlistText, playlistUrl);

  if (master.hasDrm) throw codedError("DRM_PROTECTED_UNSUPPORTED");
  if (master.variants?.length) {
    const selected = variant?.url
      ? master.variants.find((entry) => entry.url === variant.url) || variant
      : chooseBestVariant(master.variants);
    playlistUrl = selected.url;
    playlistText = await fetchText(playlistUrl, headers);
  }

  const mediaPlaylist = parseHlsMediaPlaylist(playlistText, playlistUrl);
  if (mediaPlaylist.hasDrm) throw codedError("DRM_PROTECTED_UNSUPPORTED");
  if (!mediaPlaylist.segments.length) throw codedError("HLS_NO_SEGMENTS");

  const { assets, assetNameByUrl, segmentAssetCount } = buildAssetList(mediaPlaylist);
  const localPlaylistText = buildLocalHlsPlaylist(playlistText, playlistUrl, assetNameByUrl);
  const quality = variant?.quality || media.quality || "";
  const bandwidth = variant?.bandwidth || media.bandwidth || fallbackBandwidthForQuality(quality);
  const estimatedSize = estimateBytes(mediaPlaylist.durationSeconds, bandwidth);

  return {
    playlistUrl,
    localPlaylistText,
    assets,
    segmentAssetCount,
    durationSeconds: mediaPlaylist.durationSeconds,
    estimatedSize
  };
}

const PARALLEL_FETCHES = 8;
const MAX_RETRIES = 3;

async function runBrowserJob(helperUrl, jobId, plan, headers) {
  try {
    // Fetch and upload segments in parallel with concurrency control
    const semaphore = new Semaphore(PARALLEL_FETCHES);
    const total = plan.assets.length;
    let completed = 0;

    const tasks = plan.assets.map((asset, index) =>
      semaphore.run(async () => {
        if (await isHelperJobCancelled(helperUrl, jobId)) return;

        let lastError = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const data = await fetchBinary(asset.url, headers);
            const upload = await fetch(
              `${helperUrl}/browser-downloads/${encodeURIComponent(jobId)}/files/${encodeURIComponent(asset.name)}`,
              { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: data }
            );
            if (!upload.ok) {
              const payload = await upload.json().catch(() => ({}));
              throw codedError(payload.error || `HELPER_UPLOAD_${upload.status}`);
            }
            completed += 1;
            // Report progress back to service worker
            chrome.runtime.sendMessage({
              type: "browserHls:progress",
              payload: { jobId, completed, total, assetIndex: index }
            }).catch(() => {});
            return; // success
          } catch (error) {
            lastError = error;
            if (attempt < MAX_RETRIES) {
              // Exponential backoff before retry
              await sleep(Math.min(1000 * Math.pow(2, attempt - 1), 5000));
            }
          }
        }
        throw lastError || codedError("SEGMENT_FAILED_AFTER_RETRIES");
      })
    );

    await Promise.all(tasks);

    if (await isHelperJobCancelled(helperUrl, jobId)) return;
    const complete = await fetch(`${helperUrl}/browser-downloads/${encodeURIComponent(jobId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistText: plan.localPlaylistText })
    });
    if (!complete.ok) {
      const payload = await complete.json().catch(() => ({}));
      throw codedError(payload.error || `HELPER_COMPLETE_${complete.status}`);
    }
  } catch (error) {
    await failHelperJob(helperUrl, jobId, error.code || error.message || String(error));
  }
}

// Simple semaphore for concurrency control
class Semaphore {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    while (this.running >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.running += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAssetList(mediaPlaylist) {
  const assets = [];
  const assetNameByUrl = new Map();

  for (const [index, item] of mediaPlaylist.keys.entries()) {
    addAsset(assets, assetNameByUrl, item.url, `key-${pad(index)}.key`, "key");
  }

  for (const [index, item] of mediaPlaylist.maps.entries()) {
    addAsset(assets, assetNameByUrl, item.url, `init-${pad(index)}.${extensionFromUrl(item.url, "mp4")}`, "map");
  }

  let segmentIndex = 0;
  for (const item of mediaPlaylist.segments) {
    if (assetNameByUrl.has(item.url)) continue;
    const name = `seg-${pad(segmentIndex)}.${segmentExtension(item.url)}`;
    addAsset(assets, assetNameByUrl, item.url, name, "segment");
    segmentIndex += 1;
  }

  return { assets, assetNameByUrl, segmentAssetCount: segmentIndex };
}

function addAsset(assets, assetNameByUrl, url, name, role) {
  if (assetNameByUrl.has(url)) return;
  assetNameByUrl.set(url, name);
  assets.push({ url, name, role });
}

async function fetchText(url, headers) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: {
      ...headersToObject(headers),
      Accept: "application/vnd.apple.mpegurl,*/*"
    }
  });
  if (!response.ok) throw codedError(response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `FETCH_${response.status}`);
  return response.text();
}

async function fetchBinary(url, headers) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: headersToObject(headers)
  });
  if (!response.ok) throw codedError(response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `SEGMENT_FETCH_${response.status}`);
  return response.arrayBuffer();
}

async function isHelperJobCancelled(helperUrl, jobId) {
  const response = await fetch(`${helperUrl}/jobs/${encodeURIComponent(jobId)}`).catch(() => null);
  if (!response?.ok) return false;
  const job = await response.json().catch(() => ({}));
  return job.status === "cancelled";
}

async function failHelperJob(helperUrl, jobId, error) {
  await fetch(`${helperUrl}/browser-downloads/${encodeURIComponent(jobId)}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error })
  }).catch(() => {});
}

function chooseBestVariant(variants) {
  return [...variants].sort((a, b) => scoreVariant(b) - scoreVariant(a))[0];
}

function scoreVariant(variant) {
  const quality = Number(String(variant.quality || "").match(/(\d+)p/)?.[1] || 0);
  const bandwidth = Number(variant.bandwidth || 0) / 10_000_000;
  return quality + bandwidth;
}

function headersToObject(headers = []) {
  const object = {};
  for (const header of headers) {
    if (!header?.name || /[\r\n]/.test(header.name) || /[\r\n]/.test(header.value || "")) continue;
    object[header.name] = header.value || "";
  }
  return object;
}

function segmentExtension(url) {
  const extension = extensionFromUrl(url, "ts");
  if (["m4s", "mp4", "ts", "aac", "mp3"].includes(extension)) return extension;
  return "ts";
}

function extensionFromUrl(url, fallback) {
  try {
    const extension = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
    return extension || fallback;
  } catch {
    return fallback;
  }
}

function pad(index) {
  return String(index).padStart(6, "0");
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
