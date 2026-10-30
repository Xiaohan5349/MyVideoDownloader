import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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
// Direct files are fetched in byte-range chunks over parallel connections
// when the server answers Range requests; otherwise over one connection.
const DIRECT_CONNECTIONS = Number(process.env.DIRECT_CONNECTIONS || 4);
const DIRECT_CHUNK_BYTES = Number(process.env.DIRECT_CHUNK_BYTES || 8 * 1024 * 1024);
const DIRECT_CHUNK_RETRIES = 3;
const DIRECT_PROBE_TIMEOUT_MS = 30_000;
const jobs = new Map();
const jobProcesses = new Map();
// Direct (non-ffmpeg) downloads are stopped through their AbortController.
const jobAborts = new Map();
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
        if (job.resumable && !existsSync(resumeDataPath(job))) job.resumable = false;
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
      const result = await pickDownloadFolder(await readJson(req));
      writeJson(res, result.ok ? 200 : result.status || 400, result);
      return;
    }

    if (req.method === "GET" && new URL(req.url || "/jobs", "http://127.0.0.1").pathname === "/jobs") {
      await reconcileAllJobFiles();
      const page = parseJobsPage(req.url);
      let allJobs = Array.from(jobs.values()).reverse();
      if (page.query) allJobs = allJobs.filter((job) => jobMatchesQuery(job, page.query));
      if (page.site) allJobs = allJobs.filter((job) => jobSite(job) === page.site);
      writeJson(res, 200, {
        ok: true,
        jobs: allJobs.slice(page.offset, page.offset + page.limit).map((job) => ({ ...job, site: jobSite(job) })),
        total: allJobs.length,
        limit: page.limit,
        offset: page.offset,
        query: page.query,
        site: page.site,
        sites: buildJobSites(),
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

    if (req.method === "POST" && /^\/jobs\/[^/]+\/resume$/.test(req.url || "")) {
      const id = decodeURIComponent(req.url.split("/")[2] || "");
      const result = await resumeDirectJob(id, await readJson(req));
      writeJson(res, result.ok ? 202 : result.status || 400, result);
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
      const result = payload?.kind === "direct" ? await startDirectDownload(payload)
        : payload?.kind === "bilibili" ? await startBilibiliDownload(payload)
        : await startDownload(payload);
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

  const output = await resolveOutputPath(payload, url, "mp4");
  if (!output.ok) return output;
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    ok: true,
    status: "queued",
    url,
    sourcePageUrl: validateUrl(payload?.sourcePageUrl) || "",
    outputPath: output.outputPath,
    downloadDir: output.outputDir,
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

  const output = await resolveOutputPath(payload, url, "mp4");
  if (!output.ok) return output;
  const id = randomUUID();
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
    outputPath: output.outputPath,
    downloadDir: output.outputDir,
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

// Direct media files (mp4, webm, ...) are written by the helper itself, so
// they can land in any folder without the browser's Save As prompt.
async function startDirectDownload(payload) {
  const url = validateUrl(payload?.url);
  if (!url) return { ok: false, status: 400, error: "INVALID_URL" };

  const headers = directHeaders(payload);
  const controller = new AbortController();
  const probe = await probeDirectDownload(url, headers, controller);
  if (!probe.ok) return probe;

  // Downloading the same file again continues the stopped job (keeping its
  // original name and folder), like browser-fed streams do.
  const sourcePageUrl = validateUrl(payload?.sourcePageUrl) || "";
  const previous = probe.acceptsRanges && findResumableDirectJob(url, sourcePageUrl, probe.totalBytes);
  if (previous) return reopenDirectJob(previous, url, headers, probe, controller);

  const output = await resolveOutputPath(payload, url, directExtension(payload.extension, url));
  if (!output.ok) {
    controller.abort();
    return output;
  }

  const now = Date.now();
  const job = {
    id: randomUUID(),
    ok: true,
    inputMode: "direct",
    status: "running",
    url,
    sourcePageUrl,
    outputPath: output.outputPath,
    downloadDir: output.outputDir,
    // Ranged downloads record finished chunks so Resume skips them.
    directChunkBytes: probe.acceptsRanges ? DIRECT_CHUNK_BYTES : null,
    directChunksDone: probe.acceptsRanges ? [] : null,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    error: null,
    exitCode: null,
    progressText: "starting",
    downloadedBytes: 0,
    totalBytes: probe.totalBytes,
    totalSizeSource: probe.totalBytes ? "exact" : "unknown",
    durationSeconds: null,
    downloadedSeconds: 0,
    transferRateBytesPerSecond: 0,
    etaSeconds: null,
    lastProgressAt: null,
    lastProgressBytes: 0,
    lastActivityAt: now,
    ffmpegArgs: [],
    log: []
  };
  jobs.set(job.id, job);
  enforceJobHistoryCap();
  await persistJobsToDisk();

  runDirectDownload(job, headers, probe, controller);
  return { ok: true, job };
}

function directHeaders(payload) {
  return normalizeHeaders(payload?.headers || []).filter((header) => header.name.toLowerCase() !== "range");
}

function findResumableDirectJob(url, sourcePageUrl, totalBytes) {
  for (const job of Array.from(jobs.values()).reverse()) {
    if (!isRangedDirect(job) || !job.resumable) continue;
    if (job.status !== "failed" && job.status !== "cancelled") continue;
    if (urlPath(job.url) !== urlPath(url) || (job.sourcePageUrl || "") !== sourcePageUrl) continue;
    if (job.totalBytes === totalBytes && existsSync(resumeDataPath(job))) return job;
  }
  return null;
}

// POST /jobs/:id/resume — payload.headers: fresh request headers from the
// extension (cookies are never stored in the job file).
async function resumeDirectJob(id, payload) {
  const job = jobs.get(id);
  if (!job) return { ok: false, status: 404, error: "JOB_NOT_FOUND" };
  if (job.inputMode === "bilibili" && job.resumable && existsSync(resumeDataPath(job))) return resumeBilibiliJob(job, payload);
  if (job.inputMode !== "direct" || !job.resumable || !existsSync(resumeDataPath(job))) {
    return { ok: false, status: 409, error: "JOB_NOT_RESUMABLE" };
  }
  const headers = directHeaders(payload);
  const controller = new AbortController();
  const probe = await probeDirectDownload(job.url, headers, controller);
  if (!probe.ok) return probe;
  return reopenDirectJob(job, job.url, headers, probe, controller);
}

// Continues from the finished chunks when the server still serves the same
// size in ranges; otherwise starts the file over at the same output path.
async function reopenDirectJob(job, url, headers, probe, controller) {
  const sameFile = probe.acceptsRanges && probe.totalBytes === job.totalBytes;
  if (!sameFile) {
    job.totalBytes = probe.totalBytes;
    job.totalSizeSource = probe.totalBytes ? "exact" : "unknown";
    job.directChunkBytes = probe.acceptsRanges ? DIRECT_CHUNK_BYTES : null;
    job.directChunksDone = probe.acceptsRanges ? [] : null;
  }
  const doneBytes = sameFile ? directDoneBytes(job) : 0;

  job.url = url;
  job.status = "running";
  job.error = null;
  job.exitCode = null;
  job.finishedAt = null;
  job.resumable = false;
  job.downloadedBytes = doneBytes;
  job.lastProgressBytes = doneBytes;
  job.lastProgressAt = null;
  job.transferRateBytesPerSecond = 0;
  job.etaSeconds = null;
  job.lastActivityAt = Date.now();
  job.resumeCount = (job.resumeCount || 0) + 1;
  job.progressText = sameFile
    ? `Resuming: ${formatBytes(doneBytes)} already downloaded`
    : "File changed on the server; starting over";
  // Move to the end so job lists (newest first) show the resumed job on top.
  jobs.delete(job.id);
  jobs.set(job.id, job);
  await persistJobsNow();

  runDirectDownload(job, headers, probe, controller, { resume: sameFile });
  return { ok: true, job, resumed: sameFile };
}

function directDoneBytes(job) {
  return chunksDoneBytes(rangeTarget(job));
}

// What downloadDirectRanges works on: one file on the server. Direct jobs are
// one target; Bilibili jobs keep one per track. chunksDone is the job's own
// array, so finished chunks are recorded on the job.
function rangeTarget(job) {
  return { url: job.url, totalBytes: job.totalBytes, chunkBytes: job.directChunkBytes, chunksDone: job.directChunksDone };
}

function chunksDoneBytes(target) {
  const done = new Set(target.chunksDone || []);
  return planByteRanges(target.totalBytes, target.chunkBytes)
    .filter((chunk) => done.has(chunk.index))
    .reduce((sum, chunk) => sum + chunk.end - chunk.start + 1, 0);
}

// Asks for the first byte. A 206 with a total size means the file can be
// split into ranges; a 200 is the whole file, and its body is reused for a
// single-connection download instead of being requested again.
async function probeDirectDownload(url, headers, controller) {
  const timer = setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { ...headersToObject(headers), Range: "bytes=0-0" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: 403, error: "SERVER_PROTECTED_UNSUPPORTED" };
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: 502, error: `DIRECT_FETCH_${response.status}` };
    }
    if (/^text\/html\b/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: 422, error: "DIRECT_NOT_MEDIA" };
    }

    const total = Number(/\/(\d+)\s*$/.exec(response.headers.get("content-range") || "")?.[1]);
    if (response.status === 206) {
      await response.body?.cancel().catch(() => {});
      return total > 0
        ? { ok: true, acceptsRanges: true, totalBytes: total, response: null }
        : { ok: true, acceptsRanges: false, totalBytes: null, response: null };
    }
    const length = Number(response.headers.get("content-length"));
    return { ok: true, acceptsRanges: false, totalBytes: length > 0 ? length : null, response };
  } catch {
    return { ok: false, status: 502, error: "DIRECT_FETCH_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}

// resume: keep the .part file and fetch only the chunks not yet finished.
async function runDirectDownload(job, headers, probe, controller, { resume = false } = {}) {
  jobAborts.set(job.id, controller);
  const partPath = resumeDataPath(job);
  const progress = { bytes: job.downloadedBytes || 0, connections: probe.acceptsRanges ? DIRECT_CONNECTIONS : 1 };
  const report = () => {
    updateDownloadedBytes(job, progress.bytes);
    job.etaSeconds = job.totalBytes && job.transferRateBytesPerSecond > 0
      ? Math.max(0, job.totalBytes - job.downloadedBytes) / job.transferRateBytesPerSecond
      : null;
    const connections = progress.connections > 1 ? ` - ${progress.connections} connections` : "";
    job.progressText = `${formatProgress(job)}${connections}`;
    queuePersistJobsToDisk();
  };
  const reporter = setInterval(report, 500);
  reporter.unref?.();

  let handle = null;
  try {
    handle = await open(partPath, resume ? "r+" : "w");
    if (probe.acceptsRanges) {
      await downloadDirectRanges(rangeTarget(job), headers, handle, controller.signal, progress, resume);
    } else {
      const response = probe.response || await fetch(job.url, { headers: headersToObject(headers), signal: controller.signal });
      if (!response.ok) throw new Error(`DIRECT_HTTP_${response.status}`);
      await writeBodyAt(response.body, handle, 0, (count) => { progress.bytes += count; });
    }
    await handle.close();
    handle = null;
    if (job.status !== "running") return;
    if (job.totalBytes && progress.bytes !== job.totalBytes) throw new Error("DIRECT_INCOMPLETE");

    await rename(partPath, job.outputPath);
    report();
    job.directChunksDone = null;
    job.status = "completed";
    job.progressText = `Completed ${formatBytes(job.downloadedBytes)}`;
    job.finishedAt = new Date().toISOString();
    job.etaSeconds = null;
  } catch (error) {
    // Stop the other connections; their chunks are no longer needed.
    controller.abort();
    if (job.status === "running") {
      const code = /^DIRECT_|^SERVER_/.test(error?.message || "") ? error.message : "DIRECT_FETCH_FAILED";
      await failJob(job, code, code);
    }
  } finally {
    clearInterval(reporter);
    jobAborts.delete(job.id);
    await handle?.close().catch(() => {});
    if (job.status !== "completed" && !job.resumable) await unlink(partPath).catch(() => {});
    persistJobsToDisk();
  }
}

// Workers take chunks in order and write each one at its own offset, so no
// merge step is needed. A 403/429 means the server dislikes parallel
// requests: drop to one connection and retry the chunk where it stopped.
async function downloadDirectRanges(target, headers, handle, signal, progress, resume) {
  if (!resume) await handle.truncate(target.totalBytes);
  const done = new Set(target.chunksDone);
  const chunks = planByteRanges(target.totalBytes, target.chunkBytes).filter((chunk) => !done.has(chunk.index));
  let next = 0;

  const worker = async (index) => {
    while (next < chunks.length && index < progress.connections) {
      const chunk = chunks[next++];
      let position = chunk.start;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await fetch(target.url, {
            headers: { ...headersToObject(headers), Range: `bytes=${position}-${chunk.end}` },
            signal
          });
          if (response.status !== 206) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 403 || response.status === 429) progress.connections = 1;
            throw new Error(response.status === 200 ? "DIRECT_RANGE_IGNORED" : `DIRECT_HTTP_${response.status}`);
          }
          // position moves with every write: a body cut off midway retries
          // from the next missing byte, so no byte is fetched or counted twice.
          await writeBodyAt(response.body, handle, position, (count) => {
            position += count;
            progress.bytes += count;
          });
          if (position !== chunk.end + 1) throw new Error("DIRECT_INCOMPLETE");
          target.chunksDone.push(chunk.index);
          break;
        } catch (error) {
          if (signal.aborted || attempt >= DIRECT_CHUNK_RETRIES) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(progress.connections, chunks.length) }, (_, index) => worker(index)));
}

