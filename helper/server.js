import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, "downloads");
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "helper-settings.json");
const PICKER_SCRIPT_PATH = path.join(__dirname, "pick-folder.ps1");
const JOBS_PATH = process.env.JOBS_PATH || path.join(__dirname, "helper-jobs.json");
const BACKGROUND_ASSET_PATH = path.join(__dirname, "..", "assets", "app-background.webp");
const AUTH_TOKEN = process.env.DS_HELPER_TOKEN || randomUUID();
const SIZE_PROBE_LIMIT = Number(process.env.SIZE_PROBE_LIMIT || 1500);
const SIZE_PROBE_CONCURRENCY = Number(process.env.SIZE_PROBE_CONCURRENCY || 8);
const SIZE_PROBE_TIMEOUT_MS = Number(process.env.SIZE_PROBE_TIMEOUT_MS || 5000);
const JOB_STALL_TIMEOUT_MS = Number(process.env.JOB_STALL_TIMEOUT_MS || 120_000);
const QUALITY_PROBE_TIMEOUT_MS = Number(process.env.QUALITY_PROBE_TIMEOUT_MS || 6000);
const QUALITY_PROBE_CACHE_MS = 10 * 60_000;
const MAX_JOB_HISTORY = 5000;
// Failed browser-fed jobs keep their uploaded segments this long so a retry
// can resume instead of starting over.
const BROWSER_RESUME_TTL_MS = 24 * 60 * 60_000;
const RESUMABLE_BROWSER_ERRORS = [
  "DOWNLOAD_STALLED",
  "SOURCE_PAGE_CLOSED",
  "HELPER_RESTARTED",
  "SEGMENTS_INCOMPLETE",
  "SEGMENT_DOWNLOAD_FAILED",
  "BROWSER_HLS_FAILED",
  "BROWSER_BLOCKED"
];
// Which browser context fetches the segments: the offscreen document
// ("extension") or the source page's content script ("page").
const DOWNLOAD_MODES = new Set(["extension", "page"]);
const JOBS_PAGE_SIZE_DEFAULT = 50;
const JOBS_PAGE_SIZE_MAX = 500;
const jobs = new Map();
const jobProcesses = new Map();
const uploadLocks = new Map();

async function loadJobsFromDisk() {
  try {
    const raw = await readFile(JOBS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const job of data) {
        if (!job.id) continue;
        if (job.status === "running" || job.status === "queued") {
          await failJob(job, "HELPER_RESTARTED", "Download interrupted when the helper stopped").catch(() => {});
        }
        if (job.resumable && !existsSync(job.tempDir || "")) job.resumable = false;
        reconcileJobFileState(job);
        jobs.set(job.id, job);
      }
    }
    const removed = enforceJobHistoryCap();
    if (removed > 0) await persistJobsNow();
    console.log(`Loaded ${jobs.size} jobs from history${removed > 0 ? ` (removed ${removed} missing records over cap)` : ""}`);
  } catch {
    // No history file yet — that's fine
  }
}

let persistJobsChain = Promise.resolve();
let persistTimer = null;
let persistQueued = false;

function persistJobsToDisk() {
  const data = JSON.stringify(Array.from(jobs.values()), null, 2);
  persistJobsChain = persistJobsChain
    .then(async () => {
      const tmpPath = JOBS_PATH + ".tmp";
      await writeFile(tmpPath, data, "utf8");
      await rename(tmpPath, JOBS_PATH);
    })
    .catch((error) => {
      // Persistence is best-effort, but make failures visible for diagnostics.
      console.warn("[helper] failed to persist helper-jobs.json:", error?.message || error);
    });
  return persistJobsChain;
}

function queuePersistJobsToDisk() {
  persistQueued = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistQueued = false;
    persistJobsToDisk();
  }, 1000);
  persistTimer.unref?.();
}

async function persistJobsNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistQueued = false;
  await persistJobsToDisk();
}

let downloadDir = await loadDownloadDir();

