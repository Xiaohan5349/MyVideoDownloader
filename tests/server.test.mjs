import { describe, before, after, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set env vars BEFORE dynamic import so server.js skips auto-listen
process.env.NODE_ENV = "test";
process.env.PORT = "0"; // Random port
process.env.DOWNLOAD_DIR = path.join(__dirname, "..", "helper", "test-downloads");
process.env.CONFIG_PATH = path.join(process.env.DOWNLOAD_DIR, "helper-settings.json");
process.env.JOBS_PATH = path.join(process.env.DOWNLOAD_DIR, "helper-jobs.json");
// Small chunks so a few KB of test data spreads over several range requests.
process.env.DIRECT_CHUNK_BYTES = "1000";

// Dynamic import to get server reference
const serverPath = pathToFileURL(path.join(__dirname, "..", "helper", "server.js")).href;
const serverModule = await import(serverPath);
const { server, jobs, isSafeDownloadPath, sweepStalledJobs, enforceJobHistoryCap } = serverModule;

let baseUrl;

describe("server.js HTTP API", () => {
  before(async () => {
    await mkdir(process.env.DOWNLOAD_DIR, { recursive: true });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    // Browser-fed jobs stage segments under the OS temp dir, not DOWNLOAD_DIR.
    for (const job of jobs.values()) {
      if (job.tempDir && path.basename(job.tempDir).startsWith("ds-video-browser-")) {
        await rm(job.tempDir, { recursive: true, force: true });
      }
    }
    await rm(process.env.DOWNLOAD_DIR, { recursive: true, force: true });
  });

// Helper to make HTTP requests
function fetchJson(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ─── Health & Status ───

it("GET /health returns ok with ffmpeg and downloadDir", async () => {
  const res = await fetchJson("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ffmpeg, "required");
  assert.ok(typeof res.body.downloadDir === "string");
});

it("GET /settings returns downloadDir", async () => {
  const res = await fetchJson("/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(typeof res.body.settings.downloadDir === "string");
});

it("GET /jobs returns empty array initially", async () => {
  const res = await fetchJson("/jobs");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.jobs));
});

it("GET / returns HTML dashboard", async () => {
  const res = await fetchJson("/");
  assert.equal(res.status, 200);
  assert.ok(typeof res.body === "string" && res.body.includes("<!doctype html>"));
  // Must work offline: no external stylesheets, fonts, scripts or images.
  assert.doesNotMatch(res.body, /<(link|script|img)[^>]+(href|src)="https?:/i);
  assert.doesNotMatch(res.body, /url\(\s*["']?https?:/i);
  assert.match(res.body, /Open folder/);
  assert.match(res.body, /Remove file/);
  assert.match(res.body, /Remove record/);
  assert.match(res.body, /data-action="remove"/);
  assert.doesNotMatch(res.body, /data-action="delete"/);
  assert.doesNotMatch(res.body, /data-action="forget"/);
});

it("GET /assets/app-background.webp returns the dashboard background", async () => {
  const res = await fetchJson("/assets/app-background.webp");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.ok(typeof res.body === "string" && res.body.length > 100);
});

it("POST /inspect probes direct file size without downloading the body", async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.method, "HEAD");
    assert.equal(req.headers.range, undefined);
    res.writeHead(200, { "Content-Length": "7654321", "Content-Type": "video/mp4" });
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  try {
    const res = await fetchJson("/inspect", {
      method: "POST",
      body: {
        url: `http://127.0.0.1:${address.port}/video.mp4`,
        kind: "direct",
        headers: [{ name: "Range", value: "bytes=100-200" }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalBytes, 7654321);
    assert.equal(res.body.totalSizeSource, "exact");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("POST /inspect falls back to a byte range when HEAD has no usable size", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    assert.equal(req.method, "GET");
    assert.equal(req.headers.range, "bytes=0-0");
    res.writeHead(206, {
      "Content-Length": "1",
      "Content-Range": "bytes 0-0/9876543",
      "Content-Type": "video/mp4"
    });
    res.end("x");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  try {
    const res = await fetchJson("/inspect", {
      method: "POST",
      body: {
        url: `http://127.0.0.1:${address.port}/video.mp4`,
        kind: "direct",
        headers: []
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalBytes, 9876543);
    assert.equal(res.body.totalSizeSource, "exact");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("POST /inspect does not treat a partial response length as the full direct size", async () => {
  const upstream = http.createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(206, { "Content-Length": "1", "Content-Type": "video/mp4" });
    res.end("x");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  try {
    const res = await fetchJson("/inspect", {
      method: "POST",
      body: {
        url: `http://127.0.0.1:${address.port}/video.mp4`,
        kind: "direct",
        headers: []
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalBytes, null);
    assert.equal(res.body.totalSizeSource, "unknown");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("POST /inspect rejects an HTML login page as a direct media size", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "4321", "Content-Type": "text/html; charset=utf-8" });
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  try {
    const res = await fetchJson("/inspect", {
      method: "POST",
      body: { url: `http://127.0.0.1:${address.port}/login`, kind: "direct", headers: [] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalBytes, null);
    assert.equal(res.body.totalSizeSource, "unknown");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

// ─── Error Handling ───

it("POST /probe-quality rejects a non-http URL", async () => {
  const res = await fetchJson("/probe-quality", { method: "POST", body: { url: "file:///etc/passwd" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_URL");
});

it("POST /probe-quality answers with an empty quality when the stream cannot be read", async () => {
  const res = await fetchJson("/probe-quality", { method: "POST", body: { url: "http://127.0.0.1:1/missing.mp4", kind: "direct" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, width: null, height: null, quality: "" });
});

it("POST /download with missing URL returns 400", async () => {
  const res = await fetchJson("/download", { method: "POST", body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_URL");
});

it("POST /download with invalid URL returns 400", async () => {
  const res = await fetchJson("/download", { method: "POST", body: { url: "not-a-url" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_URL");
});

it("POST /download with ftp URL returns 400", async () => {
  const res = await fetchJson("/download", { method: "POST", body: { url: "ftp://example.com/video.mp4" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_URL");
});

it("POST /download from a web origin is rejected (CSRF guard)", async () => {
  const res = await fetchJson("/download", {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body: { url: "http://example.com/video.m3u8", title: "CSRF", kind: "hls" },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "ORIGIN_NOT_ALLOWED");
});

it("GET /auth returns a token for local callers", async () => {
  const res = await fetchJson("/auth");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(typeof res.body.token === "string" && res.body.token.length > 0);
});

it("GET /auth is denied for web origins", async () => {
  const res = await fetchJson("/auth", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "ORIGIN_NOT_ALLOWED");
});

it("POST /browser-downloads/start from a web origin works when the content-script token is supplied", async () => {
  const auth = await fetchJson("/auth");
  const token = auth.body.token;

  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    headers: { Origin: "https://site.example", "X-DS-Token": token },
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Browser Fed Video",
      totalSegments: 1,
      sourcePageUrl: "https://site.example/watch/video"
    },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.job.inputMode, "browser");
});

it("POST /browser-downloads/start from a web origin is rejected without the token", async () => {
  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    headers: { Origin: "https://site.example" },
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Browser Fed Video",
      totalSegments: 1,
      sourcePageUrl: "https://site.example/watch/video"
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "ORIGIN_NOT_ALLOWED");
});

it("GET /jobs/nonexistent returns 404", async () => {
  const res = await fetchJson("/jobs/nonexistent-id");
  assert.equal(res.status, 404);
});

it("POST /jobs/nonexistent/cancel returns 404", async () => {
  const res = await fetchJson("/jobs/nonexistent-id/cancel", { method: "POST" });
  assert.equal(res.status, 404);
});

it("DELETE /jobs/nonexistent returns 404", async () => {
  const res = await fetchJson("/jobs/nonexistent-id", { method: "DELETE" });
  assert.equal(res.status, 404);
});

it("GET /nonexistent-route returns 404", async () => {
  const res = await fetchJson("/nonexistent");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "NOT_FOUND");
});

it("OPTIONS returns 204 with CORS headers", async () => {
  const res = await fetchJson("/download", { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

// ─── Download Validation ───

it("POST /download with http URL returns 202 (ffmpeg spawn attempt)", async () => {
  // This will try to spawn ffmpeg which may or may not be available,
  // but the URL validation and job creation should succeed to 202
  const res = await fetchJson("/download", {
    method: "POST",
    body: { url: "http://example.com/video.m3u8", title: "Test Video", kind: "hls" },
  });
  // 202 means job queued, anything else means ffmpeg or fetch failed
  // Either is valid behavior depending on environment
  assert.ok(res.status === 202 || res.status >= 400,
    `Expected 202 or 4xx/5xx, got ${res.status}`);
});

it("POST /browser-downloads/start creates a browser-fed helper job", async () => {
  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Browser Fed Video",
      durationSeconds: 10,
      totalSegments: 2,
      totalBytes: 2048,
      totalSizeSource: "estimated",
      sourcePageUrl: "https://site.example/watch/video"
    },
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job.status, "running");
  assert.equal(res.body.job.inputMode, "browser");
  assert.equal(res.body.job.totalSegments, 2);
  assert.equal(res.body.job.sourcePageUrl, "https://site.example/watch/video");
});

it("marks a running job failed when downloaded bytes stop advancing", async () => {
  const id = "stalled-job";
  jobs.set(id, {
    id,
    status: "running",
    outputPath: path.join(process.env.DOWNLOAD_DIR, "stalled.mp4"),
    downloadDir: process.env.DOWNLOAD_DIR,
    downloadedBytes: 1024,
    lastByteProgressAt: 1,
    progressText: "Downloading"
  });

  await sweepStalledJobs(20_001, 10_000);

  assert.equal(jobs.get(id).status, "failed");
  assert.equal(jobs.get(id).error, "DOWNLOAD_STALLED");
});

it("GET /jobs supports limit, offset, total, and global stats", async () => {
  const page1 = await fetchJson("/jobs?limit=2&offset=0");
  assert.equal(page1.status, 200);
  assert.equal(page1.body.limit, 2);
  assert.equal(page1.body.offset, 0);
  assert.equal(page1.body.total, jobs.size);
  assert.ok(page1.body.jobs.length <= 2);
  assert.equal(typeof page1.body.stats.active, "number");
  assert.equal(typeof page1.body.stats.downloadedBytes, "number");

  const page2 = await fetchJson("/jobs?limit=2&offset=2");
  assert.equal(page2.status, 200);
  assert.equal(page2.body.offset, 2);
});

it("enforceJobHistoryCap drops only old missing records above the cap", async () => {
  const addedIds = [];
  const existingCount = jobs.size;
  const toAdd = 5005 - existingCount;
  for (let index = 0; index < toAdd; index += 1) {
    const id = `cap-test-${index}`;
    jobs.set(id, {
      id,
      status: index % 2 === 0 ? "missing" : "completed",
      startedAt: new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString(),
      outputPath: "/tmp/cap-test.mp4",
      downloadDir: process.env.DOWNLOAD_DIR
    });
    addedIds.push(id);
  }

  const removed = enforceJobHistoryCap();
  assert.ok(jobs.size <= 5000);
  assert.ok(removed > 0);
  for (const id of addedIds) {
    if (jobs.get(id)?.status === "completed") {
      assert.ok(jobs.has(id), `completed record ${id} should survive the cap`);
    }
    jobs.delete(id);
  }
});

it("GET /jobs marks completed history missing after its output is removed", async () => {
  const id = "externally-deleted-job";
  const outputPath = path.join(process.env.DOWNLOAD_DIR, "deleted-outside-helper.mp4");
  await writeFile(outputPath, Buffer.from([1, 2, 3]));
  jobs.set(id, {
    id,
    status: "completed",
    outputPath,
    downloadDir: process.env.DOWNLOAD_DIR,
    sourcePageUrl: "https://site.example/watch/again",
    downloadedBytes: 3,
    progressText: "Completed 3 B"
  });

  let res = await fetchJson("/jobs");
  let job = res.body.jobs.find((item) => item.id === id);
  assert.equal(job.status, "completed");
  assert.equal(job.fileExists, true);

  await rm(outputPath);
  res = await fetchJson("/jobs");
  job = res.body.jobs.find((item) => item.id === id);
  assert.equal(job.status, "missing");
  assert.equal(job.fileExists, false);
  assert.equal(job.sourcePageUrl, "https://site.example/watch/again");
});

it("DELETE /jobs/:id removes output but preserves source history", async () => {
  const id = "delete-and-keep-history";
  const outputPath = path.join(process.env.DOWNLOAD_DIR, "delete-through-helper.mp4");
  await writeFile(outputPath, Buffer.from([1, 2, 3]));
  jobs.set(id, {
    id,
    status: "completed",
    outputPath,
    downloadDir: process.env.DOWNLOAD_DIR,
    sourcePageUrl: "https://site.example/watch/later",
    downloadedBytes: 3
  });

  const deleted = await fetchJson(`/jobs/${id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.job.status, "missing");
  assert.equal(deleted.body.job.sourcePageUrl, "https://site.example/watch/later");

  const fetched = await fetchJson(`/jobs/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.status, "missing");
  assert.equal(fetched.body.fileExists, false);
});

it("POST /jobs/clear-missing removes only file-missing records", async () => {
  const missingBefore = Array.from(jobs.values()).filter((job) => job.status === "missing").length;
  const missingId = "clear-missing-a";
  const completedId = "clear-missing-completed";
  jobs.set(missingId, { id: missingId, status: "missing", outputPath: "/tmp/does-not-exist.mp4", downloadDir: process.env.DOWNLOAD_DIR });
  jobs.set(completedId, { id: completedId, status: "completed", outputPath: "/tmp/keep.mp4", downloadDir: process.env.DOWNLOAD_DIR });

  const res = await fetchJson("/jobs/clear-missing", { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.removedCount, missingBefore + 1);
  assert.equal(jobs.has(missingId), false);
  assert.equal(jobs.has(completedId), true);
});

it("DELETE /jobs/:id/history removes every non-active record without deleting output", async () => {
  for (const status of ["failed", "missing", "cancelled", "completed"]) {
    const id = `forget-${status}`;
    const outputPath = path.join(process.env.DOWNLOAD_DIR, `${id}.mp4`);
    if (status === "completed") await writeFile(outputPath, "completed media");
    jobs.set(id, {
      id,
      status,
      outputPath,
      downloadDir: process.env.DOWNLOAD_DIR,
      sourcePageUrl: "https://site.example/watch/history"
    });

    const removed = await fetchJson(`/jobs/${id}/history`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.ok, true);
    assert.equal(jobs.has(id), false);
    if (status === "completed") {
      const output = await readFile(outputPath, "utf8");
      assert.equal(output, "completed media");
    }
  }

  for (const status of ["queued", "running"]) {
    const id = `keep-${status}-history`;
    jobs.set(id, { id, status });
    const rejected = await fetchJson(`/jobs/${id}/history`, { method: "DELETE" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, "JOB_HISTORY_NOT_REMOVABLE");
    assert.equal(jobs.has(id), true);
  }
});

it("cancel persists completed state fields before returning", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: { url: "https://cdn.example.com/video.m3u8", title: "Cancel Persist", totalSegments: 1 },
  });
  const jobId = start.body.job.id;
  jobs.get(jobId).etaSeconds = 123;

  const cancel = await fetchJson(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);

  const persisted = JSON.parse(await readFile(process.env.JOBS_PATH, "utf8"));
  const saved = persisted.find((job) => job.id === jobId);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.etaSeconds, null);
  assert.ok(saved.finishedAt);
});

it("POST /browser-downloads/start rejects fractional totalSegments", async () => {
  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Fractional",
      totalSegments: 1.5,
      totalBytes: 4,
      totalSizeSource: "exact"
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_TOTAL_SEGMENTS");
});

it("authenticated job polling acts as a browser-download heartbeat", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: { url: "https://cdn.example.com/video.m3u8", title: "Heartbeat", totalSegments: 1 },
  });
  const jobId = start.body.job.id;
  const job = jobs.get(jobId);
  job.lastActivityAt = 1;

  const auth = await fetchJson("/auth");
  const res = await fetchJson(`/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Origin: "https://site.example", "X-DS-Token": auth.body.token },
  });
  assert.equal(res.status, 200);
  assert.ok(jobs.get(jobId).lastActivityAt > Date.now() - 5000);
});

it("POST /browser-downloads/:id/files/:name stores segment bytes", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Segment Upload",
      totalSegments: 1,
      totalBytes: 4,
      totalSizeSource: "exact"
    },
  });
  const jobId = start.body.job.id;

  const upload = await new Promise((resolve, reject) => {
    const url = new URL(`/browser-downloads/${encodeURIComponent(jobId)}/files/seg-000000.ts`, baseUrl);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: JSON.parse(body) });
      });
    });
    req.on("error", reject);
    req.write(Buffer.from([1, 2, 3, 4]));
    req.end();
  });

  assert.equal(upload.status, 200);
  assert.equal(upload.body.ok, true);
  assert.equal(upload.body.job.downloadedBytes, 4);
  assert.equal(upload.body.job.receivedSegments, 1);
});

it("duplicate segment upload is idempotent and does not double-count", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Duplicate Upload",
      totalSegments: 1,
      totalBytes: 4,
      totalSizeSource: "exact"
    },
  });
  const jobId = start.body.job.id;
  const payload = Buffer.from([1, 2, 3, 4]);

  async function uploadSegment() {
    return new Promise((resolve, reject) => {
      const url = new URL(`/browser-downloads/${encodeURIComponent(jobId)}/files/seg-000000.ts`, baseUrl);
      const req = http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  const first = await uploadSegment();
  const second = await uploadSegment();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const job = jobs.get(jobId);
  assert.equal(job.receivedSegments, 1);
  assert.equal(job.downloadedBytes, payload.length);
});

it("POST /browser-downloads/:id/complete rejects incomplete segment uploads", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Incomplete Upload",
      totalSegments: 2,
      totalBytes: 4,
      totalSizeSource: "exact"
    },
  });
  const jobId = start.body.job.id;

  const complete = await fetchJson(`/browser-downloads/${encodeURIComponent(jobId)}/complete`, {
    method: "POST",
    body: { playlistText: "#EXTM3U\n#EXTINF:1.0,\nseg-000000.ts\n#EXT-X-ENDLIST\n" },
  });

  assert.equal(complete.status, 409);
  assert.equal(complete.body.error, "SEGMENTS_INCOMPLETE");
  const job = jobs.get(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "SEGMENTS_INCOMPLETE");
});

it("POST /browser-downloads/:id/files rejects unsafe filenames", async () => {
  const start = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/video.m3u8",
      title: "Unsafe Segment Upload",
      totalSegments: 1
    },
  });
  const jobId = start.body.job.id;
  const res = await fetchJson(`/browser-downloads/${encodeURIComponent(jobId)}/files/..%2Fevil.ts`, {
    method: "POST",
    body: { ignored: true },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_FILE_NAME");
});

// ─── Settings ───

it("POST /settings with invalid dir returns 400", async () => {
  const res = await fetchJson("/settings", { method: "POST", body: { downloadDir: "" } });
  assert.equal(res.status, 400);
});

it("POST /settings with valid dir returns 200", async () => {
  const tmpDir = path.join(__dirname, "..", "helper", "test-downloads");
  const res = await fetchJson("/settings", { method: "POST", body: { downloadDir: tmpDir } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.settings.downloadDir.includes("test-downloads"));
});

// ─── Pick Folder ───
// Skipped: /pick-folder spawns a GUI dialog on Windows which cannot run in CI.
// The endpoint is tested manually. Non-Windows platforms correctly return 501.

// ─── isSafeDownloadPath ───

it("isSafeDownloadPath: valid path within download dir returns true", () => {
  const baseDir = process.platform === "win32" ? "C:\\Users\\test\\Downloads" : "/home/test/Downloads";
  assert.equal(isSafeDownloadPath(path.join(baseDir, "video.mp4"), baseDir), true);
  assert.equal(isSafeDownloadPath(path.join(baseDir, "sub", "video.mp4"), baseDir), true);
});

it("isSafeDownloadPath: path outside download dir returns false", () => {
  const baseDir = process.platform === "win32" ? "C:\\Users\\test\\Downloads" : "/home/test/Downloads";
  const outside = process.platform === "win32" ? "C:\\Users\\test\\Documents\\video.mp4" : "/home/test/Documents/video.mp4";
  const siblingWithSamePrefix = `${baseDir}-backup${path.sep}video.mp4`;
  assert.equal(isSafeDownloadPath(outside, baseDir), false);
  assert.equal(isSafeDownloadPath(siblingWithSamePrefix, baseDir), false);
});

it("isSafeDownloadPath: falsy value returns false", () => {
  assert.equal(isSafeDownloadPath("", "/tmp"), false);
  assert.equal(isSafeDownloadPath(null, "/tmp"), false);
});

it("isSafeDownloadPath: case-different path is outside on case-sensitive filesystems", () => {
  if (process.platform === "win32") return;
  assert.equal(isSafeDownloadPath("/tmp/ABC/video.mp4", "/tmp/abc"), false);
});

// ─── Resumable browser downloads ───

function startBrowserJob(body) {
  return fetchJson("/browser-downloads/start", { method: "POST", body });
}

function uploadSegment(jobId, name, bytes = [0x47, 1, 2, 3]) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/browser-downloads/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`, baseUrl);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(Buffer.from(bytes));
    req.end();
  });
}

it("a stalled browser job keeps its segments and becomes resumable", async () => {
  const start = await startBrowserJob({
    url: "https://cdn.example.com/resume/stall.m3u8",
    title: "Resume Stall",
    totalSegments: 3,
    sourcePageUrl: "https://site.example/watch/stall"
  });
  const id = start.body.job.id;
  await uploadSegment(id, "seg-000000.ts");
  jobs.get(id).lastActivityAt = 1;

  await sweepStalledJobs(10 * 60_000 + 2, 1);

  const job = jobs.get(id);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "DOWNLOAD_STALLED");
  assert.equal(job.resumable, true);
  assert.ok(existsSync(path.join(job.tempDir, "seg-000000.ts")));
});

it("starting the same stream again resumes the failed job and lists received files", async () => {
  const body = {
    url: "https://cdn.example.com/resume/same.m3u8",
    title: "Resume Same",
    totalSegments: 3,
    durationSeconds: 30,
    sourcePageUrl: "https://site.example/watch/same"
  };
  const first = await startBrowserJob(body);
  const id = first.body.job.id;
  assert.equal(first.body.resumed, false);
  assert.deepEqual(first.body.receivedFiles, []);
  await uploadSegment(id, "seg-000000.ts");
  await uploadSegment(id, "seg-000001.ts");
  await fetchJson(`/browser-downloads/${encodeURIComponent(id)}/fail`, {
    method: "POST",
    body: { error: "SEGMENT_DOWNLOAD_FAILED: 1/3" }
  });
  assert.equal(jobs.get(id).resumable, true);

  const second = await startBrowserJob(body);

  assert.equal(second.status, 202);
  assert.equal(second.body.resumed, true);
  assert.equal(second.body.job.id, id);
  assert.equal(second.body.job.status, "running");
  assert.equal(second.body.job.error, null);
  assert.equal(second.body.job.resumable, false);
  assert.equal(second.body.job.receivedSegments, 2);
  assert.deepEqual(second.body.receivedFiles.sort(), ["seg-000000.ts", "seg-000001.ts"]);
});

it("a stream with a different segment count does not resume an old job", async () => {
  const body = {
    url: "https://cdn.example.com/resume/count.m3u8",
    title: "Resume Count",
    totalSegments: 3,
    sourcePageUrl: "https://site.example/watch/count"
  };
  const first = await startBrowserJob(body);
  await fetchJson(`/browser-downloads/${encodeURIComponent(first.body.job.id)}/fail`, {
    method: "POST",
    body: { error: "SOURCE_PAGE_CLOSED" }
  });

  const second = await startBrowserJob({ ...body, totalSegments: 4 });

  assert.equal(second.body.resumed, false);
  assert.notEqual(second.body.job.id, first.body.job.id);
});

async function failedBrowserJob(body) {
  const start = await startBrowserJob(body);
  await fetchJson(`/browser-downloads/${encodeURIComponent(start.body.job.id)}/fail`, {
    method: "POST",
    body: { error: "SOURCE_PAGE_CLOSED" }
  });
  return start.body.job.id;
}

it("a refreshed CDN token in the manifest query still resumes", async () => {
  const body = {
    url: "https://cdn.example.com/resume/token.m3u8?token=old&expires=1",
    title: "Resume Token",
    totalSegments: 3,
    durationSeconds: 30,
    sourcePageUrl: "https://site.example/watch?v=token"
  };
  const id = await failedBrowserJob(body);

  const second = await startBrowserJob({ ...body, url: "https://cdn.example.com/resume/token.m3u8?token=new&expires=2" });

  assert.equal(second.body.resumed, true);
  assert.equal(second.body.job.id, id);
  assert.equal(second.body.job.url, "https://cdn.example.com/resume/token.m3u8?token=new&expires=2");
});

it("a different source page does not resume an old job", async () => {
  const body = {
    url: "https://cdn.example.com/resume/page.m3u8",
    title: "Resume Page",
    totalSegments: 3,
    sourcePageUrl: "https://site.example/watch?v=one"
  };
  const id = await failedBrowserJob(body);

  const second = await startBrowserJob({ ...body, sourcePageUrl: "https://site.example/watch?v=two" });

  assert.equal(second.body.resumed, false);
  assert.notEqual(second.body.job.id, id);
});

it("a different duration does not resume an old job, but a sub-second drift does", async () => {
  const body = {
    url: "https://cdn.example.com/resume/duration.m3u8",
    title: "Resume Duration",
    totalSegments: 3,
    durationSeconds: 30,
    sourcePageUrl: "https://site.example/watch/duration"
  };
  const id = await failedBrowserJob(body);

  const longer = await startBrowserJob({ ...body, durationSeconds: 45 });
  assert.equal(longer.body.resumed, false);
  await fetchJson(`/jobs/${encodeURIComponent(longer.body.job.id)}/cancel`, { method: "POST" });

  const drift = await startBrowserJob({ ...body, durationSeconds: 30.4 });
  assert.equal(drift.body.resumed, true);
  assert.equal(drift.body.job.id, id);
});

it("BROWSER_BLOCKED failures are resumable and the resume records the new download mode", async () => {
  const body = {
    url: "https://cdn.example.com/resume/mode.m3u8",
    title: "Resume Mode",
    totalSegments: 2,
    sourcePageUrl: "https://site.example/watch/mode",
    downloadMode: "extension"
  };
  const first = await startBrowserJob(body);
  assert.equal(first.body.job.downloadMode, "extension");
  await fetchJson(`/browser-downloads/${encodeURIComponent(first.body.job.id)}/fail`, {
    method: "POST",
    body: { error: "BROWSER_BLOCKED: HTTP 403" }
  });
  assert.equal(jobs.get(first.body.job.id).resumable, true);

  const second = await startBrowserJob({ ...body, downloadMode: "page" });

  assert.equal(second.body.resumed, true);
  assert.equal(second.body.job.downloadMode, "page");
});

it("an unknown download mode is not stored", async () => {
  const res = await startBrowserJob({
    url: "https://cdn.example.com/resume/badmode.m3u8",
    title: "Bad Mode",
    totalSegments: 1,
    downloadMode: "<script>"
  });
  assert.equal(res.body.job.downloadMode, null);
});

it("stopping a browser job keeps its segments so it can be resumed", async () => {
  const body = {
    url: "https://cdn.example.com/resume/cancel.m3u8",
    title: "Resume Cancel",
    totalSegments: 2,
    sourcePageUrl: "https://site.example/watch/cancel"
  };
  const first = await startBrowserJob(body);
  const id = first.body.job.id;
  await uploadSegment(id, "seg-000000.ts");
  await fetchJson(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

  const stopped = jobs.get(id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.resumable, true);
  assert.ok(existsSync(path.join(stopped.tempDir, "seg-000000.ts")));

  const second = await startBrowserJob(body);
  assert.equal(second.body.resumed, true);
  assert.equal(second.body.job.id, id);
  assert.equal(second.body.job.status, "running");
  assert.deepEqual(second.body.receivedFiles, ["seg-000000.ts"]);
});

it("a browser job keeps its stream URL while muxing, so a restart mid-mux can still resume", async () => {
  const start = await startBrowserJob({
    url: "https://cdn.example.com/resume/mux.m3u8",
    title: "Resume Mux",
    totalSegments: 1,
    sourcePageUrl: "https://site.example/watch/mux"
  });
  const id = start.body.job.id;
  await uploadSegment(id, "seg-000000.ts");

  const complete = await fetchJson(`/browser-downloads/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: { playlistText: "#EXTM3U\n#EXTINF:4,\nseg-000000.ts\n#EXT-X-ENDLIST" }
  });

  assert.equal(complete.status, 202);
  assert.equal(complete.body.job.url, "https://cdn.example.com/resume/mux.m3u8");
  assert.ok(complete.body.job.localPlaylistPath.endsWith("input.m3u8"));
});

it("a DASH job remembers its tracks and resumes only the same tracks", async () => {
  const body = {
    url: "https://cdn.example.com/resume/dash.mpd",
    kind: "dash",
    quality: "720p",
    trackKey: "v720|a128",
    title: "Resume Dash",
    totalSegments: 4,
    sourcePageUrl: "https://site.example/watch/dash"
  };
  const id = await failedBrowserJob(body);
  const job = jobs.get(id);
  assert.equal(job.streamKind, "dash");
  assert.equal(job.quality, "720p");

  const otherQuality = await startBrowserJob({ ...body, quality: "360p", trackKey: "v360|a128" });
  assert.equal(otherQuality.body.resumed, false);
  await fetchJson(`/jobs/${encodeURIComponent(otherQuality.body.job.id)}/cancel`, { method: "POST" });

  const same = await startBrowserJob(body);
  assert.equal(same.body.resumed, true);
  assert.equal(same.body.job.id, id);
});

it("a DASH job muxes its audio playlist as a second ffmpeg input", async () => {
  const start = await startBrowserJob({
    url: "https://cdn.example.com/dash/mux.mpd",
    kind: "dash",
    title: "Dash Mux",
    totalSegments: 2,
    sourcePageUrl: "https://site.example/watch/dash-mux"
  });
  const id = start.body.job.id;
  await uploadSegment(id, "seg-v-000000.m4s");
  await uploadSegment(id, "seg-a-000000.m4s");

  const complete = await fetchJson(`/browser-downloads/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: {
      playlistText: "#EXTM3U\n#EXTINF:4,\nseg-v-000000.m4s\n#EXT-X-ENDLIST",
      audioPlaylistText: "#EXTM3U\n#EXTINF:4,\nseg-a-000000.m4s\n#EXT-X-ENDLIST"
    }
  });

  assert.equal(complete.status, 202);
  const job = jobs.get(id);
  assert.ok(job.localAudioPlaylistPath.endsWith("audio.m3u8"));
  assert.match(await readFile(job.localAudioPlaylistPath, "utf8"), /seg-a-000000\.m4s/);
  const inputs = job.ffmpegArgs.filter((arg, i) => job.ffmpegArgs[i - 1] === "-i");
  assert.deepEqual(inputs, [job.localPlaylistPath, job.localAudioPlaylistPath]);
  assert.ok(job.ffmpegArgs.join(" ").includes("-map 0:v:0? -map 1:a:0"));
});

it("resumable temp files expire after the retention window", async () => {
  const start = await startBrowserJob({
    url: "https://cdn.example.com/resume/expire.m3u8",
    title: "Resume Expire",
    totalSegments: 2,
    sourcePageUrl: "https://site.example/watch/expire"
  });
  const id = start.body.job.id;
  await uploadSegment(id, "seg-000000.ts");
  await fetchJson(`/browser-downloads/${encodeURIComponent(id)}/fail`, {
    method: "POST",
    body: { error: "SOURCE_PAGE_CLOSED" }
  });
  const job = jobs.get(id);
  job.finishedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();

  await sweepStalledJobs();

  assert.equal(job.resumable, false);
  assert.ok(!existsSync(job.tempDir));
});

it("forgetting a resumable job removes its temp files", async () => {
  const start = await startBrowserJob({
    url: "https://cdn.example.com/resume/forget.m3u8",
    title: "Resume Forget",
    totalSegments: 2,
    sourcePageUrl: "https://site.example/watch/forget"
  });
  const id = start.body.job.id;
  const tempDir = start.body.job.tempDir;
  await uploadSegment(id, "seg-000000.ts");
  await fetchJson(`/browser-downloads/${encodeURIComponent(id)}/fail`, {
    method: "POST",
    body: { error: "SOURCE_PAGE_CLOSED" }
  });

  await fetchJson(`/jobs/${encodeURIComponent(id)}/history`, { method: "DELETE" });

  assert.ok(!jobs.has(id));
  assert.ok(!existsSync(tempDir));
});

// ─── Output name/folder and direct downloads ───

const CUSTOM_DIR = path.join(process.env.DOWNLOAD_DIR, "picked-folder");

it("POST /browser-downloads/start uses the dialog's file name and folder", async () => {
  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: {
      url: "https://cdn.example.com/named/video.m3u8",
      title: "Page Title",
      filename: "My: Clip.mp4",
      downloadDir: CUSTOM_DIR,
      totalSegments: 1,
      sourcePageUrl: "https://site.example/watch/named"
    },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.job.outputPath, path.join(CUSTOM_DIR, "My Clip.mp4"));
  assert.equal(res.body.job.downloadDir, CUSTOM_DIR);
});

it("a relative download folder is rejected", async () => {
  const res = await fetchJson("/browser-downloads/start", {
    method: "POST",
    body: { url: "https://cdn.example.com/rel.m3u8", downloadDir: "videos", totalSegments: 1 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_DOWNLOAD_DIR");
});

// Serves `content` (a Buffer, or a function returning the current one) with
// optional Range support; `onRequest` may answer first.
async function startUpstream(content, { ranges = true, onRequest } = {}) {
  const stats = { requests: [], active: 0, maxActive: 0 };
  const upstream = http.createServer(async (req, res) => {
    const body = typeof content === "function" ? content() : content;
    stats.requests.push(req.headers.range || "");
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.on("close", () => { stats.active -= 1; });
    if (onRequest && await onRequest(req, res, stats)) return;
    // Hold each response briefly so parallel requests overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
    if (ranges && match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), body.length - 1);
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${body.length}`
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  return { upstream, stats, url: `http://127.0.0.1:${upstream.address().port}/clip.webm` };
}

async function waitForJob(id, done = (job) => job.status !== "running" && job.status !== "queued") {
  for (let i = 0; i < 200; i += 1) {
    const job = jobs.get(id);
    if (job && done(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not settle`);
}

function testBytes(size) {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i * 7) % 251));
}

it("direct downloads split a ranged file over parallel connections", async () => {
  const body = testBytes(10_500);
  const { upstream, stats, url } = await startUpstream(body);
  try {
    const res = await fetchJson("/download", {
      method: "POST",
      body: { url, kind: "direct", extension: "webm", filename: "Parallel", downloadDir: CUSTOM_DIR, headers: [] },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.job.inputMode, "direct");
    assert.equal(res.body.job.totalBytes, body.length);

    const job = await waitForJob(res.body.job.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.outputPath, path.join(CUSTOM_DIR, "Parallel.webm"));
    assert.deepEqual(await readFile(job.outputPath), body);
    assert.ok(!existsSync(`${job.outputPath}.part`));
    // 1 probe + 11 chunks of 1000 bytes, at most 4 at a time.
    assert.equal(stats.requests.length, 12);
    assert.ok(stats.maxActive > 1 && stats.maxActive <= 4, `maxActive=${stats.maxActive}`);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("direct downloads use one connection when the server ignores Range", async () => {
  const body = testBytes(4_321);
  const { upstream, stats, url } = await startUpstream(body, { ranges: false });
  try {
    const res = await fetchJson("/download", {
      method: "POST",
      body: { url, kind: "direct", title: "No Ranges", headers: [] },
    });
    assert.equal(res.status, 202);
    const job = await waitForJob(res.body.job.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(path.extname(job.outputPath), ".webm", "extension falls back to the URL");
    assert.equal(path.dirname(job.outputPath), process.env.DOWNLOAD_DIR, "default folder");
    assert.deepEqual(await readFile(job.outputPath), body);
    assert.equal(stats.requests.length, 1, "the probe response body is the download");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("direct downloads drop to one connection after a 429 and still finish", async () => {
  const body = testBytes(6_000);
  let refused = 0;
  const { upstream, url } = await startUpstream(body, {
    onRequest: async (req, res) => {
      if (req.headers.range === "bytes=0-0" || refused >= 2) return false;
      refused += 1;
      res.writeHead(429);
      res.end();
      return true;
    }
  });
  try {
    const res = await fetchJson("/download", {
      method: "POST",
      body: { url, kind: "direct", filename: "Throttled", headers: [] },
    });
    const job = await waitForJob(res.body.job.id);
    assert.equal(job.status, "completed", job.error);
    assert.deepEqual(await readFile(job.outputPath), body);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("direct downloads report a 403 before creating a job", async () => {
  const { upstream, url } = await startUpstream(testBytes(10), {
    onRequest: async (_req, res) => {
      res.writeHead(403);
      res.end();
      return true;
    }
  });
  try {
    const before = jobs.size;
    const res = await fetchJson("/download", { method: "POST", body: { url, kind: "direct", headers: [] } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "SERVER_PROTECTED_UNSUPPORTED");
    assert.equal(jobs.size, before);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

// Serves 6 chunks of 1000 bytes; while `gate.stall` is set, chunks from
// byte 3000 on send a few bytes and then hang, so the job can be stopped
// with exactly chunks 0-2 finished.
async function startStallingUpstream(gate) {
  return startUpstream(() => gate.body, {
    onRequest: async (req, res) => {
      const start = Number(/^bytes=(\d+)-/.exec(req.headers.range || "")?.[1] ?? -1);
      if (!gate.stall || start < 3000) return false;
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${start + 999}/${gate.body.length}`, "Content-Length": "1000" });
      res.write(gate.body.subarray(start, start + 10));
      return true;
    }
  });
}

async function startAndStopDirect(url, filename) {
  const res = await fetchJson("/download", { method: "POST", body: { url, kind: "direct", filename, headers: [] } });
  const id = res.body.job.id;
  await waitForJob(id, (job) => job.directChunksDone?.length === 3);
  const cancel = await fetchJson(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);
  return jobs.get(id);
}

it("Stop pauses a ranged direct download and Resume fetches only the missing chunks", async () => {
  const gate = { body: testBytes(6_000), stall: true };
  const { upstream, stats, url } = await startStallingUpstream(gate);
  try {
    const job = await startAndStopDirect(url, "Paused");
    const partPath = `${job.outputPath}.part`;
    assert.equal(job.status, "cancelled");
    assert.equal(job.resumable, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(partPath), "the partial file is kept");

    upstream.closeAllConnections();
    gate.stall = false;
    stats.requests.length = 0;
    const resume = await fetchJson(`/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST", body: { headers: [] } });
    assert.equal(resume.status, 202);
    assert.equal(resume.body.resumed, true);

    const done = await waitForJob(job.id);
    assert.equal(done.status, "completed", done.error);
    assert.deepEqual(await readFile(done.outputPath), gate.body);
    assert.ok(!existsSync(partPath));
    assert.deepEqual(stats.requests.sort(), ["bytes=0-0", "bytes=3000-3999", "bytes=4000-4999", "bytes=5000-5999"]);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("downloading the same direct file again continues the stopped job", async () => {
  const gate = { body: testBytes(6_000), stall: true };
  const { upstream, url } = await startStallingUpstream(gate);
  try {
    const job = await startAndStopDirect(url, "Again");
    upstream.closeAllConnections();
    gate.stall = false;

    const res = await fetchJson("/download", { method: "POST", body: { url, kind: "direct", filename: "Another Name", headers: [] } });
    assert.equal(res.status, 202);
    assert.equal(res.body.job.id, job.id, "the old job is reopened");
    assert.equal(res.body.resumed, true);
    const done = await waitForJob(job.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(path.basename(done.outputPath), "Again.webm", "the original name is kept");
    assert.deepEqual(await readFile(done.outputPath), gate.body);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("Resume starts over when the file on the server changed size", async () => {
  const gate = { body: testBytes(6_000), stall: true };
  const { upstream, url } = await startStallingUpstream(gate);
  try {
    const job = await startAndStopDirect(url, "Changed");
    upstream.closeAllConnections();
    gate.stall = false;
    gate.body = testBytes(2_500);

    const resume = await fetchJson(`/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST", body: { headers: [] } });
    assert.equal(resume.body.resumed, false);
    const done = await waitForJob(job.id);
    assert.equal(done.status, "completed", done.error);
    assert.deepEqual(await readFile(done.outputPath), gate.body);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("removing a stopped direct job deletes its partial file", async () => {
  const gate = { body: testBytes(6_000), stall: true };
  const { upstream, url } = await startStallingUpstream(gate);
  try {
    const job = await startAndStopDirect(url, "Removed");
    const partPath = `${job.outputPath}.part`;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(partPath));

    await fetchJson(`/jobs/${encodeURIComponent(job.id)}/history`, { method: "DELETE" });
    assert.ok(!jobs.has(job.id));
    assert.ok(!existsSync(partPath));
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

it("a stalled ranged direct job keeps its partial file for 24 hours", async () => {
  const outputPath = path.join(process.env.DOWNLOAD_DIR, "stalled-direct.mp4");
  await writeFile(`${outputPath}.part`, "partial");
  const job = {
    id: "stalled-direct",
    inputMode: "direct",
    status: "running",
    url: "https://cdn.example.com/stalled.mp4",
    outputPath,
    downloadDir: process.env.DOWNLOAD_DIR,
    directChunkBytes: 1000,
    directChunksDone: [0],
    startedAt: new Date().toISOString(),
    lastActivityAt: Date.now() - 60 * 60_000,
    log: []
  };
  jobs.set(job.id, job);

  await sweepStalledJobs();
  assert.equal(job.status, "failed");
  assert.equal(job.error, "DOWNLOAD_STALLED");
  assert.equal(job.resumable, true);
  assert.ok(existsSync(`${outputPath}.part`));

  job.finishedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  await sweepStalledJobs();
  assert.equal(job.resumable, false);
  assert.ok(!existsSync(`${outputPath}.part`));
  jobs.delete(job.id);
});

it("a direct download that cannot use ranges is not resumable after Stop", async () => {
  const body = testBytes(3_000);
  const { upstream, url } = await startUpstream(body, {
    // Whole-file response that never finishes.
    onRequest: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(body.length) });
      res.write(body.subarray(0, 10));
      return true;
    }
  });
  try {
    const res = await fetchJson("/download", { method: "POST", body: { url, kind: "direct", filename: "Unranged", headers: [] } });
    const id = res.body.job.id;
    const partPath = `${res.body.job.outputPath}.part`;
    await waitForJob(id, () => existsSync(partPath));
    await fetchJson(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    for (let i = 0; i < 100 && existsSync(partPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(jobs.get(id).resumable, false);
    assert.ok(!existsSync(partPath));
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

}); // close describe