function planByteRanges(totalBytes, chunkBytes) {
  const chunks = [];
  for (let start = 0; start < totalBytes; start += chunkBytes) {
    chunks.push({ index: chunks.length, start, end: Math.min(start + chunkBytes, totalBytes) - 1 });
  }
  return chunks;
}

// Direct jobs downloaded in byte ranges can continue from their .part file.
function isRangedDirect(job) {
  return job?.inputMode === "direct" && Array.isArray(job.directChunksDone);
}

// Where a resumable job keeps what it has downloaded so far.
function resumeDataPath(job) {
  return job?.inputMode === "direct" ? `${job.outputPath}.part` : job?.tempDir || "";
}

async function cleanupResumeData(job) {
  if (job?.inputMode === "direct") {
    await unlink(resumeDataPath(job)).catch(() => {});
    return;
  }
  await cleanupBrowserTemp(job);
}

// Writes a response body into the file starting at `position`; returns the
// position after the last byte written.
async function writeBodyAt(body, handle, position, onBytes) {
  for await (const chunk of body) {
    await handle.write(chunk, 0, chunk.length, position);
    position += chunk.length;
    onBytes(chunk.length);
  }
  return position;
}

// --- Bilibili: a video file and an audio file, muxed by ffmpeg ---

// The extension asks Bilibili's API for the two files with the user's
// cookies; the CDN itself only checks the Referer.
const BILIBILI_HEADERS = [{ name: "Referer", value: "https://www.bilibili.com/" }];
// A batch of parts waits as "queued" instead of opening dozens of connections.
const BILIBILI_CONCURRENCY = Number(process.env.BILIBILI_CONCURRENCY || 2);