await mkdir(downloadDir, { recursive: true });
await loadJobsFromDisk();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (requiresHelperToken(req) && !hasValidHelperToken(req)) {
    writeJson(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/auth") {
      writeJson(res, 200, { ok: true, token: AUTH_TOKEN });
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      writeHtml(res, renderHomePage());
      return;
    }

    if (req.method === "GET" && req.url === "/assets/app-background.webp") {
      const image = await readFile(BACKGROUND_ASSET_PATH);
      res.writeHead(200, {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=86400"
      });
      res.end(image);
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      writeJson(res, 200, { ok: true, ffmpeg: "required", downloadDir });
      return;
    }

    if (req.method === "GET" && req.url === "/settings") {
      writeJson(res, 200, { ok: true, settings: { downloadDir } });
      return;
    }

    if (req.method === "POST" && req.url === "/settings") {
      const payload = await readJson(req);
      const result = await updateHelperSettings(payload);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/jobs/clear-missing") {
      const result = await clearMissingJobRecords();
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/pick-folder") {
      const result = await pickDownloadFolder();
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "GET" && new URL(req.url || "/jobs", "http://127.0.0.1").pathname === "/jobs") {
      await reconcileAllJobFiles();
      const page = parseJobsPage(req.url);
      const allJobs = Array.from(jobs.values()).reverse();
      writeJson(res, 200, {
        ok: true,
        jobs: allJobs.slice(page.offset, page.offset + page.limit),
        total: allJobs.length,
        limit: page.limit,
        offset: page.offset,
        stats: buildJobStats()
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/jobs/")) {
      const id = decodeURIComponent(req.url.split("/").pop() || "");
      const job = jobs.get(id);
      if (job && reconcileJobFileState(job)) await persistJobsNow();
      if (job && job.status === "running" && hasValidHelperToken(req)) {
        // Content-script workers poll this endpoint before each segment fetch;
        // treating the authenticated poll as a heartbeat keeps legitimately
        // slow retry loops from tripping the stall sweeper.
        job.lastActivityAt = Date.now();
      }
      writeJson(res, job ? 200 : 404, job || { ok: false, error: "JOB_NOT_FOUND" });
      return;
    }

    if (req.method === "POST" && /^\/jobs\/[^/]+\/show$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const result = showJobOutput(id);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && /^\/jobs\/[^/]+\/cancel$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const result = await cancelJob(id);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "DELETE" && /^\/jobs\/[^/]+\/history$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const result = await forgetJobRecord(id);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "DELETE" && req.url?.startsWith("/jobs/")) {
      const id = decodeURIComponent(req.url.split("/").pop() || "");
      const result = await deleteJobOutput(id);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/download") {
      const payload = await readJson(req);
      const result = await startDownload(payload);
      writeJson(res, result.ok ? 202 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/browser-downloads/start") {
      const payload = await readJson(req);
      const result = await startBrowserDownload(payload);
      writeJson(res, result.ok ? 202 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && /^\/browser-downloads\/[^/]+\/files\/[^/]+$/.test(req.url || "")) {
      const parts = req.url.split("/");
      const id = decodeURIComponent(parts[2] || "");
      const fileName = decodeURIComponent(parts[4] || "");
      const result = await uploadBrowserDownloadFile(id, fileName, req);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && /^\/browser-downloads\/[^/]+\/complete$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const payload = await readJson(req);
      const result = await completeBrowserDownload(id, payload);
      writeJson(res, result.ok ? 202 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && /^\/browser-downloads\/[^/]+\/fail$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const payload = await readJson(req);
      const result = await failBrowserDownload(id, payload);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/inspect") {
      const payload = await readJson(req);
      const result = await inspectForUi(payload);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "POST" && req.url === "/probe-quality") {
      const payload = await readJson(req);
      const result = await probeQualityForUi(payload);
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    writeJson(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    writeJson(res, error.status || 500, { ok: false, error: error.message || String(error) });
  }
});

if (process.env.NODE_ENV !== "test") {
  const stallTimer = setInterval(() => sweepStalledJobs().catch(() => {}), 5000);
  stallTimer.unref();
  server.listen(PORT, HOST, () => {
    console.log(`DS Video Downloader helper listening on http://${HOST}:${PORT}`);
    console.log(`Downloads folder: ${downloadDir}`);
  });
}

export { server, jobs, isSafeDownloadPath, persistJobsToDisk, sweepStalledJobs, enforceJobHistoryCap };

async function startDownload(payload) {
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };

  const headers = normalizeHeaders(payload.headers || []);
  const inspection = await inspectManifest(url, payload.kind || "", headers);
  if (!inspection.ok) return inspection;
  if (inspection.hasDrm) return { ok: false, status: 422, error: "DRM_PROTECTED_UNSUPPORTED" };

  const id = randomUUID();
  const filename = buildFilename(payload.title || "video", url);
  const outputPath = await uniqueOutputPath(path.join(downloadDir, filename));
  const now = Date.now();
  const job = {
    id,
    ok: true,
    status: "queued",
    url,
    sourcePageUrl: validateUrl(payload?.sourcePageUrl) || "",
    outputPath,
    downloadDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    exitCode: null,
    progressText: "starting",
    downloadedBytes: 0,
    totalBytes: inspection.totalBytes || null,
    totalSizeSource: inspection.totalSizeSource || "unknown",
    durationSeconds: inspection.durationSeconds || null,
    downloadedSeconds: 0,
    transferRateBytesPerSecond: 0,
    etaSeconds: null,
    lastProgressAt: null,
    lastProgressBytes: 0,
    lastActivityAt: now,
    ffmpegArgs: [],
    log: []
  };
  jobs.set(id, job);
  enforceJobHistoryCap();
  persistJobsToDisk();

  runFfmpeg(job, headers);
  return { ok: true, job };
}

async function startBrowserDownload(payload) {
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };

  const totalBytes = Number(payload.totalBytes);
  const durationSeconds = Number(payload.durationSeconds);
  const totalSegments = Number(payload.totalSegments);
  if (!Number.isInteger(totalSegments) || totalSegments <= 0) {
    return { ok: false, status: 400, error: "INVALID_TOTAL_SEGMENTS" };
  }

  const resumable = findResumableJob({ ...payload, url, totalSegments, durationSeconds });
  if (resumable) {
    const receivedFiles = await reopenResumableJob(resumable, url, payload.downloadMode);
    await persistJobsNow();
    return { ok: true, job: resumable, resumed: true, receivedFiles };
  }

  const id = randomUUID();
  const filename = buildFilename(payload.title || "video", url);
  const outputPath = await uniqueOutputPath(path.join(downloadDir, filename));
  const tempDir = path.join(tmpdir(), `ds-video-browser-${id}`);
  await mkdir(tempDir, { recursive: true });

  const job = {
    id,
    ok: true,
    inputMode: "browser",
    downloadMode: normalizeDownloadMode(payload.downloadMode),
    status: "running",
    url,
    sourcePageUrl: validateUrl(payload?.sourcePageUrl) || "",
    // DASH jobs need the chosen tracks to resume: one MPD URL serves every quality.
    streamKind: payload.kind === "dash" ? "dash" : "hls",
    quality: String(payload.quality || "").slice(0, 32),
    trackKey: String(payload.trackKey || "").slice(0, 300),
    outputPath,
    downloadDir,
    tempDir,
    localPlaylistPath: null,
    localAudioPlaylistPath: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    exitCode: null,
    progressText: "Waiting for browser segments",
    downloadedBytes: 0,
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
    totalSizeSource: payload.totalSizeSource || "unknown",
    totalSegments,
    receivedSegments: 0,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    downloadedSeconds: 0,
    transferRateBytesPerSecond: 0,
    etaSeconds: null,
    lastProgressAt: null,
    lastProgressBytes: 0,
    lastActivityAt: Date.now(),
    ffmpegArgs: [],
    log: []
  };
  jobs.set(id, job);
  enforceJobHistoryCap();
  await persistJobsToDisk();
  return { ok: true, job, resumed: false, receivedFiles: [] };
}

function findResumableJob(payload) {
  // Newest first, so a retry picks up the most recent attempt.
  for (const job of Array.from(jobs.values()).reverse()) {
    if (job.inputMode !== "browser" || !job.resumable) continue;
    if (job.status !== "failed" && job.status !== "cancelled") continue;
    if (!job.tempDir || !existsSync(job.tempDir)) continue;
    if (isSameDownload(job, payload)) return job;
  }
  return null;
}

// Decides whether a new browser download request is the same stream as a
// failed, resumable job. Segment files are named by playlist position
// (seg-000000.ts, seg-000001.ts, ...), so a false match would splice segments
// from two different videos into one file; a false miss only means the
// download starts over.
//
// job:     the old job record (url, sourcePageUrl, totalSegments, durationSeconds)
// payload: the new request (same fields; url is already validated)
function isSameDownload(job, payload) {
  if (job.totalSegments !== payload.totalSegments) return false;
  if ((job.trackKey || "") !== String(payload.trackKey || "")) return false;
  // Ignore the query string: CDN tokens usually change between attempts.
  if (urlPath(job.url) !== urlPath(payload.url)) return false;
  // The page URL keeps its query (e.g. watch?v=...), which often names the video.
  if ((job.sourcePageUrl || "") !== (validateUrl(payload.sourcePageUrl) || "")) return false;
  const oldDuration = Number(job.durationSeconds);
  const newDuration = Number(payload.durationSeconds);
  if (oldDuration > 0 && newDuration > 0 && Math.abs(oldDuration - newDuration) > 1) return false;
  return true;
}

function urlPath(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function normalizeDownloadMode(value) {
  return DOWNLOAD_MODES.has(value) ? value : null;
}

async function reopenResumableJob(job, url, downloadMode) {
  const receivedFiles = [];
  let receivedBytes = 0;
  for (const name of await readdir(job.tempDir)) {
    if (!safeBrowserFileName(name) || name === "input.m3u8" || name === "audio.m3u8") continue;
    const info = await stat(path.join(job.tempDir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    receivedFiles.push(name);
    receivedBytes += info.size;
  }

  job.url = url;
  job.downloadMode = normalizeDownloadMode(downloadMode);
  job.status = "running";
  job.error = null;
  job.exitCode = null;
  job.finishedAt = null;
  job.resumable = false;
  job.localPlaylistPath = null;
  job.localAudioPlaylistPath = null;
  job.receivedSegments = receivedFiles.filter((name) => /^seg-/i.test(name)).length;
  job.downloadedBytes = receivedBytes;
  job.lastProgressBytes = receivedBytes;
  job.lastProgressAt = null;
  job.transferRateBytesPerSecond = 0;
  job.etaSeconds = null;
  job.lastActivityAt = Date.now();
  job.resumeCount = (job.resumeCount || 0) + 1;
  job.progressText = `Resuming: ${job.receivedSegments}/${job.totalSegments} segments already downloaded`;
  // Move to the end so job lists (newest first) show the resumed job on top.
  jobs.delete(job.id);
  jobs.set(job.id, job);
  return receivedFiles;
}

async function uploadBrowserDownloadFile(id, fileName, req) {
  const job = jobs.get(id);
  if (!job || job.inputMode !== "browser") return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status !== "running" && job.status !== "queued") return { ok: false, status: 409, error: "JOB_NOT_RUNNING" };

  const safeName = safeBrowserFileName(fileName);
  if (!safeName) return { ok: false, status: 400, error: "INVALID_FILE_NAME" };

  const targetPath = path.join(job.tempDir, safeName);
  if (!isSafeDownloadPath(targetPath, job.tempDir)) return { ok: false, status: 403, error: "OUTPUT_PATH_UNSAFE" };

  const lockKey = `${id}:${safeName}`;
  if (uploadLocks.has(lockKey)) {
    // Same segment is already being uploaded concurrently.
    await discardRaw(req, 256 * 1024 * 1024);
    return { ok: true, job };
  }
  uploadLocks.set(lockKey, true);
  try {
    if (existsSync(targetPath)) {
      // Retried upload after the previous attempt actually succeeded. Consume
      // and discard the duplicate body without double-counting progress.
      await discardRaw(req, 256 * 1024 * 1024);
      return { ok: true, job };
    }

    const bytesWritten = await readRawToFile(req, targetPath, 256 * 1024 * 1024);
    job.receivedSegments += /^seg-/i.test(safeName) ? 1 : 0;
    updateDownloadedBytes(job, job.downloadedBytes + bytesWritten);
    job.progressText = formatBrowserReceiveProgress(job);
    queuePersistJobsToDisk();
    return { ok: true, job };
  } finally {
    uploadLocks.delete(lockKey);
  }
}

async function completeBrowserDownload(id, payload) {
  const job = jobs.get(id);
  if (!job || job.inputMode !== "browser") return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status !== "running" && job.status !== "queued") return { ok: false, status: 409, error: "JOB_NOT_RUNNING" };

  const playlistText = String(payload?.playlistText || "").replace(/^\uFEFF/, "");
  if (!playlistText.trimStart().startsWith("#EXTM3U")) return { ok: false, status: 400, error: "INVALID_PLAYLIST" };
  // DASH jobs send the audio track as a second playlist.
  const audioPlaylistText = String(payload?.audioPlaylistText || "").replace(/^﻿/, "");
  if (audioPlaylistText && !audioPlaylistText.trimStart().startsWith("#EXTM3U")) return { ok: false, status: 400, error: "INVALID_PLAYLIST" };
  if (playlistText.length + audioPlaylistText.length > 20 * 1024 * 1024) return { ok: false, status: 413, error: "PLAYLIST_TOO_LARGE" };

  if (Number.isInteger(job.totalSegments) && job.receivedSegments < job.totalSegments) {
    await failJob(job, "SEGMENTS_INCOMPLETE", `Expected ${job.totalSegments} segments but received ${job.receivedSegments}`);
    await persistJobsNow();
    return { ok: false, status: 409, error: "SEGMENTS_INCOMPLETE" };
  }

  const playlistPath = path.join(job.tempDir, "input.m3u8");
  await writeFile(playlistPath, playlistText, "utf8");
  // Keep job.url as the stream URL: a resume after a restart mid-mux still
  // needs it to match the stream and refetch the playlist.
  job.localPlaylistPath = playlistPath;
  job.localAudioPlaylistPath = null;
  if (audioPlaylistText) {
    job.localAudioPlaylistPath = path.join(job.tempDir, "audio.m3u8");
    await writeFile(job.localAudioPlaylistPath, audioPlaylistText, "utf8");
  }
  job.status = "queued";
  job.progressText = "Muxing local segments";
  job.lastActivityAt = Date.now();
  await persistJobsToDisk();
  runFfmpeg(job, []);
  return { ok: true, job };
}

async function failBrowserDownload(id, payload) {
  const job = jobs.get(id);
  if (!job || job.inputMode !== "browser") return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status === "completed" || job.status === "cancelled") return { ok: true, job };
  // A late failure report (e.g. a page closing after the stall sweeper already
  // gave up) must not overwrite the first, more accurate failure.
  if (job.status === "failed") return { ok: true, job };

  const error = String(payload?.error || "BROWSER_HLS_FAILED").slice(0, 500);
  await failJob(job, error, error);
  await persistJobsToDisk();
  return { ok: true, job };
}

function isResumableBrowserError(error = "") {
  return RESUMABLE_BROWSER_ERRORS.some((code) => error === code || error.startsWith(`${code}:`));
}

// Marks a job failed. Browser-fed jobs that failed for a recoverable reason
// keep their uploaded segments so the next attempt can resume.
async function failJob(job, error, progressText, now = Date.now()) {
  job.status = "failed";
  job.error = error;
  job.finishedAt = new Date(now).toISOString();
  job.etaSeconds = null;
  job.resumable = job.inputMode === "browser" && isResumableBrowserError(error);
  job.progressText = progressText;
  if (!job.resumable) await cleanupBrowserTemp(job);
}

async function inspectForUi(payload) {
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };

  const headers = normalizeHeaders(payload.headers || []);
  if (payload.kind === "direct") {
    const totalBytes = await probeContentLength(url, headers);
    return {
      ok: true,
      hasDrm: false,
      durationSeconds: null,
      totalBytes,
      totalSizeSource: totalBytes ? "exact" : "unknown",
      variants: []
    };
  }

  const inspection = await inspectManifest(url, payload.kind || "", headers);
  if (!inspection.ok) return inspection;

  if (payload.kind === "hls" || /\.m3u8(?:[?#]|$)/i.test(url)) {
    const variants = await inspectHlsVariants(url, headers);
    const variantSizes = variants.map((variant) => variant.size || variant.estimatedSize).filter((size) => Number.isFinite(size));
    return {
      ok: true,
      hasDrm: inspection.hasDrm,
      durationSeconds: inspection.durationSeconds,
      totalBytes: inspection.totalBytes || (variantSizes.length ? Math.max(...variantSizes) : null),
      totalSizeSource: inspection.totalBytes ? inspection.totalSizeSource : variants.some((variant) => variant.size) ? "exact" : variantSizes.length ? "estimated" : "unknown",
      variants
    };
  }

  return {
    ok: true,
    hasDrm: inspection.hasDrm,
    durationSeconds: inspection.durationSeconds,
    totalBytes: inspection.totalBytes || null,
    totalSizeSource: inspection.totalSizeSource || "unknown",
    variants: []
  };
}

// Direct files and single-quality HLS playlists do not state a resolution,
// so read it from the first video stream. Results (including failures) are
// cached so reopening the popup does not start ffprobe again.
const qualityProbeCache = new Map();

async function probeQualityForUi(payload) {
  const now = Date.now();
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };
  const cached = qualityProbeCache.get(url);
  if (cached && now - cached.at < QUALITY_PROBE_CACHE_MS) return cached.result;

  const size = await runFfprobe(url, normalizeHeaders(payload.headers || []), payload.kind === "hls");
  const shortSide = size ? Math.min(size.width, size.height) : 0;
  const result = { ok: true, width: size?.width || null, height: size?.height || null, quality: shortSide ? `${shortSide}p` : "" };
  for (const [key, entry] of qualityProbeCache) {
    if (now - entry.at >= QUALITY_PROBE_CACHE_MS) qualityProbeCache.delete(key);
  }
  qualityProbeCache.set(url, { at: now, result });
  return result;
}

// Resolves to { width, height } of the first video stream, or null.
function runFfprobe(url, headers, isPlaylist) {
  const args = ["-v", "error", "-rw_timeout", "5000000", "-protocol_whitelist", "file,http,https,tcp,tls,crypto"];
  const userAgent = headers.find((header) => header.name.toLowerCase() === "user-agent")?.value;
  const headerText = headers
    .filter((header) => header.name.toLowerCase() !== "user-agent")
    .map((header) => `${header.name}: ${header.value}`)
    .join("\r\n");
  if (userAgent) args.push("-user_agent", userAgent);
  if (headerText) args.push("-headers", `${headerText}\r\n`);
  if (isPlaylist) args.push("-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0");
  args.push("-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", url);

  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("ffprobe", args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, QUALITY_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => finish(null)); // ffprobe missing
    child.on("close", () => {
      try {
        const stream = JSON.parse(output).streams?.[0];
        finish(stream?.width > 0 && stream?.height > 0 ? { width: stream.width, height: stream.height } : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function inspectManifest(url, kind, headers) {
  try {
    const response = await fetch(url, {
      headers: {
        ...headersToObject(headers),
        Accept: "application/vnd.apple.mpegurl,application/dash+xml,*/*"
      },
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: response.status === 403 ? "SERVER_PROTECTED_UNSUPPORTED" : `MANIFEST_FETCH_${response.status}` };
    }

    const text = (await response.text()).replace(/^\uFEFF/, "");
    if (kind === "hls" || /\.m3u8(?:[?#]|$)/i.test(url)) {
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return { ok: false, status: 422, error: "MANIFEST_NOT_HLS" };
      }
    }
    if (kind === "dash" || /\.mpd(?:[?#]|$)/i.test(url)) {
      if (!/<MPD\b/i.test(text)) {
        return { ok: false, status: 422, error: "MANIFEST_NOT_DASH" };
      }
    }
    const hasHlsKey = hasProtectedHlsKey(text);
    const hasDashProtection = /<ContentProtection\b/i.test(text);
    return {
      ok: true,
      hasDrm: hasHlsKey || hasDashProtection,
      durationSeconds: parseManifestDurationSeconds(text, kind, url),
      ...(await getManifestSizeInfo(text, kind, url, headers))
    };
  } catch {
    return { ok: false, status: 502, error: "MANIFEST_FETCH_FAILED" };
  }
}

function runFfmpeg(job, headers) {
  const isLocal = job.inputMode === "browser";
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:2",
    "-nostats",
    "-y"
  ];

  // Network flags only for remote URLs (not browser-fed local playlists)
  if (!isLocal) {
    args.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-protocol_whitelist", "file,http,https,tcp,tls,crypto"
    );
  }

  const playlistInputFlags = [
    "-allowed_extensions", "ALL",
    "-allowed_segment_extensions", "ALL",
    "-extension_picky", "0"
  ];
  args.push(...playlistInputFlags);

  const userAgent = headers.find((header) => header.name.toLowerCase() === "user-agent")?.value;
  const headerText = headers
    .filter((header) => header.name.toLowerCase() !== "user-agent")
    .map((header) => `${header.name}: ${header.value}`)
    .join("\r\n");

  if (!isLocal && userAgent) args.push("-user_agent", userAgent);
  if (!isLocal && headerText) args.push("-headers", `${headerText}\r\n`);
  args.push("-i", isLocal ? job.localPlaylistPath : job.url);
  // Input options apply per input, so the second playlist repeats them.
  const audioInput = isLocal && job.localAudioPlaylistPath;
  if (audioInput) args.push(...playlistInputFlags, "-i", job.localAudioPlaylistPath);
  args.push("-map", "0:v:0?", "-map", audioInput ? "1:a:0" : "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", job.outputPath);
  job.ffmpegArgs = redactArgs(args);

  job.status = "running";
  job.lastActivityAt = Date.now();
  const child = spawn("ffmpeg", args, { windowsHide: true });
  jobProcesses.set(job.id, child);

  child.stderr.on("data", (chunk) => {
    if (job.status === "cancelled") return;
    updateProgress(job, chunk.toString());
    job.log.push(chunk.toString().trim());
    job.log = job.log.slice(-20);
  });

  child.on("error", (error) => {
    jobProcesses.delete(job.id);
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.error = error.code === "ENOENT" ? "FFMPEG_NOT_FOUND" : error.message;
    job.exitCode = error.code || null;
    job.finishedAt = new Date().toISOString();
    cleanupBrowserTemp(job);
    persistJobsToDisk();
  });

  child.on("close", (code) => {
    jobProcesses.delete(job.id);
    if (job.status === "failed" || job.status === "cancelled") {
      if (!job.finishedAt) job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      persistJobsToDisk();
      return;
    }
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.error = code === 0 ? null : describeFfmpegExit(code, job.log);
    job.progressText = code === 0 ? `Completed ${formatBytes(job.downloadedBytes)}` : job.progressText;
    job.finishedAt = new Date().toISOString();
    cleanupBrowserTemp(job);
    persistJobsToDisk();
  });
}

function updateProgress(job, text) {
  for (const line of text.split(/\r?\n/)) {
    const [key, value] = line.split("=");
    if (!key || value == null) continue;
    if (key === "total_size") updateDownloadedBytes(job, Number(value));
    if (key === "out_time") updateDownloadedSeconds(job, parseTimeToSeconds(value));
    if (key === "out_time_ms" && !job.downloadedSeconds) updateDownloadedSeconds(job, Number(value) / 1_000_000);
    if (key === "speed") updateEta(job, value);
    if (key === "progress") {
      job.progressText = value === "end" ? "finalizing" : formatProgress(job);
    }
  }
}

function updateDownloadedBytes(job, bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  if (bytes < job.downloadedBytes) return;
  const now = Date.now();
  if (bytes > job.lastProgressBytes && job.lastProgressAt && now > job.lastProgressAt) {
    job.transferRateBytesPerSecond = (bytes - job.lastProgressBytes) / ((now - job.lastProgressAt) / 1000);
  }
  job.downloadedBytes = bytes;
  if (bytes > job.lastProgressBytes) {
    job.lastProgressBytes = bytes;
    job.lastProgressAt = now;
    job.lastActivityAt = now;
  }
}

function updateDownloadedSeconds(job, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  if (seconds > (job.downloadedSeconds || 0)) job.lastActivityAt = Date.now();
  job.downloadedSeconds = Math.max(job.downloadedSeconds || 0, seconds);
}

function updateEta(job, speedText) {
  const ffmpegSpeed = parseFloat(String(speedText).replace("x", ""));
  if (job.durationSeconds && job.downloadedSeconds && Number.isFinite(ffmpegSpeed) && ffmpegSpeed > 0) {
    const remainingMediaSeconds = Math.max(0, job.durationSeconds - job.downloadedSeconds);
    job.etaSeconds = remainingMediaSeconds / ffmpegSpeed;
    return;
  }
  if (job.totalBytes && job.transferRateBytesPerSecond > 0) {
    job.etaSeconds = Math.max(0, job.totalBytes - job.downloadedBytes) / job.transferRateBytesPerSecond;
    return;
  }
  job.etaSeconds = null;
}

function formatProgress(job) {
  const pieces = [`Downloaded ${formatBytes(job.downloadedBytes)}`];
  if (job.totalBytes) pieces[0] += ` / ${job.totalSizeSource === "estimated" ? "~" : ""}${formatBytes(job.totalBytes)}`;
  else pieces[0] += " / total unknown";
  if (job.transferRateBytesPerSecond > 0) pieces.push(`${formatBytes(job.transferRateBytesPerSecond)}/s`);
  if (job.durationSeconds) pieces.push(`${formatDuration(job.downloadedSeconds)} / ${formatDuration(job.durationSeconds)}`);
  if (job.etaSeconds != null) pieces.push(`ETA ${formatDuration(job.etaSeconds)}`);
  return pieces.join(" - ");
}

function formatBrowserReceiveProgress(job) {
  const pieces = ["Fetching browser segments"];
  if (job.totalSegments) pieces.push(`${job.receivedSegments}/${job.totalSegments}`);
  else pieces.push(String(job.receivedSegments));
  let sizeText = formatBytes(job.downloadedBytes);
  if (job.totalBytes) sizeText += ` / ${job.totalSizeSource === "estimated" ? "~" : ""}${formatBytes(job.totalBytes)}`;
  pieces.push(sizeText);
  if (job.transferRateBytesPerSecond > 0) pieces.push(`${formatBytes(job.transferRateBytesPerSecond)}/s`);
  if (job.etaSeconds != null) pieces.push(`ETA ${formatDuration(job.etaSeconds)}`);
  return pieces.join(" - ");
}

function validateUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

async function loadDownloadDir() {
  if (process.env.DOWNLOAD_DIR) return path.resolve(process.env.DOWNLOAD_DIR);
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return normalizeDownloadDir(raw.downloadDir) || DEFAULT_DOWNLOAD_DIR;
  } catch {
    return DEFAULT_DOWNLOAD_DIR;
  }
}

async function updateHelperSettings(payload) {
  const nextDownloadDir = normalizeDownloadDir(payload?.downloadDir);
  if (!nextDownloadDir) return { ok: false, status: 400, error: "INVALID_DOWNLOAD_DIR" };

  await mkdir(nextDownloadDir, { recursive: true });
  downloadDir = nextDownloadDir;
  await writeFile(CONFIG_PATH, `${JSON.stringify({ downloadDir }, null, 2)}\n`, "utf8");
  return { ok: true, settings: { downloadDir } };
}

async function pickDownloadFolder() {
  if (process.platform !== "win32") return { ok: false, status: 501, error: "FOLDER_PICKER_UNSUPPORTED" };

  const resultPath = path.join(tmpdir(), `ds-video-downloader-folder-${randomUUID()}.txt`);
  const result = await runProcess("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PICKER_SCRIPT_PATH,
    "-OutFile",
    resultPath
  ], { windowsHide: true });
  const selectedPath = await readFile(resultPath, "utf8").catch(() => "");
  await unlink(resultPath).catch(() => {});
  if (result.code !== 0 && !selectedPath.trim()) {
    return result.code === -1
      ? { ok: false, status: 500, error: `FOLDER_PICK_FAILED${result.stderr ? `: ${result.stderr.trim()}` : ""}` }
      : { ok: false, status: 400, error: "FOLDER_PICK_CANCELLED" };
  }
  if (!selectedPath.trim()) return { ok: false, status: 500, error: `FOLDER_PICK_FAILED${result.stderr ? `: ${result.stderr.trim()}` : ""}` };
  return updateHelperSettings({ downloadDir: selectedPath });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: false, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function normalizeDownloadDir(value) {
  const text = String(value || "").trim().replace(/^"|"$/g, "");
  if (!text || /[\u0000-\u001f]/.test(text)) return "";
  return path.resolve(text);
}

function showJobOutput(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  const baseDir = job.downloadDir || downloadDir;
  if (!isSafeDownloadPath(job.outputPath, baseDir)) return { ok: false, status: 403, error: "OUTPUT_PATH_UNSAFE" };

  if (process.platform === "win32") {
    // Open the containing directory. We avoid explorer /select,<path>
    // because its argument parsing is fragile — when the path contains
    // spaces or special characters, Explorer may silently fall back to
    // opening the user's Documents folder.
    const targetDir = existsSync(job.outputPath) ? path.dirname(job.outputPath) : baseDir;
    spawn("explorer.exe", [targetDir], {
      detached: true,
      stdio: "ignore"
    }).unref();
    return { ok: true };
  }

  // Non-Windows: open containing folder
  const targetPath = existsSync(job.outputPath) ? job.outputPath : baseDir;
  spawn(process.platform === "darwin" ? "open" : "xdg-open",
    [targetPath === job.outputPath ? path.dirname(targetPath) : targetPath],
    { detached: true, stdio: "ignore" }
  ).unref();
  return { ok: true };
}

async function deleteJobOutput(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status === "running" || job.status === "queued") return { ok: false, status: 409, error: "JOB_STILL_RUNNING" };
  if (!isSafeDownloadPath(job.outputPath, job.downloadDir || downloadDir)) return { ok: false, status: 403, error: "OUTPUT_PATH_UNSAFE" };

  await unlink(job.outputPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  job.status = "missing";
  job.fileExists = false;
  job.progressText = "File removed from disk";
  job.etaSeconds = null;
  await persistJobsToDisk();
  return { ok: true, job };
}

async function forgetJobRecord(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status === "queued" || job.status === "running") {
    return { ok: false, status: 409, error: "JOB_HISTORY_NOT_REMOVABLE" };
  }

  await cleanupBrowserTemp(job);
  jobs.delete(id);
  await persistJobsToDisk();
  return { ok: true };
}

function parseJobsPage(url) {
  try {
    const parsed = new URL(url, "http://127.0.0.1");
    const rawLimit = Number(parsed.searchParams.get("limit") ?? JOBS_PAGE_SIZE_DEFAULT);
    const rawOffset = Number(parsed.searchParams.get("offset") ?? 0);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), JOBS_PAGE_SIZE_MAX) : JOBS_PAGE_SIZE_DEFAULT;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    return { limit, offset };
  } catch {
    return { limit: JOBS_PAGE_SIZE_DEFAULT, offset: 0 };
  }
}

function buildJobStats() {
  const stats = { active: 0, completed: 0, failed: 0, downloadedBytes: 0 };
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") stats.active += 1;
    if (job.status === "completed") stats.completed += 1;
    if (job.status === "failed") stats.failed += 1;
    stats.downloadedBytes += Number(job.downloadedBytes) || 0;
  }
  return stats;
}

function enforceJobHistoryCap() {
  if (jobs.size <= MAX_JOB_HISTORY) return 0;
  const missing = Array.from(jobs.values())
    .filter((job) => job.status === "missing")
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  let removed = 0;
  for (const job of missing) {
    if (jobs.size <= MAX_JOB_HISTORY) break;
    jobs.delete(job.id);
    removed += 1;
  }
  if (jobs.size > MAX_JOB_HISTORY) {
    console.warn(`[helper] job history is still above ${MAX_JOB_HISTORY}; refusing to drop non-missing records`);
  }
  return removed;
}

async function clearMissingJobRecords() {
  const removed = [];
  for (const [id, job] of jobs) {
    if (job.status === "missing") removed.push(id);
  }
  for (const id of removed) jobs.delete(id);
  if (removed.length) await persistJobsToDisk();
  return { ok: true, removedCount: removed.length };
}

async function reconcileAllJobFiles() {
  let changed = false;
  for (const job of jobs.values()) changed = reconcileJobFileState(job) || changed;
  if (changed) await persistJobsToDisk();
}

function reconcileJobFileState(job) {
  if (!job?.outputPath) return false;
  const fileExists = existsSync(job.outputPath);
  let changed = job.fileExists !== fileExists;
  job.fileExists = fileExists;

  if (job.status === "completed" && !fileExists) {
    job.status = "missing";
    job.progressText = "File removed from disk";
    changed = true;
  } else if (job.status === "missing" && fileExists) {
    job.status = "completed";
    job.progressText = `Completed ${formatBytes(job.downloadedBytes)}`;
    changed = true;
  }
  return changed;
}

async function sweepStalledJobs(now = Date.now(), timeoutMs = JOB_STALL_TIMEOUT_MS) {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.resumable && now - Date.parse(job.finishedAt || 0) >= BROWSER_RESUME_TTL_MS) {
      job.resumable = false;
      await cleanupBrowserTemp(job);
      changed = true;
      continue;
    }
    if (job.status !== "running") continue;
    // Browser-fed HLS jobs can pause between uploads while the content
    // script fetches and retries segments, so use a much more lenient timeout.
    // Helper-direct jobs also get extra room for transient CDN hiccups.
    const stallTimeout = job.inputMode === "browser"
      ? Math.max(timeoutMs * 3, 10 * 60_000)
      : timeoutMs * 2;
    const lastActivityAt = Number(job.lastActivityAt || job.lastByteProgressAt || Date.parse(job.startedAt) || now);
    if (now - lastActivityAt < stallTimeout) continue;

    await failJob(job, "DOWNLOAD_STALLED", `No download progress for ${Math.round(stallTimeout / 60000)} minutes; task stopped`, now);
    terminateJobProcess(job.id);
    changed = true;
  }
  if (changed) await persistJobsToDisk();
}

function terminateJobProcess(id) {
  const child = jobProcesses.get(id);
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  if (process.platform === "win32") {
    setTimeout(() => {
      if (jobProcesses.has(id)) spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    }, 1500).unref();
  }
}

async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.status !== "running" && job.status !== "queued") return { ok: false, status: 409, error: "JOB_NOT_RUNNING" };

  job.status = "cancelled";
  job.error = null;
  // Stop works as pause for browser-fed jobs: keep the uploaded segments so
  // Resume (or downloading the same video again) continues from here.
  job.resumable = job.inputMode === "browser";
  job.progressText = "Stopped by user";
  job.finishedAt = new Date().toISOString();
  job.etaSeconds = null;
  if (!job.resumable) await cleanupBrowserTemp(job);
  await persistJobsNow();

  terminateJobProcess(id);

  return { ok: true, job };
}

