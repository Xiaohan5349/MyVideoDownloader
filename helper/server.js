import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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
const MAX_JOB_HISTORY = 5000;
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
          job.status = "failed";
          job.error = "HELPER_RESTARTED";
          job.progressText = "Download interrupted when the helper stopped";
          job.finishedAt = new Date().toISOString();
          job.etaSeconds = null;
          await cleanupBrowserTemp(job).catch(() => {});
        }
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

  const id = randomUUID();
  const filename = buildFilename(payload.title || "video", url);
  const outputPath = await uniqueOutputPath(path.join(downloadDir, filename));
  const tempDir = path.join(tmpdir(), `ds-video-browser-${id}`);
  await mkdir(tempDir, { recursive: true });

  const job = {
    id,
    ok: true,
    inputMode: "browser",
    status: "running",
    url,
    sourcePageUrl: validateUrl(payload?.sourcePageUrl) || "",
    outputPath,
    downloadDir,
    tempDir,
    localPlaylistPath: null,
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
  return { ok: true, job };
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
  if (playlistText.length > 20 * 1024 * 1024) return { ok: false, status: 413, error: "PLAYLIST_TOO_LARGE" };

  if (Number.isInteger(job.totalSegments) && job.receivedSegments < job.totalSegments) {
    job.status = "failed";
    job.error = "SEGMENTS_INCOMPLETE";
    job.progressText = `Expected ${job.totalSegments} segments but received ${job.receivedSegments}`;
    job.finishedAt = new Date().toISOString();
    job.etaSeconds = null;
    await cleanupBrowserTemp(job);
    await persistJobsNow();
    return { ok: false, status: 409, error: "SEGMENTS_INCOMPLETE" };
  }

  const playlistPath = path.join(job.tempDir, "input.m3u8");
  await writeFile(playlistPath, playlistText, "utf8");
  job.localPlaylistPath = playlistPath;
  job.url = playlistPath;
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

  job.status = "failed";
  job.error = String(payload?.error || "BROWSER_HLS_FAILED").slice(0, 500);
  job.progressText = job.error;
  job.finishedAt = new Date().toISOString();
  job.etaSeconds = null;
  await cleanupBrowserTemp(job);
  await persistJobsToDisk();
  return { ok: true, job };
}

async function inspectForUi(payload) {
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };

  const headers = normalizeHeaders(payload.headers || []);
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

  args.push(
    "-allowed_extensions", "ALL",
    "-allowed_segment_extensions", "ALL",
    "-extension_picky", "0"
  );

  const userAgent = headers.find((header) => header.name.toLowerCase() === "user-agent")?.value;
  const headerText = headers
    .filter((header) => header.name.toLowerCase() !== "user-agent")
    .map((header) => `${header.name}: ${header.value}`)
    .join("\r\n");

  if (!isLocal && userAgent) args.push("-user_agent", userAgent);
  if (!isLocal && headerText) args.push("-headers", `${headerText}\r\n`);
  args.push("-i", job.url, "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", job.outputPath);
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
    if (job.status !== "running") continue;
    // Browser-fed HLS jobs can pause between uploads while the content
    // script fetches and retries segments, so use a more lenient timeout.
    const stallTimeout = job.inputMode === "browser" ? timeoutMs * 3 : timeoutMs;
    const lastActivityAt = Number(job.lastActivityAt || job.lastByteProgressAt || Date.parse(job.startedAt) || now);
    if (now - lastActivityAt < stallTimeout) continue;

    job.status = "failed";
    job.error = "DOWNLOAD_STALLED";
    job.progressText = `No download progress for ${Math.round(stallTimeout / 60000)} minutes; task stopped`;
    job.finishedAt = new Date(now).toISOString();
    job.etaSeconds = null;
    await cleanupBrowserTemp(job);
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
  job.progressText = "Stopped by user";
  job.finishedAt = new Date().toISOString();
  job.etaSeconds = null;
  await cleanupBrowserTemp(job);
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
    let response = await fetch(url, {
      method: "HEAD",
      headers: headersToObject(headers),
      signal: controller.signal
    });
    let size = Number(response.headers.get("content-length"));
    if (response.ok && Number.isFinite(size) && size > 0) return size;

    response = await fetch(url, {
      method: "GET",
      headers: { ...headersToObject(headers), Range: "bytes=0-0" },
      signal: controller.signal
    });
    const range = response.headers.get("content-range");
    size = range ? Number(range.split("/").pop()) : Number(response.headers.get("content-length"));
    return response.ok && Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

function renderHomePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DS Video Downloader</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=M+PLUS+1+Code:wght@400;600;700&family=Rajdhani:wght@500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #060709;
      --ink: #E8E6E3;
      --muted: #8B8982;
      --faint: #5E5C55;
      --line: rgba(255, 255, 255, 0.07);
      --line-strong: rgba(255, 255, 255, 0.14);
      --glass: rgba(255, 255, 255, 0.02);
      --glass-elevated: rgba(255, 255, 255, 0.04);
      --cyan: #00E5FF;
      --cyan-soft: rgba(0, 229, 255, 0.08);
      --cyan-glow: rgba(0, 229, 255, 0.04);
      --emerald: #00E676;
      --emerald-soft: rgba(0, 230, 118, 0.08);
      --amber: #FFD600;
      --amber-soft: rgba(255, 214, 0, 0.07);
      --rose: #FF5252;
      --rose-soft: rgba(255, 82, 82, 0.08);
      --pink: #FF7EB3;
      --pink-soft: rgba(255, 126, 179, 0.06);
      --lavender: #A996FF;
      --lavender-soft: rgba(169, 150, 255, 0.06);
      --sans: "M PLUS Rounded 1c", "Zen Kaku Gothic New", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      --mono: "M PLUS 1 Code", "JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Consolas, monospace;
      --ease: cubic-bezier(0.19, 1, 0.22, 1);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background:
        radial-gradient(ellipse at 22% 0%, rgba(0, 229, 255, 0.06), transparent 55%),
        radial-gradient(ellipse at 78% 15%, rgba(0, 230, 118, 0.03), transparent 45%),
        radial-gradient(ellipse at 50% 85%, rgba(255, 82, 82, 0.02), transparent 50%),
        radial-gradient(ellipse at 88% 72%, rgba(255, 126, 179, 0.05), transparent 50%),
        radial-gradient(ellipse at 12% 78%, rgba(169, 150, 255, 0.04), transparent 45%),
        var(--bg);
      color: var(--ink);
      font: 15px/1.5 var(--sans);
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.06;
      background-image:
        url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='256' height='256' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E"),
        repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.01) 2px, rgba(255,255,255,0.01) 3px);
      mix-blend-mode: soft-light;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.20;
      background-image:
        /* White stars */
        radial-gradient(circle at 18% 18%, rgba(255,255,255,0.65) 0 1px, transparent 1.6px),
        radial-gradient(circle at 55% 8%, rgba(255,255,255,0.55) 0 1px, transparent 1.5px),
        radial-gradient(circle at 30% 58%, rgba(255,255,255,0.50) 0 1px, transparent 1.6px),
        radial-gradient(circle at 92% 44%, rgba(255,255,255,0.45) 0 1px, transparent 1.5px),
        /* Cyan stars */
        radial-gradient(circle at 74% 26%, rgba(0,229,255,0.45) 0 1px, transparent 1.8px),
        radial-gradient(circle at 8% 42%, rgba(0,229,255,0.35) 0 1px, transparent 1.5px),
        radial-gradient(circle at 62% 70%, rgba(0,229,255,0.30) 0 1px, transparent 1.6px),
        /* Gold stars */
        radial-gradient(circle at 42% 80%, rgba(255,214,0,0.35) 0 1px, transparent 1.5px),
        radial-gradient(circle at 85% 14%, rgba(255,214,0,0.30) 0 1px, transparent 1.6px),
        radial-gradient(circle at 14% 68%, rgba(255,214,0,0.25) 0 1px, transparent 1.5px),
        /* Pink stardust motes */
        radial-gradient(circle at 46% 32%, rgba(255,126,179,0.28) 0 1px, transparent 1.5px),
        radial-gradient(circle at 6% 12%, rgba(255,126,179,0.22) 0 1px, transparent 1.4px),
        /* Lavender motes */
        radial-gradient(circle at 90% 58%, rgba(169,150,255,0.22) 0 1px, transparent 1.5px),
        radial-gradient(circle at 68% 90%, rgba(169,150,255,0.18) 0 1px, transparent 1.4px);
      background-size:
        280px 220px, 200px 180px, 240px 200px, 180px 220px,
        320px 260px, 200px 240px, 260px 200px,
        300px 240px, 220px 180px, 240px 220px,
        200px 200px, 180px 160px,
        240px 200px, 200px 180px;
      animation: starDrift 42s linear infinite;
    }
    ::-webkit-scrollbar { width: 4px; height: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); }

    button {
      min-height: 32px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--muted);
      font: 600 11px/1 var(--sans);
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: all 0.2s var(--ease);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    button:hover {
      border-color: var(--line-strong);
      background: rgba(255,255,255,0.06);
      color: var(--ink);
    }
    button:disabled { opacity: 0.3; cursor: default; pointer-events: none; }
    button.warning { color: var(--amber); }
    button.warning:hover { border-color: rgba(255,214,0,0.25); background: var(--amber-soft); color: var(--amber); }
    button.danger { color: var(--muted); }
    button.danger:hover { color: var(--rose); border-color: rgba(255,82,82,0.25); background: var(--rose-soft); }

    .shell {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(228px, 17vw) minmax(0, 1fr);
      min-height: 100vh;
    }
    /* Magic circle background */
    .shell::before {
      content: "";
      position: fixed;
      top: 50%;
      left: 50%;
      width: min(80vh, 80vw);
      height: min(80vh, 80vw);
      margin: calc(min(80vh,80vw)/-2) 0 0 calc(min(80vh,80vw)/-2);
      pointer-events: none;
      z-index: -1;
      border-radius: 50%;
      opacity: 0.45;
      background:
        radial-gradient(circle at 50% 50%, transparent 54%, rgba(0,229,255,0.04) 55%, transparent 57%),
        radial-gradient(circle at 50% 50%, transparent 46%, rgba(255,214,0,0.03) 47%, transparent 49%),
        radial-gradient(circle at 50% 50%, transparent 38%, rgba(169,150,255,0.025) 39%, transparent 41%),
        radial-gradient(circle at 50% 50%, transparent 28%, rgba(0,229,255,0.012) 30%, transparent 32%),
        radial-gradient(circle at 50% 50%, rgba(0,229,255,0.015) 0%, transparent 45%);
      animation: magicCircleBreathe 8s ease-in-out infinite;
    }
    /* God ray */
    .shell::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: -1;
      background: linear-gradient(
        108deg,
        transparent 36%,
        rgba(0,229,255,0.02) 38%,
        rgba(255,214,0,0.01) 40%,
        rgba(255,126,179,0.007) 42%,
        transparent 44%
      );
      animation: godRayPulse 7s ease-in-out infinite;
    }

    .rail {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 20px;
      min-width: 0;
      padding: clamp(16px, 2vw, 26px);
      border-right: 1px solid var(--line);
      background: var(--glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    .brand { position: relative; }
    .brand-mark {
      position: relative;
      width: 32px;
      height: 32px;
      margin-bottom: 18px;
      background:
        radial-gradient(circle at 35% 30%, rgba(255,255,255,0.35) 0%, rgba(0,229,255,0.10) 40%, transparent 100%);
      border: 1px solid rgba(0, 229, 255, 0.22);
      box-shadow: 0 0 12px rgba(0,229,255,0.12), 0 0 28px rgba(0,229,255,0.05), inset 0 0 16px rgba(0,229,255,0.04);
      /* Hexagon tech core */
      clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
      animation: brandGlowPulse 4s ease-in-out infinite;
    }
    .brand-mark::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 12px;
      height: 12px;
      margin: -6px 0 0 -6px;
      border: 1px solid rgba(232,230,227,0.25);
      border-radius: 2px;
      transform: rotate(45deg);
      animation: brandSpin 6s linear infinite;
    }
    .brand h1 {
      margin: 0;
      max-width: 11rem;
      font-size: clamp(20px, 2vw, 28px);
      line-height: 0.95;
      font-weight: 800;
      letter-spacing: -0.04em;
    }
    .brand p {
      margin: 10px 0 0;
      font-size: 12px;
    }
    .brand p, .rail-label, .summary, .panel-count { color: var(--muted); }

    .rail-stack {
      display: grid;
      align-content: start;
      gap: 10px;
    }
    .rail-section {
      position: relative;
      overflow: hidden;
      min-width: 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--glass-elevated);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .rail-label {
      margin-bottom: 8px;
      font: 700 9px/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .rail-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
    }
    .rail-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 11px/1.4 var(--mono);
      letter-spacing: 0.04em;
      color: var(--ink);
    }
    .icon-button {
      width: 30px;
      min-height: 28px;
      padding: 0;
      display: grid;
      place-items: center;
      color: var(--faint);
    }
    .icon-button:hover { color: var(--ink); }

    /* ffmpeg banner -- amber warning with mechanical breathing pulse */
    .runtime-banner {
      position: relative;
      overflow: hidden;
      padding: 12px;
      border: 1px solid rgba(255, 214, 0, 0.15);
      border-radius: 4px;
      background: rgba(255, 214, 0, 0.05);
      color: #D4B84C;
      font: 10px/1.4 var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      animation: ffmpegBreathe 3s ease-in-out infinite;
    }
    .runtime-banner::after {
      content: "";
      position: absolute;
      inset: auto 0 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,0,0.5), transparent);
      animation: pulseLine 3s var(--ease) infinite;
    }

    .main {
      min-width: 0;
      padding: clamp(18px, 2.6vw, 36px);
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h2 {
      margin: 0;
      font-size: clamp(30px, 3.6vw, 54px);
      line-height: 0.88;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: var(--ink);
    }
    .summary {
      margin-top: 12px;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat {
      position: relative;
      overflow: hidden;
      min-width: 0;
      min-height: 120px;
      display: grid;
      align-content: space-between;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--glass-elevated);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      transition: opacity 0.2s var(--ease), border-color 0.2s var(--ease), background 0.2s var(--ease);
    }
    .stat:hover {
      border-color: var(--line-strong);
      box-shadow: 0 0 20px var(--cyan-glow);
    }
    /* Corner bracket on stat hover -- asymmetric, neon-cyan */
    .stat::before {
      content: "";
      position: absolute;
      top: -1px;
      left: -1px;
      width: 16px;
      height: 16px;
      border-top: 2px solid var(--cyan);
      border-left: 2px solid var(--cyan);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s var(--ease);
      z-index: 1;
    }
    .stat:hover::before {
      opacity: 1;
    }
    .stat.is-empty {
      opacity: 0.40;
      background: rgba(255,255,255,0.01);
    }
    .stat.is-empty::before {
      opacity: 0;
    }
    .stat-name {
      font: 700 9px/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .stat-value {
      margin-top: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--sans);
      font-size: clamp(46px, 6vw, 78px);
      font-weight: 800;
      line-height: 0.82;
      letter-spacing: -0.07em;
    }

    .panel {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--glass-elevated);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      font: 700 9px/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .panel-count { font: 700 9px/1 var(--mono); }

    .row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(80px, 130px) minmax(0, 1fr) auto;
      gap: 14px;
      align-items: start;
      min-width: 0;
      padding: 14px 16px;
      border-top: 1px solid var(--line);
      transition: background 0.2s var(--ease), border-color 0.2s var(--ease);
    }
    .row:first-child { border-top: 0; }
    .row:hover {
      background: rgba(255,255,255,0.02);
      border-color: var(--line-strong);
      box-shadow: 0 0 16px var(--cyan-glow);
    }
    /* Corner bracket on job row hover */
    .row::before {
      content: "";
      position: absolute;
      top: -1px;
      left: -1px;
      width: 14px;
      height: 14px;
      border-top: 2px solid var(--cyan);
      border-left: 2px solid var(--cyan);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s var(--ease);
      z-index: 1;
    }
    .row:hover::before {
      opacity: 1;
    }

    .thumb {
      position: relative;
      aspect-ratio: 16 / 9;
      min-width: 0;
      width: 100%;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 4px;
      background:
        radial-gradient(circle at 30% 28%, rgba(255,255,255,0.30), transparent 12%),
        linear-gradient(135deg, rgba(0,229,255,0.12), transparent 40%),
        linear-gradient(315deg, rgba(0,230,118,0.08), transparent 45%),
        rgba(6, 7, 9, 0.6);
      box-shadow: inset 0 0 20px rgba(0,229,255,0.03);
    }
    .thumb::after {
      content: "";
      position: absolute;
      inset: auto 12px 12px auto;
      width: 14px;
      height: 14px;
      border-right: 1px solid rgba(255,255,255,0.18);
      border-bottom: 1px solid rgba(255,255,255,0.18);
    }

    .job-main { min-width: 0; }
    .title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .job-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .status {
      flex: 0 0 auto;
      width: fit-content;
      padding: 3px 8px;
      border-radius: 2px;
      font: 700 9px/1.2 var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      background: rgba(255,255,255,0.04);
    }
    .status.completed { color: var(--emerald); background: var(--emerald-soft); }
    .status.failed { color: var(--rose); background: var(--rose-soft); }
    .status.missing { color: var(--amber); background: var(--amber-soft); }
    .status.running, .status.queued { color: var(--amber); background: var(--amber-soft); animation: pulseRunning 2.4s ease-in-out infinite; }
    .status.cancelled { color: var(--faint); background: rgba(255,255,255,0.03); }

    .progress {
      margin-top: 8px;
      font: 10px/1.4 var(--mono);
      letter-spacing: 0.08em;
      color: var(--faint);
    }
    .path {
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 9px/1.4 var(--mono);
      letter-spacing: 0.08em;
      color: rgba(139,137,130,0.5);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 10px;
    }
    .chip {
      padding: 3px 7px;
      border-radius: 2px;
      background: rgba(255,255,255,0.03);
      color: var(--faint);
      font: 700 9px/1 var(--mono);
      letter-spacing: 0.08em;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 5px;
      padding-top: 2px;
    }

    .empty {
      display: grid;
      place-items: center;
      min-height: 320px;
      padding: 32px;
      text-align: center;
    }
    .empty-box { max-width: 400px; }
    .empty-title {
      font-size: 17px;
      font-weight: 720;
      color: var(--ink);
      letter-spacing: -0.02em;
    }
    .empty-text {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
    }
    .empty.failed { color: var(--rose); }

    details { margin-top: 10px; }
    summary {
      cursor: pointer;
      font: 9px/1 var(--mono);
      letter-spacing: 0.08em;
      color: var(--faint);
      transition: color 0.2s var(--ease);
    }
    summary:hover { color: var(--muted); }
    code {
      display: block;
      margin-top: 8px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(0,0,0,0.2);
      white-space: pre-wrap;
      word-break: break-word;
      font: 9px/1.45 var(--mono);
      color: var(--faint);
    }

    @keyframes pulseLine {
      0%, 100% { opacity: 0.15; transform: translateX(-35%); }
      50% { opacity: 0.6; transform: translateX(35%); }
    }
    @keyframes starDrift {
      from { background-position: 0 0, 0 0, 0 0, 0 0; }
      to { background-position: 80px -40px, -90px 60px, 34px 20px, -58px 38px; }
    }
    @keyframes brandSpin {
      0% { transform: rotate(45deg); }
      100% { transform: rotate(405deg); }
    }
    @keyframes ffmpegBreathe {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }
    @keyframes pulseRunning {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.50; }
    }
    @keyframes brandGlowPulse {
      0%, 100% { box-shadow: 0 0 12px rgba(0,229,255,0.12), 0 0 28px rgba(0,229,255,0.05); }
      50% { box-shadow: 0 0 18px rgba(0,229,255,0.20), 0 0 40px rgba(0,229,255,0.08); }
    }
    @keyframes magicCircleBreathe {
      0%, 100% { transform: scale(1); opacity: 0.40; }
      50% { transform: scale(1.04); opacity: 0.65; }
    }
    @keyframes godRayPulse {
      0%, 100% { opacity: 0.25; }
      50% { opacity: 0.75; }
    }

    :root {
      --ink: #F2F0E8;
      --muted: #9A968B;
      --line: rgba(255,255,255,0.10);
      --line-strong: rgba(255,255,255,0.24);
      --glass: rgba(255,255,255,0.025);
      --glass-elevated: rgba(255,255,255,0.055);
      --cyan: #29E7FF;
      --cyan-soft: rgba(41,231,255,0.11);
      --cyan-glow: rgba(41,231,255,0.14);
      --amber: #FFCD42;
      --amber-soft: rgba(255,205,66,0.11);
      --emerald: #3CFF9E;
      --emerald-soft: rgba(60,255,158,0.10);
      --sans: "Rajdhani", ui-sans-serif, system-ui, sans-serif;
      --display: "Bebas Neue", "Rajdhani", ui-sans-serif, system-ui, sans-serif;
    }
    body {
      background:
        linear-gradient(135deg, rgba(0,0,0,0.98) 0 10%, transparent 10% 100%),
        radial-gradient(ellipse at 18% 0%, rgba(41,231,255,0.16), transparent 34rem),
        radial-gradient(ellipse at 100% 18%, rgba(255,138,61,0.10), transparent 28rem),
        radial-gradient(ellipse at 55% 100%, rgba(60,255,158,0.07), transparent 30rem),
        #060709;
    }
    button,
    .rail-section,
    .runtime-banner,
    .stat,
    .panel,
    .row,
    code {
      border-radius: 0;
      clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
    }
    button {
      font-family: var(--mono);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.10em;
    }
    .shell {
      border: 14px solid #010204;
      min-height: 100vh;
      background: rgba(8,10,14,0.74);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07);
    }
    .rail {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.018)),
        rgba(0,0,0,0.38);
    }
    .brand h1,
    h2 {
      font-family: var(--display);
      font-weight: 400;
      letter-spacing: 0.01em;
      text-transform: uppercase;
    }
    .brand h1 {
      font-size: clamp(34px, 3vw, 52px);
      max-width: 13rem;
    }
    h2 {
      font-size: clamp(54px, 7vw, 112px);
      line-height: 0.78;
    }
    .summary {
      font: 700 11px/1.4 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--cyan);
    }
    .stat {
      min-height: 136px;
      background:
        linear-gradient(135deg, rgba(255,255,255,0.065), rgba(255,255,255,0.016)),
        rgba(0,0,0,0.24);
    }
    .stat-value {
      font-family: var(--display);
      font-weight: 400;
      letter-spacing: 0.01em;
    }
    .panel-head {
      background: rgba(0,0,0,0.22);
      color: var(--ink);
    }
    .row {
      grid-template-columns: minmax(108px, 158px) minmax(0, 1fr) auto;
      gap: 16px;
      background: rgba(255,255,255,0.012);
    }
    .row:hover {
      background: rgba(255,255,255,0.04);
      transform: translateY(-1px);
    }
    .thumb {
      border-color: rgba(41,231,255,0.22);
      border-radius: 0;
      clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px));
      background:
        linear-gradient(135deg, rgba(41,231,255,0.22), transparent 42%),
        linear-gradient(315deg, rgba(255,205,66,0.18), transparent 48%),
        radial-gradient(circle at 34% 32%, rgba(255,255,255,0.34), transparent 13%),
        rgba(0,0,0,0.5);
    }
    .thumb::before {
      content: "STREAM";
      position: absolute;
      left: 9px;
      top: 8px;
      color: rgba(242,240,232,0.62);
      font: 700 8px/1 var(--mono);
      letter-spacing: 0.14em;
    }
    .job-title {
      font-size: 17px;
      font-weight: 700;
    }
    .job-title::after {
      content: "";
      display: block;
      width: 100%;
      height: 1px;
      margin-top: 7px;
      background: linear-gradient(90deg, rgba(41,231,255,0.50), transparent);
    }
    .status,
    .chip {
      border-radius: 0;
      clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 0 100%);
    }
    .status.completed { color: var(--emerald); background: var(--emerald-soft); }
    .status.missing { color: var(--amber); background: var(--amber-soft); }
    .status.running,
    .status.queued {
      color: var(--amber);
      background: var(--amber-soft);
    }
    .actions {
      align-items: stretch;
      padding: 4px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.24);
    }
    .runtime-banner {
      border-color: rgba(255,205,66,0.28);
      background: rgba(255,205,66,0.10);
      color: var(--amber);
    }

    @media (max-width: 1024px) {
      .stats { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .rail {
        grid-template-rows: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .rail-stack { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 700px) {
      .main { padding: 14px; }
      header { flex-direction: column; align-items: flex-start; }
      .toolbar { justify-content: flex-start; }
      .rail-stack, .row { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; flex-wrap: wrap; }
      .thumb { max-width: 220px; }
      .stats { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat { min-height: 100px; padding: 14px; }
      .stat-value { font-size: clamp(36px, 12vw, 56px); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
    /* Clean download-manager theme */
    :root {
      --bg: #171613;
      --surface: transparent;
      --surface-2: rgba(255, 255, 255, 0.04);
      --line: rgba(255, 255, 255, 0.3);
      --line-strong: rgba(255, 255, 255, 0.58);
      --ink: #fffdf7;
      --muted: rgba(255, 253, 247, 0.72);
      --faint: rgba(255, 253, 247, 0.48);
      --cyan: #f0dfb8;
      --cyan-soft: rgba(240, 223, 184, 0.12);
      --emerald: #79bd91;
      --emerald-soft: #18251c;
      --amber: #d4a65d;
      --amber-soft: #2a2318;
      --rose: #d17b78;
      --rose-soft: #2b1c1b;
      --sans: "Bahnschrift", "Microsoft JhengHei UI", "Microsoft YaHei UI", sans-serif;
      --mono: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
    }

    body {
      min-width: 320px;
      position: relative;
      isolation: isolate;
      background: var(--bg) url('/assets/app-background.webp') center / cover fixed no-repeat !important;
      color: var(--ink);
      font-family: var(--sans);
      letter-spacing: 0;
    }

    body::before,
    body::after,
    .shell::before,
    .shell::after,
    .rail::before,
    .rail::after,
    .brand-mark::before,
    .brand-mark::after,
    .thumb::before,
    .thumb::after,
    .row::before,
    .row::after,
    .stat::before,
    .stat::after,
    .panel::before,
    .panel::after {
      display: none !important;
    }

    body::before {
      content: "";
      position: fixed;
      z-index: -1;
      inset: 0;
      display: block !important;
      background: rgba(14, 13, 11, 0.32);
      pointer-events: none;
    }

    .shell {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 1fr;
      min-height: 100vh;
    }

    .rail {
      position: relative;
      top: auto;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 20px;
      min-height: 64px;
      height: auto;
      padding: 10px 24px;
      overflow: visible;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: rgba(0, 0, 0, 0.04) !important;
      backdrop-filter: none;
      box-shadow: none;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 220px;
      margin: 0;
      padding: 0;
      border: 0;
    }

    .brand-mark {
      width: 28px;
      height: 28px;
      margin: 0;
      border: 1px solid #595348;
      border-radius: 7px;
      background: transparent !important;
      box-shadow: none;
      clip-path: none;
    }

    .brand h1 {
      margin: 0;
      font-family: var(--sans);
      font-size: 15px;
      font-weight: 650;
      line-height: 1.2;
      letter-spacing: 0;
      text-transform: none;
    }

    .brand p {
      display: none;
    }

    .rail-stack {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
      margin: 0 0 0 auto;
    }

    .rail-section {
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent !important;
      box-shadow: none;
      clip-path: none;
    }

    .rail-section:first-child {
      display: none;
    }

    .rail-label {
      margin-bottom: 2px;
      color: var(--faint);
      font: 11px/1.2 var(--sans);
      letter-spacing: 0;
      text-transform: none;
    }

    .rail-row {
      gap: 6px;
    }

    .rail-value {
      max-width: min(42vw, 480px);
      color: var(--muted);
      font: 11px/1.3 var(--mono);
      letter-spacing: 0;
    }

    .icon-button {
      width: 30px;
      height: 30px;
      min-height: 30px;
      padding: 0;
      border-radius: 6px;
    }

    .runtime-banner {
      margin: 0;
      padding: 6px 9px;
      border: 1px solid #4a402e;
      border-radius: 6px;
      background: var(--amber-soft) !important;
      color: var(--amber);
      font: 11px/1.2 var(--sans);
      letter-spacing: 0;
      text-transform: none;
      animation: none;
    }

    .main {
      width: 100%;
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    header {
      min-height: 40px;
      margin-bottom: 16px;
      padding: 0;
      border: 0;
    }

    header h2 {
      margin: 0;
      font-family: var(--sans);
      font-size: 20px;
      font-weight: 650;
      line-height: 1.3;
      letter-spacing: 0;
      text-transform: none;
    }

    .summary {
      margin-top: 3px;
      color: var(--muted);
      font: 12px/1.3 var(--sans);
      letter-spacing: 0;
      text-transform: none;
    }

    button {
      min-height: 32px;
      padding: 0 11px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05) !important;
      color: var(--ink);
      font: 12px/1 var(--sans);
      letter-spacing: 0;
      text-transform: none;
      clip-path: none;
      box-shadow: none;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }

    button:hover:not(:disabled) {
      border-color: var(--line-strong);
      background: rgba(255, 255, 255, 0.10) !important;
      color: var(--ink);
      transform: none;
    }

    button:disabled {
      opacity: 0.34;
    }

    .toolbar {
      gap: 8px;
    }

    .stats {
      display: flex;
      align-items: stretch;
      gap: 0;
      margin-bottom: 14px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: transparent;
      backdrop-filter: none;
    }

    .stat {
      flex: 1;
      min-height: 72px;
      padding: 12px 14px;
      border: 0;
      border-right: 1px solid var(--line);
      border-radius: 0;
      background: transparent !important;
      box-shadow: none;
      clip-path: none;
      backdrop-filter: none !important;
    }

    .stat:last-child {
      border-right: 0;
    }

    .stat.is-empty {
      opacity: 0.6;
    }

    .stat-label {
      color: var(--muted);
      font: 11px/1.2 var(--sans);
      letter-spacing: 0;
      text-transform: none;
    }

    .stat-value {
      margin-top: 6px;
      color: var(--ink);
      font-family: var(--sans);
      font-size: 22px;
      font-weight: 650;
      line-height: 1;
      letter-spacing: 0;
    }

    .panel {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: transparent !important;
      box-shadow: none;
      clip-path: none;
      backdrop-filter: none !important;
    }

    .panel-head {
      min-height: 44px;
      padding: 0 14px;
      border-bottom: 1px solid var(--line);
      color: var(--ink);
      font: 600 13px/1 var(--sans);
      letter-spacing: 0;
      text-transform: none;
      background: transparent;
    }

    .panel-count {
      color: var(--muted);
      font-weight: 400;
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(240px, auto);
      gap: 18px;
      align-items: start;
      padding: 14px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent !important;
      box-shadow: none;
      clip-path: none;
      transition: background-color 140ms ease;
    }

    .row:last-child {
      border-bottom: 0;
    }

    .row:hover {
      border-color: var(--line);
      background: rgba(255, 255, 255, 0.05) !important;
      transform: none;
      box-shadow: none;
    }

    .thumb {
      display: none;
    }

    .title-row {
      align-items: center;
      gap: 8px;
    }

    .job-title {
      color: var(--ink);
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0;
    }

    .job-title::after {
      display: none;
    }

    .status,
    .chip {
      padding: 2px 6px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--muted);
      font: 600 10px/1.5 var(--mono);
      letter-spacing: 0;
      text-transform: none;
      clip-path: none;
    }

    .progress {
      margin-top: 7px;
      color: var(--muted);
      font: 11px/1.45 var(--mono);
      letter-spacing: 0;
    }

    .path {
      margin-top: 5px;
      color: var(--faint);
      font: 11px/1.4 var(--mono);
      letter-spacing: 0;
    }

    .meta {
      gap: 5px;
      margin-top: 8px;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 6px;
      max-width: 360px;
      padding: 0;
      border: 0;
      background: transparent;
    }

    .actions button:disabled {
      display: none;
    }

    button.danger,
    .actions button[data-action="remove"] {
      color: var(--rose);
    }

    .remove-overlay {
      position: fixed;
      z-index: 20;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(0, 0, 0, 0.38);
    }

    .remove-dialog {
      width: min(420px, 100%);
      padding: 16px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: rgba(14, 13, 11, 0.62);
    }

    .remove-dialog h3 {
      margin: 0 0 8px;
      font-size: 15px;
    }

    .remove-dialog p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .remove-dialog-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 16px;
    }

    details {
      margin-top: 8px;
    }

    summary {
      color: var(--faint);
      font: 11px/1.3 var(--sans);
      letter-spacing: 0;
    }

    code {
      display: block;
      margin-top: 7px;
      padding: 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.28);
      color: var(--muted);
      font: 10px/1.5 var(--mono);
      overflow-wrap: anywhere;
    }

    .empty {
      min-height: 240px;
    }

    .empty-title {
      font-size: 15px;
      letter-spacing: 0;
    }

    .empty-text {
      font-size: 13px;
    }

    @media (max-width: 820px) {
      .rail {
        align-items: flex-start;
        flex-wrap: wrap;
        padding: 12px 16px;
      }
      .rail-stack {
        width: 100%;
        margin-left: 38px;
      }
      .runtime-banner {
        margin-left: auto;
      }
      .main {
        padding: 16px;
      }
      .row {
        grid-template-columns: 1fr;
      }
      .actions {
        justify-content: flex-start;
        max-width: none;
      }
    }

    @media (max-width: 520px) {
      .stats {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
      }
      .stat {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .stat:nth-child(odd) {
        border-right: 1px solid var(--line);
      }
      .stat:nth-last-child(-n + 2) {
        border-bottom: 0;
      }
      .rail-value {
        max-width: 66vw;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"></div>
        <h1>DS Video Downloader</h1>
        <p>Local helper dashboard</p>
      </div>
      <div class="rail-stack">
        <div class="rail-section">
          <div class="rail-label">Service</div>
          <div class="rail-row">
            <div class="rail-value">127.0.0.1:${PORT}</div>
          </div>
        </div>
        <div class="rail-section">
          <div class="rail-label">Downloads</div>
          <div class="rail-row">
            <div id="downloadPath" class="rail-value" title="${downloadDir}">${downloadDir}</div>
            <button id="copyPathButton" class="icon-button" type="button" title="Copy download path" aria-label="Copy download path">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 5.5H3.75A1.25 1.25 0 0 0 2.5 6.75v5.5c0 .69.56 1.25 1.25 1.25h5.5c.69 0 1.25-.56 1.25-1.25V10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.75 2.5h5.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-5.5A1.25 1.25 0 0 1 5.5 9.25v-5.5c0-.69.56-1.25 1.25-1.25Z" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="runtime-banner">ffmpeg required for stream assembly</div>
    </aside>
    <main class="main">
      <header>
        <div>
          <h2>Downloads</h2>
          <div id="summary" class="summary">Checking jobs...</div>
        </div>
        <div class="toolbar">
          <button type="button" onclick="clearMissingJobs()">Clear missing</button>
          <button id="prevJobsPageButton" type="button" onclick="prevJobsPage()">Prev</button>
          <span id="jobsPageLabel" style="align-self:center;padding:0 4px;font:11px/1 var(--mono);color:var(--muted)">Page 1</span>
          <button id="nextJobsPageButton" type="button" onclick="nextJobsPage()">Next</button>
          <button type="button" onclick="loadJobs(true)">Refresh</button>
        </div>
      </header>
      <section class="stats" aria-label="Download summary">
        <div id="activeCard" class="stat"><div class="stat-name">Active</div><div id="activeStat" class="stat-value">0</div></div>
        <div id="completedCard" class="stat"><div class="stat-name">Completed</div><div id="completedStat" class="stat-value">0</div></div>
        <div id="failedCard" class="stat"><div class="stat-name">Failed</div><div id="failedStat" class="stat-value">0</div></div>
        <div id="bytesCard" class="stat"><div class="stat-name">Downloaded</div><div id="bytesStat" class="stat-value">0 B</div></div>
      </section>
      <section id="jobs" class="panel"><div class="empty">Loading jobs...</div></section>
    </main>
  </div>
  <script>
    const JOBS_PAGE_SIZE = 50;
    let jobsPageOffset = 0;

    async function loadJobs(resetPage = false) {
      const root = document.querySelector("#jobs");
      const summary = document.querySelector("#summary");
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

        document.querySelector("#activeStat").textContent = stats.active;
        document.querySelector("#completedStat").textContent = stats.completed;
        document.querySelector("#failedStat").textContent = stats.failed;
        document.querySelector("#bytesStat").textContent = formatBytes(stats.downloadedBytes);
        setCardState("#activeCard", stats.active);
        setCardState("#completedCard", stats.completed);
        setCardState("#failedCard", stats.failed);
        setCardState("#bytesCard", stats.downloadedBytes);
        summary.textContent = stats.active + ' active, ' + total + ' total job' + (total === 1 ? '' : 's');

        const prevButton = document.querySelector("#prevJobsPageButton");
        const nextButton = document.querySelector("#nextJobsPageButton");
        if (prevButton) prevButton.disabled = jobsPageOffset === 0;
        if (nextButton) nextButton.disabled = jobsPageOffset + jobs.length >= total;
        const pageLabel = document.querySelector("#jobsPageLabel");
        if (pageLabel) pageLabel.textContent = 'Page ' + (Math.floor(jobsPageOffset / JOBS_PAGE_SIZE) + 1);

        if (!total) {
          jobsPageOffset = 0;
          root.innerHTML = '<div class="empty"><div class="empty-box"><div class="empty-title">No helper jobs yet</div><div class="empty-text">Start an HLS or DASH download from the extension popup. Jobs will appear here with progress, output path, and file actions.</div></div></div>';
          return;
        }
        root.innerHTML = '<div class="panel-head"><div>Queue</div><div class="panel-count">' + total + ' item' + (total === 1 ? '' : 's') + '</div></div>' + jobs.map(renderJob).join('');
      } catch {
        summary.textContent = 'Helper offline';
        document.querySelector("#activeStat").textContent = '0';
        document.querySelector("#completedStat").textContent = '0';
        document.querySelector("#failedStat").textContent = '0';
        document.querySelector("#bytesStat").textContent = '0 B';
        root.innerHTML = '<div class="empty failed">Could not read helper jobs.</div>';
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
      return '<article class="row">'
        + '<div class="thumb" aria-hidden="true"></div>'
        + '<div class="job-main">'
        + '<div class="title-row"><div class="job-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div><span class="status ' + escapeHtml(job.status) + '">' + humanStatus(job.status) + '</span></div>'
        + '<div class="progress">' + escapeHtml(humanJobMessage(job)) + '</div>'
        + '<div class="path" title="' + escapeHtml(output) + '">' + escapeHtml(middleTruncate(output, 72)) + '</div>'
        + '<div class="meta"><span class="chip">TOTAL ' + escapeHtml(sizeLabel(job)) + '</span><span class="chip">DOWN ' + escapeHtml(formatBytes(job.downloadedBytes || 0)) + '</span><span class="chip">START ' + escapeHtml(timeLabel(job.startedAt)) + '</span></div>'
        + '<details><summary>ffmpeg args</summary><code>' + escapeHtml((job.ffmpegArgs || []).join(' ')) + '</code></details>'
        + '</div>'
        + '<div class="actions"><button type="button" data-action="source" data-source-url="' + escapeHtml(sourceUrl) + '" ' + (sourceUrl ? '' : 'disabled') + '>Source</button><button class="warning" type="button" data-action="cancel" data-job-id="' + escapeHtml(job.id) + '" ' + (isActive ? '' : 'disabled') + '>Stop</button><button type="button" data-action="show" data-job-id="' + escapeHtml(job.id) + '" ' + (fileExists ? '' : 'disabled') + '>Open folder</button><button class="danger" type="button" data-action="remove" data-job-id="' + escapeHtml(job.id) + '" data-file-exists="' + fileExists + '" data-title="' + escapeHtml(title) + '" ' + (canForget ? '' : 'disabled') + '>Remove</button></div>'
        + '</article>';
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
    function openRemoveDialog(id, fileExists, title) {
      if (!fileExists) {
        removeJob(id, 'record');
        return;
      }
      document.querySelector('.remove-overlay')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'remove-overlay';
      overlay.innerHTML = '<div class="remove-dialog"><h3>What would you like to remove?</h3><p class="remove-name"></p><div class="remove-dialog-actions"><button type="button" data-remove-mode="file">Remove file</button><button type="button" data-remove-mode="record">Remove record</button><button class="danger" type="button" data-remove-mode="both">Remove both</button><button type="button" data-remove-mode="cancel">Cancel</button></div></div>';
      overlay.querySelector('.remove-name').textContent = title;
      overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.dataset.removeMode === 'cancel') {
          overlay.remove();
          return;
        }
        const mode = event.target.dataset.removeMode;
        if (!mode) return;
        overlay.remove();
        removeJob(id, mode);
      });
      document.body.appendChild(overlay);
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
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function humanStatus(value) {
      return ({ queued: 'Queued', running: 'Downloading', completed: 'Completed', failed: 'Failed', cancelled: 'Stopped', missing: 'File missing' })[value] || value;
    }
    function humanJobMessage(job) {
      if (job.error === 'DOWNLOAD_STALLED') return 'No data received for 2 minutes. The task was stopped.';
      if (job.error === 'HELPER_RESTARTED') return 'Download was interrupted when the helper stopped.';
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
    document.querySelector("#copyPathButton").addEventListener("click", async () => {
      await navigator.clipboard.writeText(${JSON.stringify(downloadDir)}).catch(() => {});
    });
    loadJobs();
    setInterval(loadJobs, 1000);
  </script>
</body>
</html>`;
}