async function startBilibiliDownload(payload) {
  const tracks = bilibiliTracks(payload?.tracks);
  if (!tracks) return { ok: false, status: 400, error: "INVALID_TRACKS" };
  const sourcePageUrl = validateUrl(payload?.sourcePageUrl) || "";
  const output = await resolveOutputPath(payload, sourcePageUrl || tracks[0].url, "mp4");
  if (!output.ok) return output;

  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    ok: true,
    inputMode: "bilibili",
    status: "queued",
    url: sourcePageUrl,
    sourcePageUrl,
    // What the extension needs to ask for the same streams again on Resume.
    bilibili: bilibiliSource(payload.bilibili),
    tracks,
    outputPath: output.outputPath,
    downloadDir: output.outputDir,
    tempDir: path.join(tmpdir(), `ds-video-browser-${id}`),
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    error: null,
    exitCode: null,
    progressText: "Waiting for a free download slot",
    downloadedBytes: 0,
    totalBytes: null,
    totalSizeSource: "unknown",
    // No duration: progress would then follow ffmpeg's seconds, which stay
    // at 0 for the whole download. Bytes tell the progress instead.
    durationSeconds: null,
    // "download" while the tracks come in, "merge" while ffmpeg muxes them.
    phase: "download",
    downloadedSeconds: 0,
    transferRateBytesPerSecond: 0,
    etaSeconds: null,
    lastProgressAt: null,
    lastProgressBytes: 0,
    lastActivityAt: now,
    ffmpegArgs: [],
    log: []
  };
  // Created up front so a job still queued when the helper stops stays resumable.
  await mkdir(job.tempDir, { recursive: true });
  jobs.set(id, job);
  enforceJobHistoryCap();
  await persistJobsToDisk();
  pumpBilibiliQueue();
  return { ok: true, job };
}