function isSafeDownloadPath(value, baseDir = downloadDir) {
  if (!value) return false;
  const resolved = path.resolve(value);
  const base = path.resolve(baseDir);

  if (process.platform === "win32") {
    const relative = path.relative(base.toLowerCase(), resolved.toLowerCase());
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  const relative = path.relative(base, resolved);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function getManifestSizeInfo(text, kind, url, headers) {
  const durationSeconds = parseManifestDurationSeconds(text, kind, url);
  const estimatedTotalBytes = estimateTotalBytes(text, kind, url);

  if (!(kind === "hls" || /\.m3u8(?:[?#]|$)/i.test(url))) {
    return {
      durationSeconds,
      totalBytes: estimatedTotalBytes,
      totalSizeSource: estimatedTotalBytes ? "estimated" : "unknown"
    };
  }

  const segmentUrls = parseHlsSegmentUrls(text, url);
  if (!segmentUrls.length || segmentUrls.length > SIZE_PROBE_LIMIT) {
    return {
      durationSeconds,
      totalBytes: estimatedTotalBytes,
      totalSizeSource: estimatedTotalBytes ? "estimated" : "unknown"
    };
  }

  const exactSize = await probeSegmentSizes(segmentUrls, headers);
  return {
    durationSeconds,
    totalBytes: exactSize || estimatedTotalBytes,
    totalSizeSource: exactSize ? "exact" : estimatedTotalBytes ? "estimated" : "unknown"
  };
}

async function inspectHlsVariants(url, headers) {
  const root = await fetchText(url, headers);
  if (!root.ok) return [];
  const variants = parseHlsVariants(root.text, url);
  if (variants.length) {
    return Promise.all(variants.map(async (variant) => {
      const child = await fetchText(variant.url, headers);
      if (!child.ok) return variant;
      const durationSeconds = parseManifestDurationSeconds(child.text, "hls", variant.url);
      const bandwidth = variant.bandwidth || fallbackBandwidthForQuality(variant.quality);
      const sizeInfo = await getManifestSizeInfo(child.text, "hls", variant.url, headers);
      const estimatedSize = estimateBytes(durationSeconds, bandwidth);
      return {
        ...variant,
        durationSeconds,
        size: sizeInfo.totalSizeSource === "exact" ? sizeInfo.totalBytes : null,
        estimatedSize: sizeInfo.totalBytes || estimatedSize,
        sizeSource: sizeInfo.totalSizeSource !== "unknown" ? sizeInfo.totalSizeSource : estimatedSize ? "estimated" : ""
      };
    }));
  }

  const durationSeconds = parseManifestDurationSeconds(root.text, "hls", url);
  const quality = inferQualityLabel(url);
  const bandwidth = fallbackBandwidthForQuality(quality);
  const rootSize = await getManifestSizeInfo(root.text, "hls", url, headers);
  const estimatedSize = estimateBytes(durationSeconds, bandwidth);
  return [{
    url,
    quality,
    bandwidth,
    size: rootSize.totalSizeSource === "exact" ? rootSize.totalBytes : null,
    durationSeconds,
    estimatedSize: rootSize.totalBytes || estimatedSize,
    sizeSource: rootSize.totalSizeSource !== "unknown" ? rootSize.totalSizeSource : estimatedSize ? "estimated" : ""
  }];
}

async function fetchText(url, headers) {
  try {
    const response = await fetch(url, {
      headers: {
        ...headersToObject(headers),
        Accept: "application/vnd.apple.mpegurl,application/dash+xml,*/*"
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) return { ok: false, status: response.status, text: "" };
    return { ok: true, status: response.status, text: (await response.text()).replace(/^\uFEFF/, "") };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

function parseHlsVariants(text, manifestUrl) {
  const variants = [];
  let pending = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      pending = {
        bandwidth: readAttribute(line, "BANDWIDTH"),
        resolution: readAttribute(line, "RESOLUTION")
      };
      continue;
    }
    if (!line.startsWith("#") && pending) {
      const bandwidth = Number(pending.bandwidth);
      variants.push({
        url: resolveUrl(line, manifestUrl),
        quality: qualityLabel(pending.resolution, pending.bandwidth),
        bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null,
        estimatedSize: null,
        durationSeconds: null
      });
      pending = null;
    }
  }
  return variants;
}

// ⚠️ SYNC-POINT: Functions below are duplicated from src/shared.js.
// server.js is a standalone Node.js process and cannot import extension source.
// When changing estimateBytes, fallbackBandwidthForQuality, inferQualityLabel,
// qualityLabel, readAttribute, or resolveUrl in shared.js, you MUST manually sync here.

function readAttribute(line, key) {
  const match = line.match(new RegExp(`${key}=([^,]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "") || "";
}

function hasProtectedHlsKey(text) {
  return String(text).split(/\r?\n/).some((line) =>
    /^#EXT-X-KEY:/i.test(line) &&
    (/METHOD=SAMPLE-AES/i.test(line) || /KEYFORMAT=/i.test(line) || /URI=["']?skd:\/\//i.test(line))
  );
}

function qualityLabel(resolution, bandwidth) {
  const match = String(resolution || "").match(/(\d{2,5})x(\d{2,5})/i);
  if (match?.[2]) return `${match[2]}p`;
  const bitrate = Number(bandwidth);
  return Number.isFinite(bitrate) && bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : "";
}

function estimateBytes(durationSeconds, bandwidth) {
  const duration = Number(durationSeconds);
  const bitrate = Number(bandwidth);
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(bitrate) && bitrate > 0
    ? Math.round((duration * bitrate) / 8)
    : null;
}

function fallbackBandwidthForQuality(quality = "") {
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

function safeDecodeURIComponent(value = "") {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value);
  }
}

function inferQualityLabel(value = "") {
  const text = safeDecodeURIComponent(String(value)).toLowerCase();
  const direct = text.match(/(?:^|[^0-9])((?:2160|1440|1080|720|576|540|480|360|240|180|144))p(?:[^0-9]|$)/);
  if (direct?.[1]) return `${direct[1]}p`;
  const resolution = text.match(/(?:^|[^0-9])(\d{3,5})x((?:2160|1440|1080|720|576|540|480|360|240|180|144))(?:[^0-9]|$)/);
  if (resolution?.[2]) return `${resolution[2]}p`;
  return "";
}

function parseHlsSegmentUrls(text, manifestUrl) {
  const segments = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/\.m3u8(?:[?#]|$)/i.test(line)) return [];
    segments.push(resolveUrl(line, manifestUrl));
  }
  return segments;
}

async function probeSegmentSizes(urls, headers) {
  let total = 0;
  let known = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const size = await probeContentLength(urls[index], headers);
      if (size == null) continue;
      total += size;
      known += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(SIZE_PROBE_CONCURRENCY, urls.length) }, () => worker()));
  return known === urls.length ? total : null;
}

async function probeContentLength(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIZE_PROBE_TIMEOUT_MS);
  try {
    const baseHeaders = headersToObject(headers);
    for (const name of Object.keys(baseHeaders)) {
      if (name.toLowerCase() === "range") delete baseHeaders[name];
    }
    let response = await fetch(url, {
      method: "HEAD",
      headers: baseHeaders,
      signal: controller.signal
    });
    let size = directResponseContentLength(response);
    if (size) return size;

    response = await fetch(url, {
      method: "GET",
      headers: { ...baseHeaders, Range: "bytes=0-0" },
      signal: controller.signal
    });
    size = directResponseContentLength(response);
    await response.body?.cancel().catch(() => {});
    return size;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function directResponseContentLength(response) {
  if (!response?.ok) return null;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (/^(?:text\/html|text\/xml|application\/(?:json|xml|xhtml\+xml))\b/.test(contentType)) return null;
  const range = response.headers.get("content-range") || "";
  if (response.status === 206 && range) {
    const total = Number(range.split("/").pop());
    if (Number.isFinite(total) && total > 0) return total;
  }
  if (response.status === 206) return null;
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? length : null;
}

function parseManifestDurationSeconds(text, kind, url) {
  if (kind === "hls" || /\.m3u8(?:[?#]|$)/i.test(url)) {
    const durations = Array.from(text.matchAll(/^#EXTINF:([\d.]+)/gim)).map((match) => Number(match[1]));
    const total = durations.reduce((sum, duration) => Number.isFinite(duration) ? sum + duration : sum, 0);
    return total > 0 ? total : null;
  }

  const mpdDuration = text.match(/mediaPresentationDuration=["']([^"']+)["']/i)?.[1];
  return mpdDuration ? parseIsoDurationSeconds(mpdDuration) : null;
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function estimateTotalBytes(text, kind, url) {
  const duration = parseManifestDurationSeconds(text, kind, url);
  if (!duration) return null;

  const bandwidth = Number(
    text.match(/BANDWIDTH=(\d+)/i)?.[1] ||
    text.match(/bandwidth=["'](\d+)["']/i)?.[1]
  );
  return Number.isFinite(bandwidth) && bandwidth > 0 ? Math.round((bandwidth * duration) / 8) : null;
}

function parseIsoDurationSeconds(value) {
  const match = String(value).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match.map((part) => Number(part || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function parseTimeToSeconds(value) {
  const match = String(value).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function normalizeHeaders(headers) {
  const allowed = new Set(["accept", "origin", "referer", "user-agent", "accept-language", "cookie"]);
  return headers
    .filter((header) => header && allowed.has(String(header.name || "").toLowerCase()))
    .map((header) => ({ name: String(header.name), value: sanitizeHeaderValue(String(header.name), String(header.value || "")) }))
    .filter((header) => header.value && !/[\r\n]/.test(header.name) && !/[\r\n]/.test(header.value));
}

function sanitizeHeaderValue(name, value) {
  if (name.toLowerCase() !== "cookie") return value;
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^cf_clearance=/i.test(part) && !/^__cf_bm=/i.test(part))
    .join("; ");
}

function headersToObject(headers) {
  return Object.fromEntries(headers.map((header) => [header.name, header.value]));
}

function buildFilename(title, url) {
  const cleanTitle = String(title || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "video";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${cleanTitle}-${hash}.mp4`;
}

async function uniqueOutputPath(outputPath) {
  if (!existsSync(outputPath)) return outputPath;
  const ext = path.extname(outputPath);
  const base = outputPath.slice(0, outputPath.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

function safeBrowserFileName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name)) return "";
  if (name !== path.basename(name)) return "";
  return name;
}

async function cleanupBrowserTemp(job) {
  if (!job?.tempDir) return;
  if (!path.basename(job.tempDir).startsWith("ds-video-browser-")) return;
  await rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
}

function byteLimitError() {
  const error = new Error("REQUEST_TOO_LARGE");
  error.status = 413;
  return error;
}

async function readRawToFile(req, filePath, maxBytes) {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(byteLimitError());
        return;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(req, limiter, createWriteStream(filePath));
    return total;
  } catch (error) {
    await unlink(filePath).catch(() => {});
    throw error;
  }
}

function discardRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = byteLimitError();
        req.destroy(error);
        reject(error);
      }
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        const error = new Error("REQUEST_TOO_LARGE");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error("INVALID_JSON");
        error.status = 400;
        reject(error);
      }
    });
  });
}

function isWebOrigin(origin) {
  return Boolean(origin) && /^https?:\/\//i.test(origin);
}

function isLocalHelperOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === String(PORT);
  } catch {
    return false;
  }
}

function requiresHelperToken(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://")) return false;
  if (isLocalHelperOrigin(origin)) return false;
  return isWebOrigin(origin);
}

function hasValidHelperToken(req) {
  return req.headers["x-ds-token"] === AUTH_TOKEN;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-DS-Token");
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function describeFfmpegExit(code, log) {
  const signedCode = typeof code === "number" && code > 0x7fffffff ? code - 0x100000000 : code;
  const recentLog = Array.isArray(log) ? log.filter(Boolean).slice(-3).join(" | ") : "";
  const suffix = recentLog ? `: ${recentLog}` : "";
  if (signedCode === -1094995529) return `FFMPEG_INVALID_DATA${suffix}`;
  if (code == null) return `FFMPEG_FAILED${suffix}`;
  return `FFMPEG_EXIT_${code}${suffix}`;
}

function redactArgs(args) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    redacted.push(args[index]);
    if (args[index] === "-headers" && index + 1 < args.length) {
      redacted.push(args[index + 1].replace(/^cookie:.*$/gim, "Cookie: <redacted>"));
      index += 1;
    }
  }
  return redacted;
}