// Exactly one video and one audio track. Each track is also the target
// downloadDirectRanges fills.
function bilibiliTracks(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const tracks = value.map((track) => ({
    role: track?.role, url: validateUrl(track?.url), totalBytes: null, chunkBytes: DIRECT_CHUNK_BYTES, chunksDone: []
  }));
  if (tracks.some((track) => !track.url) || tracks.map((track) => track.role).sort().join() !== "audio,video") return null;
  return ["video", "audio"].map((role) => tracks.find((track) => track.role === role));
}

function bilibiliSource(value = {}) {
  const text = (item, max = 64) => String(item ?? "").slice(0, max);
  const selection = value.selection || {};
  return {
    bvid: text(value.bvid, 16),
    // The video's title; the popup groups a video's parts under it.
    title: text(value.title, 300),
    cid: text(value.cid, 24),
    p: Number.isInteger(value.p) ? value.p : null,
    selection: Object.fromEntries(["qualityId", "videoRepresentationId", "audioRepresentationId", "videoCodec", "audioCodec"]
      .map((key) => [key, text(selection[key])]))
  };
}

function bilibiliTrackPath(job, track) {
  return path.join(job.tempDir, `${track.role}.m4s`);
}

// Starts queued jobs, oldest first, while fewer than BILIBILI_CONCURRENCY run.
function pumpBilibiliQueue() {
  const bilibiliJobs = [...jobs.values()].filter((job) => job.inputMode === "bilibili");
  let free = BILIBILI_CONCURRENCY - bilibiliJobs.filter((job) => job.status === "running").length;
  for (const job of bilibiliJobs) {
    if (free <= 0) return;
    if (job.status !== "queued") continue;
    free -= 1;
    runBilibiliDownload(job);
  }
}