function writeHtml(res, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

// Local dashboard served at "/". Self-contained (no external fonts or scripts) so it
// works offline. Visual language matches the extension popup ("Bento Grid").
function renderHomePage() {
  const safeDir = escapeHtmlText(downloadDir);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DS Video Downloader</title>
  <style>
    /* SYNC-POINT: tokens mirror :root in src/popup.css (Bento Grid, dark + derived light). */
    :root {
      color-scheme: dark;
      --page: #0c0d10; --tile: #141519; --tile-2: #1b1c21; --inset: #0f1013;
      --edge: rgba(255, 255, 255, 0.08); --edge-hi: rgba(255, 255, 255, 0.18); --edge-max: rgba(255, 255, 255, 0.32);
      --tx: #f1f2f4; --tx-2: #a3a6ad; --tx-3: #8d9098;
      --blue: #6b97ff; --teal: #3cc8b4; --amber: #f2b84b; --coral: #ff7d6e; --on-blue: #0c0d10;
      --blue-wash: rgba(107, 151, 255, 0.14); --amber-wash: rgba(242, 184, 75, 0.13); --coral-wash: rgba(255, 125, 110, 0.13);
      --hover: rgba(255, 255, 255, 0.05); --spot: rgba(107, 151, 255, 0.1); --scrim: rgba(5, 6, 8, 0.74);
      --lift: 0 30px 60px -20px rgba(0, 0, 0, 0.8);
      --r1: 18px; --r2: 12px; --r3: 9px; --r4: 6px;
      --sans: "Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", "SF Pro Display", system-ui, "Microsoft YaHei UI", "PingFang SC", sans-serif;
      --mono: "Cascadia Mono", Consolas, "SF Mono", ui-monospace, Menlo, monospace;
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --page: #eceef2; --tile: #ffffff; --tile-2: #f5f6f8; --inset: #f0f2f5;
        --edge: rgba(20, 26, 38, 0.1); --edge-hi: rgba(20, 26, 38, 0.2); --edge-max: rgba(20, 26, 38, 0.36);
        --tx: #14161b; --tx-2: #4d525b; --tx-3: #646973;
        --blue: #2c5bd0; --teal: #0b7666; --amber: #7a4e00; --coral: #c2372a; --on-blue: #ffffff;
        --blue-wash: rgba(44, 91, 208, 0.1); --amber-wash: rgba(196, 132, 0, 0.11); --coral-wash: rgba(194, 55, 42, 0.09);
        --hover: rgba(20, 26, 38, 0.05); --spot: rgba(44, 91, 208, 0.06); --scrim: rgba(24, 28, 36, 0.42);
        --lift: 0 24px 50px -22px rgba(20, 26, 38, 0.35);
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body { min-height: 100vh; background: var(--page); color: var(--tx); font: 13px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:disabled { cursor: default; opacity: 0.4; }
    :focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
    .icon { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .wrap { padding: 24px clamp(16px, 3vw, 40px) 40px; }

    .tile { position: relative; min-width: 0; padding: 12px 14px; border: 1px solid var(--edge); border-radius: var(--r1); background: var(--tile); transition: border-color 250ms; }
    .tile:hover { border-color: var(--edge-hi); background: radial-gradient(220px circle at var(--mx, 50%) var(--my, 50%), var(--spot), transparent 70%) no-repeat, var(--tile); }

    .hero { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 20px; margin-bottom: 18px; }
    .brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--edge-hi); border-radius: 13px; background: var(--tile-2); color: var(--blue); }
    .brand-mark .icon { width: 22px; height: 22px; }
    h1 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.15; }
    .who { color: var(--tx-2); font-size: 12.5px; }
    .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; min-width: 0; max-width: 100%; }
    .fact { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; height: 32px; padding: 0 11px; border: 1px solid var(--edge); border-radius: 10px; background: var(--tile); font: 12px var(--mono); }
    .fact:has(button) { max-width: min(480px, 100%); padding-right: 5px; }
    .fact small { flex: none; color: var(--tx-3); font: 11px var(--mono); }
    .fact .val { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fact.warn { border-color: transparent; background: var(--amber-wash); color: var(--amber); }
    .fact button { flex: none; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--tx-2); }
    .fact button:hover { background: var(--hover); color: var(--tx); }
    .fact button.copied { color: var(--teal); }
    .fact button .icon { width: 14px; height: 14px; }

    .stats { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 10px; }
    .stat { grid-column: span 2; }
    #bytesCard { grid-column: span 6; }
    .stat-name { display: flex; align-items: center; gap: 6px; color: var(--tx-3); font: 600 11.5px var(--mono); }
    .stat-name::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    #bytesCard .stat-name::before { display: none; }
    #activeCard .stat-name { color: var(--blue); }
    #completedCard .stat-name { color: var(--teal); }
    #failedCard .stat-name { color: var(--coral); }
    .stat-value { margin-top: 6px; overflow: hidden; font-size: 24px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
    #bytesCard .stat-value { font-size: 44px; line-height: 1; letter-spacing: -0.02em; }
    #activeCard .stat-value { color: var(--blue); }
    #completedCard .stat-value { color: var(--teal); }
    #failedCard .stat-value { color: var(--coral); }
    .stat.is-empty .stat-value { color: var(--tx-3); }

    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 22px 0 10px; }
    .q-title { font-size: 16px; font-weight: 650; }
    .panel-count { color: var(--tx-3); font: 12px var(--mono); }
    .summary { margin-right: auto; color: var(--tx-2); font-size: 12.5px; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .small, .actions button { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border: 1px solid var(--edge-hi); border-radius: 8px; background: none; color: var(--tx); font-size: 11.5px; font-weight: 600; white-space: nowrap; transition: background-color 120ms; }
    .small:hover:not(:disabled), .actions button:hover:not(:disabled) { background: var(--hover); }
    .small .icon { width: 13px; height: 13px; }
    .page-label { padding: 0 4px; color: var(--tx-2); font: 12px var(--mono); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 10px; }
    @media (min-width: 900px) { .row.running { grid-column: span 2; } }
    .jh { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .status { display: inline-flex; flex: none; align-items: center; gap: 6px; color: var(--tx-2); font: 600 11.5px var(--mono); white-space: nowrap; }
    .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tx-3); }
    .status.running, .status.queued { color: var(--blue); }
    .status.running::before { background: var(--blue); }
    .status.queued::before { background: none; box-shadow: inset 0 0 0 1.5px var(--blue); }
    .status.completed { color: var(--teal); }
    .status.completed::before { background: var(--teal); }
    .status.failed { color: var(--coral); }
    .status.failed::before { background: var(--coral); }
    .status.missing { color: var(--amber); }
    .status.missing::before { background: none; box-shadow: inset 0 0 0 1.5px var(--amber); }
    .job-title { flex: 1; min-width: 0; overflow: hidden; font-size: 14.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .progress { margin-top: 6px; color: var(--tx-2); font-size: 12px; overflow-wrap: anywhere; }
    .row.failed .progress { color: var(--coral); }
    .path { margin-top: 3px; overflow: hidden; color: var(--tx-3); font: 10.5px/1.45 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { position: relative; height: 6px; margin-top: 12px; overflow: hidden; border-radius: 3px; background: var(--inset); }
    .bar-track i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--blue); }
    .bar-track.is-indeterminate i { animation: indeterminate 1.6s ease-in-out infinite; }
    @keyframes indeterminate { from { transform: translateX(-100%); } to { transform: translateX(400%); } }
    .meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    .chip { padding: 1px 7px; border: 1px solid var(--edge); border-radius: var(--r4); color: var(--tx-2); font: 11px/18px var(--mono); }
    details { margin-top: 9px; color: var(--tx-3); font: 11px var(--mono); }
    summary { width: max-content; cursor: pointer; }
    summary:hover { color: var(--tx); }
    code { display: block; margin-top: 6px; padding: 9px 10px; border: 1px solid var(--edge); border-radius: 10px; background: var(--inset); color: var(--tx-2); font: 11px/1.5 var(--mono); word-break: break-all; }
    .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    .actions button:disabled { display: none; }
    .actions .warning { border-color: transparent; background: var(--amber-wash); color: var(--amber); }
    .actions .danger { border-color: transparent; color: var(--coral); }

    .empty { padding: 22px; border: 1px dashed var(--edge-hi); border-radius: var(--r1); color: var(--tx-2); }
    .empty-title { color: var(--tx); font-size: 16px; font-weight: 650; }
    .empty-text { max-width: 560px; margin-top: 6px; line-height: 1.5; }
    .empty.failed { border-color: var(--coral); color: var(--coral); font-weight: 600; }

    .remove-overlay { position: fixed; z-index: 20; inset: 0; display: grid; place-items: center; padding: 20px; background: var(--scrim); }
    .remove-dialog { width: 100%; max-width: 380px; padding: 18px; border: 1px solid var(--edge-hi); border-radius: var(--r1); background: var(--tile); box-shadow: var(--lift); animation: dialog-in 200ms ease-out; }
    @keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
    .remove-dialog h3 { margin: 0 0 10px; font-size: 16px; font-weight: 650; }
    .remove-name { margin: 0 0 14px; padding: 9px 10px; border: 1px solid var(--edge); border-radius: 10px; background: var(--inset); color: var(--tx-2); font: 11.5px/1.5 var(--mono); overflow-wrap: anywhere; }
    .remove-dialog-actions { display: grid; gap: 6px; }
    .remove-dialog-actions button { min-height: 38px; padding: 0 14px; border: 1px solid var(--edge-hi); border-radius: 10px; background: var(--tile-2); color: var(--tx); font-size: 13px; font-weight: 600; text-align: left; transition: border-color 120ms; }
    .remove-dialog-actions button:hover { border-color: var(--edge-max); }
    .remove-dialog-actions .danger { border-color: transparent; background: var(--coral-wash); color: var(--coral); }
    .remove-dialog-actions .ghost { border-color: transparent; background: none; color: var(--tx-2); text-align: center; }

    @media (max-width: 1100px) {
      #bytesCard { grid-column: span 12; }
      .stat { grid-column: span 4; }
    }
    @media (max-width: 560px) {
      .facts { margin-left: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></symbol>
    <symbol id="i-copy" viewBox="0 0 24 24"><path d="M9 9h11v11H9zM15 9V4H4v11h5"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></symbol>
  </svg>
  <div class="wrap">
    <header class="hero">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><svg class="icon"><use href="#i-down"/></svg></span>
        <div><h1>Downloads</h1><div class="who">DS Video Downloader · Local helper dashboard</div></div>
      </div>
      <div class="facts">
        <span class="fact"><small>service</small><span class="val">127.0.0.1:${PORT}</span></span>
        <span class="fact"><small>downloads</small><span id="downloadPath" class="val" title="${safeDir}">${safeDir}</span>
          <button id="copyPathButton" type="button" title="Copy download path" aria-label="Copy download path"><svg class="icon"><use href="#i-copy"/></svg></button></span>
        <span class="fact warn">ffmpeg required for stream assembly</span>
      </div>
    </header>

    <section class="stats" aria-label="Download summary">
      <div id="bytesCard" class="stat tile"><div class="stat-name">downloaded</div><div id="bytesStat" class="stat-value">0 B</div></div>
      <div id="activeCard" class="stat tile"><div class="stat-name">active</div><div id="activeStat" class="stat-value">0</div></div>
      <div id="completedCard" class="stat tile"><div class="stat-name">completed</div><div id="completedStat" class="stat-value">0</div></div>
      <div id="failedCard" class="stat tile"><div class="stat-name">failed</div><div id="failedStat" class="stat-value">0</div></div>
    </section>

    <div class="bar">
      <b class="q-title">Queue</b>
      <span id="queueCount" class="panel-count"></span>
      <div id="summary" class="summary">Checking jobs...</div>
      <div class="toolbar">
        <button class="small" type="button" onclick="clearMissingJobs()">Clear missing</button>
        <button id="prevJobsPageButton" class="small" type="button" onclick="prevJobsPage()">Prev</button>
        <span id="jobsPageLabel" class="page-label">Page 1</span>
        <button id="nextJobsPageButton" class="small" type="button" onclick="nextJobsPage()">Next</button>
        <button class="small" type="button" onclick="loadJobs(true)"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button>
      </div>
    </div>

    <section id="jobs" class="panel"><div class="empty">Loading jobs...</div></section>
  </div>
  <script>
    const JOBS_PAGE_SIZE = 50;
    let jobsPageOffset = 0;
    // Keyed row cache: id -> { node, signature }. Rows are rebuilt only when the
    // job's rendered fields change, so the 1s poll no longer re-creates every row
    // (and an open "ffmpeg args" panel stays open).
    const rowCache = new Map();

    async function loadJobs(resetPage = false) {
      const root = document.querySelector("#jobs");
      if (resetPage) jobsPageOffset = 0;
      try {
        const response = await fetch('/jobs?limit=' + JOBS_PAGE_SIZE + '&offset=' + jobsPageOffset);
        const data = await response.json();
        const jobs = data.jobs || [];
        const total = data.total || jobs.length;
        const stats = data.stats || { active: 0, completed: 0, failed: 0, downloadedBytes: 0 };

        // If the current page is now past the end (e.g. records were removed),
        // jump back to the last valid page and reload once.
        if (total > 0 && jobsPageOffset >= total) {
          jobsPageOffset = Math.max(0, Math.floor((total - 1) / JOBS_PAGE_SIZE) * JOBS_PAGE_SIZE);
          loadJobs();
          return;
        }

        setText("#activeStat", stats.active);
        setText("#completedStat", stats.completed);
        setText("#failedStat", stats.failed);
        setText("#bytesStat", formatBytes(stats.downloadedBytes));
        setCardState("#activeCard", stats.active);
        setCardState("#completedCard", stats.completed);
        setCardState("#failedCard", stats.failed);
        setCardState("#bytesCard", stats.downloadedBytes);
        setText("#summary", stats.active + ' active, ' + total + ' total job' + (total === 1 ? '' : 's'));

        const prevButton = document.querySelector("#prevJobsPageButton");
        const nextButton = document.querySelector("#nextJobsPageButton");
        if (prevButton) prevButton.disabled = jobsPageOffset === 0;
        if (nextButton) nextButton.disabled = jobsPageOffset + jobs.length >= total;
        setText("#jobsPageLabel", 'Page ' + (Math.floor(jobsPageOffset / JOBS_PAGE_SIZE) + 1));

        if (!total) {
          jobsPageOffset = 0;
          setText("#queueCount", '');
          rowCache.clear();
          root.innerHTML = '<div class="empty"><div class="empty-title">No helper jobs yet</div><div class="empty-text">Start an HLS or DASH download from the extension popup. Jobs will appear here with progress, output path, and file actions.</div></div>';
          return;
        }
        renderJobList(root, jobs, total);
      } catch {
        setText("#summary", 'Helper offline');
        setText("#queueCount", '');
        setText("#activeStat", '0');
        setText("#completedStat", '0');
        setText("#failedStat", '0');
        setText("#bytesStat", '0 B');
        rowCache.clear();
        root.innerHTML = '<div class="empty failed">Could not read helper jobs.</div>';
      }
    }
    function renderJobList(root, jobs, total) {
      let grid = root.querySelector(".grid");
      if (!grid) {
        rowCache.clear();
        root.innerHTML = '<div class="grid"></div>';
        grid = root.querySelector(".grid");
      }
      const count = document.querySelector("#queueCount");
      const countText = total + ' item' + (total === 1 ? '' : 's');
      if (count.textContent !== countText) count.textContent = countText;

      const seen = new Set();
      let cursor = grid.firstElementChild;
      for (const job of jobs) {
        seen.add(job.id);
        const signature = JSON.stringify([job.status, job.error, job.progressText, job.outputPath, job.url, job.sourcePageUrl,
          job.fileExists, job.totalBytes, job.totalSizeSource, job.downloadedBytes, job.startedAt, job.ffmpegArgs,
          job.receivedSegments, job.totalSegments, job.downloadedSeconds, job.durationSeconds]);
        let entry = rowCache.get(job.id);
        if (!entry || entry.signature !== signature) {
          const holder = document.createElement('div');
          holder.innerHTML = renderJob(job);
          const node = holder.firstElementChild;
          if (entry) {
            const wasOpen = entry.node.querySelector('details')?.open;
            if (wasOpen && node.querySelector('details')) node.querySelector('details').open = true;
            entry.node.replaceWith(node);
            if (cursor === entry.node) cursor = node;
          }
          entry = { node, signature };
          rowCache.set(job.id, entry);
        }
        if (entry.node !== cursor) grid.insertBefore(entry.node, cursor);
        else cursor = cursor.nextElementSibling;
      }
      for (const [id, entry] of rowCache) {
        if (!seen.has(id)) {
          entry.node.remove();
          rowCache.delete(id);
        }
      }
    }
    function prevJobsPage() {
      jobsPageOffset = Math.max(0, jobsPageOffset - JOBS_PAGE_SIZE);
      loadJobs();
    }
    function nextJobsPage() {
      jobsPageOffset += JOBS_PAGE_SIZE;
      loadJobs();
    }
    function renderJob(job) {
      const isActive = job.status === 'running' || job.status === 'queued';
      const fileExists = job.fileExists !== false && Boolean(job.outputPath);
      const canForget = !isActive;
      const title = fileName(job.outputPath || job.url);
      const output = job.outputPath || job.url || '';
      const sourceUrl = job.sourcePageUrl || '';
      const fraction = progressFraction(job);
      const bar = isActive ? '<div class="bar-track' + (fraction === null ? ' is-indeterminate' : '') + '" aria-hidden="true"><i style="width:' + (fraction === null ? 25 : (fraction * 100).toFixed(1)) + '%"></i></div>' : '';
      return '<article class="tile row ' + escapeHtml(job.status) + '">'
        + '<div class="jh"><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(humanStatus(job.status)) + '</span>'
        + '<div class="job-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div></div>'
        + bar
        + '<div class="progress">' + escapeHtml(humanJobMessage(job)) + '</div>'
        + '<div class="path" title="' + escapeHtml(output) + '">' + escapeHtml(middleTruncate(output, 72)) + '</div>'
        + '<div class="meta"><span class="chip">TOTAL ' + escapeHtml(sizeLabel(job)) + '</span><span class="chip">DOWN ' + escapeHtml(formatBytes(job.downloadedBytes || 0)) + '</span><span class="chip">START ' + escapeHtml(timeLabel(job.startedAt)) + '</span></div>'
        + '<details><summary>ffmpeg args</summary><code>' + escapeHtml((job.ffmpegArgs || []).join(' ')) + '</code></details>'
        + '<div class="actions"><button type="button" data-action="source" data-source-url="' + escapeHtml(sourceUrl) + '" ' + (sourceUrl ? '' : 'disabled') + '>Source</button><button class="warning" type="button" data-action="cancel" data-job-id="' + escapeHtml(job.id) + '" ' + (isActive ? '' : 'disabled') + '>Stop</button><button type="button" data-action="show" data-job-id="' + escapeHtml(job.id) + '" ' + (fileExists ? '' : 'disabled') + '>Open folder</button><button class="danger" type="button" data-action="remove" data-job-id="' + escapeHtml(job.id) + '" data-file-exists="' + fileExists + '" data-title="' + escapeHtml(title) + '" ' + (canForget ? '' : 'disabled') + '>Remove</button></div>'
        + '</article>';
    }
    // SYNC-POINT: mirrors jobProgressFraction() in src/shared.js.
    function progressFraction(job) {
      let fraction = null;
      if (Number(job.totalSegments) > 0) fraction = Number(job.receivedSegments || 0) / Number(job.totalSegments);
      else if (Number(job.durationSeconds) > 0 && Number.isFinite(Number(job.downloadedSeconds))) fraction = Number(job.downloadedSeconds) / Number(job.durationSeconds);
      else if (Number(job.totalBytes) > 0 && Number.isFinite(Number(job.downloadedBytes))) fraction = Number(job.downloadedBytes) / Number(job.totalBytes);
      if (fraction === null || !Number.isFinite(fraction)) return null;
      return Math.min(job.status === 'completed' ? 1 : 0.99, Math.max(0, fraction));
    }
    async function clearMissingJobs() {
      const response = await fetch('/jobs/clear-missing', { method: 'POST' });
      if (response.ok) loadJobs(true);
    }
    async function showJob(id) {
      await fetch('/jobs/' + encodeURIComponent(id) + '/show', { method: 'POST' });
    }
    async function cancelJob(id) {
      const response = await fetch('/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
      if (response.ok) loadJobs(true);
    }
    let closeActiveDialog = null;
    function openRemoveDialog(id, fileExists, title) {
      if (!fileExists) {
        removeJob(id, 'record');
        return;
      }
      closeActiveDialog?.();
      const overlay = document.createElement('div');
      overlay.className = 'remove-overlay';
      overlay.innerHTML = '<div class="remove-dialog" role="dialog" aria-modal="true"><h3>What would you like to remove?</h3><div class="remove-body"><p class="remove-name"></p><div class="remove-dialog-actions"><button class="danger" type="button" data-remove-mode="both">Remove both</button><button type="button" data-remove-mode="file">Remove file</button><button type="button" data-remove-mode="record">Remove record</button><button class="ghost" type="button" data-remove-mode="cancel">Cancel</button></div></div></div>';
      overlay.querySelector('.remove-name').textContent = title;
      const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (closeActiveDialog === close) closeActiveDialog = null;
      };
      closeActiveDialog = close;
      const onKey = (event) => { if (event.key === 'Escape') close(); };
      overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.dataset.removeMode === 'cancel') {
          close();
          return;
        }
        const mode = event.target.dataset.removeMode;
        if (!mode) return;
        close();
        removeJob(id, mode);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      overlay.querySelector('.ghost').focus();
    }
    async function removeJob(id, mode) {
      if (mode === 'file' || mode === 'both') {
        const response = await fetch('/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) return;
      }
      if (mode === 'record' || mode === 'both') {
        const response = await fetch('/jobs/' + encodeURIComponent(id) + '/history', { method: 'DELETE' });
        if (!response.ok) return;
      }
      loadJobs(true);
    }
    function setText(selector, value) {
      const node = document.querySelector(selector);
      const text = String(value);
      if (node && node.textContent !== text) node.textContent = text;
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function humanStatus(value) {
      return ({ queued: 'Queued', running: 'Downloading', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', missing: 'File missing' })[value] || value;
    }
    function humanJobMessage(job) {
      const message = baseJobMessage(job);
      return job.resumable ? message + ' Use Resume in the extension popup, or download the same video again, to continue.' : message;
    }
    function baseJobMessage(job) {
      if (job.error === 'DOWNLOAD_STALLED') return job.progressText || 'No data received. The task was stopped.';
      if (job.error === 'HELPER_RESTARTED') return 'Download was interrupted when the helper stopped.';
      if (job.error === 'SOURCE_PAGE_CLOSED') return 'The source page was closed or reloaded, so the download stopped.';
      return job.error || job.progressText || 'Waiting';
    }
    function fileName(value) {
      return String(value || '').split(/[\\\\/]/).pop() || value || '';
    }
    function middleTruncate(value, maxLength) {
      const text = String(value || '');
      if (text.length <= maxLength) return text;
      const keep = Math.max(8, Math.floor((maxLength - 3) / 2));
      return text.slice(0, keep) + '...' + text.slice(-keep);
    }
    function setCardState(selector, value) {
      const node = document.querySelector(selector);
      if (node) node.classList.toggle('is-empty', !value);
    }
    function sizeLabel(job) {
      if (!job.totalBytes) return 'unknown';
      return (job.totalSizeSource === 'estimated' ? '~' : '') + formatBytes(job.totalBytes) + ' (' + job.totalSizeSource + ')';
    }
    function formatBytes(bytes) {
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = Number(bytes) || 0;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
      return (value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
    }
    function timeLabel(value) {
      if (!value) return 'unknown';
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    document.querySelector("#jobs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "cancel") cancelJob(button.dataset.jobId);
      if (button.dataset.action === "show") showJob(button.dataset.jobId);
      if (button.dataset.action === "remove") openRemoveDialog(button.dataset.jobId, button.dataset.fileExists === 'true', button.dataset.title || 'Download');
      if (button.dataset.action === "source" && button.dataset.sourceUrl) window.open(button.dataset.sourceUrl, '_blank', 'noopener');
    });
    document.querySelector("#copyPathButton").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const ok = await navigator.clipboard.writeText(document.querySelector("#downloadPath").textContent).then(() => true, () => false);
      button.classList.toggle('copied', ok);
      if (ok) setTimeout(() => button.classList.remove('copied'), 1200);
    });
    // Bento hover light: keeps the hovered tile's --mx / --my at the pointer position.
    document.addEventListener("pointermove", (event) => {
      const tile = event.target.closest?.(".tile");
      if (!tile) return;
      const box = tile.getBoundingClientRect();
      tile.style.setProperty("--mx", (event.clientX - box.left) + "px");
      tile.style.setProperty("--my", (event.clientY - box.top) + "px");
    }, { passive: true });
    loadJobs();
    setInterval(loadJobs, 1000);
  </script>
</body>
</html>`;
}