// POST /jobs/:id/resume with fresh track URLs (the old ones expire after a
// few hours). Finished chunks are kept while a track keeps its size.
async function resumeBilibiliJob(job, payload) {
  const tracks = bilibiliTracks(payload?.tracks);
  if (!tracks) return { ok: false, status: 400, error: "INVALID_TRACKS" };
  for (const track of job.tracks) track.url = tracks.find((fresh) => fresh.role === track.role).url;
  job.status = "queued";
  job.error = null;
  job.exitCode = null;
  job.finishedAt = null;
  job.resumable = false;
  job.etaSeconds = null;
  job.transferRateBytesPerSecond = 0;
  job.lastProgressAt = null;
  job.lastActivityAt = Date.now();
  job.resumeCount = (job.resumeCount || 0) + 1;
  job.progressText = "Waiting for a free download slot";
  jobs.delete(job.id);
  jobs.set(job.id, job);
  await persistJobsNow();
  pumpBilibiliQueue();
  return { ok: true, job, resumed: true };
}

async function runBilibiliDownload(job) {
  // Set before the first await, so pumpBilibiliQueue counts this job at once.
  job.status = "running";
  job.phase = "download";
  // Jobs from before durations were dropped.
  job.durationSeconds = null;
  job.downloadedSeconds = 0;
  job.lastActivityAt = Date.now();
  const controller = new AbortController();
  jobAborts.set(job.id, controller);
  const progress = { bytes: 0, connections: DIRECT_CONNECTIONS };
  const report = () => {
    updateDownloadedBytes(job, progress.bytes);
    job.etaSeconds = job.totalBytes && job.transferRateBytesPerSecond > 0
      ? Math.max(0, job.totalBytes - job.downloadedBytes) / job.transferRateBytesPerSecond
      : null;
    job.progressText = formatProgress(job);
    queuePersistJobsToDisk();
  };
  let reporter = null;

  try {
    // Sizes first, so the job shows its total from the start. A track whose
    // size changed, or whose file is gone, starts over.
    for (const track of job.tracks) {
      const probe = await probeDirectDownload(track.url, BILIBILI_HEADERS, controller);
      if (!probe.ok) throw new Error(probe.error);
      await probe.response?.body?.cancel().catch(() => {});
      if (!probe.acceptsRanges) throw new Error("DIRECT_RANGE_IGNORED");
      if (probe.totalBytes !== track.totalBytes || !existsSync(bilibiliTrackPath(job, track))) {
        track.totalBytes = probe.totalBytes;
        track.chunksDone = [];
      }
    }
    job.totalBytes = job.tracks.reduce((sum, track) => sum + track.totalBytes, 0);
    job.totalSizeSource = "exact";
    progress.bytes = job.tracks.reduce((sum, track) => sum + chunksDoneBytes(track), 0);
    job.downloadedBytes = progress.bytes;
    job.lastProgressBytes = progress.bytes;
    reporter = setInterval(report, 500);
    reporter.unref?.();

    await mkdir(job.tempDir, { recursive: true });
    for (const track of job.tracks) {
      const resume = track.chunksDone.length > 0;
      const handle = await open(bilibiliTrackPath(job, track), resume ? "r+" : "w");
      try {
        await downloadDirectRanges(track, BILIBILI_HEADERS, handle, controller.signal, progress, resume);
      } finally {
        await handle.close();
      }
    }
    clearInterval(reporter);
    report();
    if (job.status !== "running") return;
    if (progress.bytes !== job.totalBytes) throw new Error("DIRECT_INCOMPLETE");
    job.phase = "merge";
    job.progressText = "Muxing video and audio";
    runFfmpeg(job, []);
  } catch (error) {
    controller.abort();
    if (job.status === "running") {
      const code = /^DIRECT_|^SERVER_/.test(error?.message || "") ? error.message : "DIRECT_FETCH_FAILED";
      await failJob(job, code, code);
    }
  } finally {
    clearInterval(reporter);
    jobAborts.delete(job.id);
    persistJobsToDisk();
    // Still running means ffmpeg took over; it frees the slot when it exits.
    if (job.status !== "running") pumpBilibiliQueue();
  }
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
  job.resumable = (job.inputMode === "browser" && isResumableBrowserError(error)) || isRangedDirect(job) || job.inputMode === "bilibili";
  job.progressText = progressText;
  if (!job.resumable) await cleanupResumeData(job);
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
  const isLocal = job.inputMode === "browser" || job.inputMode === "bilibili";
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

  if (job.inputMode === "bilibili") {
    // Two plain mp4 files; the playlist flags below would be unknown options.
    const [video, audio] = job.tracks;
    args.push("-i", bilibiliTrackPath(job, video), "-i", bilibiliTrackPath(job, audio));
    args.push("-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", job.outputPath);
  } else {
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
  }
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
    if (job.inputMode === "bilibili") pumpBilibiliQueue();
  });

  child.on("close", (code) => {
    jobProcesses.delete(job.id);
    // Deferred: the job only stops counting as running further down.
    if (job.inputMode === "bilibili") setImmediate(pumpBilibiliQueue);
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

// payload.initialDir: folder the picker opens in (default: the saved one).
// payload.persist === false: return the choice without saving it as the
// default, for a folder picked in the download dialog.
async function pickDownloadFolder(payload = {}) {
  if (process.platform !== "win32") return { ok: false, status: 501, error: "FOLDER_PICKER_UNSUPPORTED" };

  const initialDir = normalizeDownloadDir(payload.initialDir) || downloadDir;
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
    resultPath,
    "-InitialDir",
    initialDir
  ], { windowsHide: true });
  const selectedPath = await readFile(resultPath, "utf8").catch(() => "");
  await unlink(resultPath).catch(() => {});
  if (result.code !== 0 && !selectedPath.trim()) {
    return result.code === -1
      ? { ok: false, status: 500, error: `FOLDER_PICK_FAILED${result.stderr ? `: ${result.stderr.trim()}` : ""}` }
      : { ok: false, status: 400, error: "FOLDER_PICK_CANCELLED" };
  }
  if (!selectedPath.trim()) return { ok: false, status: 500, error: `FOLDER_PICK_FAILED${result.stderr ? `: ${result.stderr.trim()}` : ""}` };
  if (payload.persist === false) return { ok: true, settings: { downloadDir: normalizeDownloadDir(selectedPath) } };
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

  await cleanupResumeData(job);
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
    const query = String(parsed.searchParams.get("q") ?? "").trim().slice(0, 200);
    const site = String(parsed.searchParams.get("site") ?? "").trim().toLowerCase().slice(0, 200);
    return { limit, offset, query, site };
  } catch {
    return { limit: JOBS_PAGE_SIZE_DEFAULT, offset: 0, query: "", site: "" };
  }
}

// The site a job came from: its source page's host without "www."/"www53.",
// so mirrors of one site group together. "" when the page is unknown.
function jobSite(job) {
  try {
    return new URL(job.sourcePageUrl).hostname.toLowerCase().replace(/^www\d*\./, "");
  } catch {
    return "";
  }
}

// Every site in the whole history with its job count, most jobs first; the
// popup's site filter lists these.
function buildJobSites() {
  const counts = new Map();
  for (const job of jobs.values()) {
    const site = jobSite(job);
    if (site) counts.set(site, (counts.get(site) || 0) + 1);
  }
  return [...counts]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
}

// Popup search box: every word of `query` (already trimmed, never empty) must
// appear, ignoring case, in the output path (folder + file name). Only what
// the popup shows (and highlights) is searched: stream and page URLs carry
// random IDs that match short words for no visible reason.
function jobMatchesQuery(job, query) {
  const haystack = String(job.outputPath || "").toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

function buildJobStats() {
  // resumable: what the popup's "Resume all" would continue.
  const stats = { active: 0, completed: 0, failed: 0, resumable: 0, downloadedBytes: 0 };
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") stats.active += 1;
    if (job.resumable) stats.resumable += 1;
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
      await cleanupResumeData(job);
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
  jobAborts.get(id)?.abort();
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
  // Stop works as pause for browser-fed and ranged direct jobs: keep what was
  // downloaded so Resume (or downloading the same video again) continues.
  job.resumable = job.inputMode === "browser" || job.inputMode === "bilibili" || isRangedDirect(job);
  job.progressText = "Stopped by user";
  job.finishedAt = new Date().toISOString();
  job.etaSeconds = null;
  if (!job.resumable) await cleanupResumeData(job);
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

function buildFilename(title, url, extension = "mp4") {
  const cleanTitle = String(title || "video")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "video";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${cleanTitle}-${hash}.${extension}`;
}

// A name typed in the download dialog: used as given (no hash suffix), made
// safe for Windows, and always ends in the extension the output really has.
function buildCustomFilename(name, extension) {
  let base = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (base.toLowerCase().endsWith(`.${extension}`)) base = base.slice(0, -extension.length - 1);
  base = base.replace(/[. ]+$/, "").slice(0, 120) || "video";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`;
  return `${base}.${extension}`;
}

function directExtension(value, url) {
  const fromPayload = String(value || "").replace(/^\./, "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromPayload)) return fromPayload;
  const fromUrl = /\.([a-z0-9]{1,8})$/i.exec(urlPath(url))?.[1]?.toLowerCase();
  return fromUrl || "mp4";
}

// The download dialog can name the file and choose a folder for this one
// download. The saved download folder stays the default and is not changed.
async function resolveOutputPath(payload, url, extension) {
  let outputDir = downloadDir;
  if (payload?.downloadDir) {
    const requested = String(payload.downloadDir).trim().replace(/^"|"$/g, "");
    if (!path.isAbsolute(requested)) return { ok: false, status: 400, error: "INVALID_DOWNLOAD_DIR" };
    outputDir = normalizeDownloadDir(requested);
    if (!outputDir) return { ok: false, status: 400, error: "INVALID_DOWNLOAD_DIR" };
  }
  try {
    await mkdir(outputDir, { recursive: true });
  } catch {
    return { ok: false, status: 400, error: "DOWNLOAD_DIR_UNAVAILABLE" };
  }
  const filename = String(payload?.filename || "").trim()
    ? buildCustomFilename(payload.filename, extension)
    : buildFilename(payload?.title || "video", url, extension);
  return { ok: true, outputDir, outputPath: await uniqueOutputPath(path.join(outputDir, filename)) };
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

// "/" is a plain status page: the job list lives in the extension popup
// (the full dashboard was removed in v1.12.0).
function renderHomePage() {
  const safeDir = escapeHtmlText(downloadDir);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>DS Video Downloader helper</title></head>
<body style="font-family:system-ui,sans-serif;margin:2rem">
  <h1>DS Video Downloader helper is running</h1>
  <p>Listening on 127.0.0.1:${PORT}. Downloads go to <code>${safeDir}</code>.</p>
  <p>Open the extension popup to see and manage downloads.</p>
</body>
</html>`;
}
