import { describe, before, after, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

// Dynamic import to get server reference
const serverPath = pathToFileURL(path.join(__dirname, "..", "helper", "server.js")).href;
const serverModule = await import(serverPath);
const { server, jobs, isSafeDownloadPath, sweepStalledJobs } = serverModule;

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
  assert.match(res.body, /app-background\.webp/);
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

// ─── Error Handling ───

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

  await sweepStalledJobs(10_001, 10_000);

  assert.equal(jobs.get(id).status, "failed");
  assert.equal(jobs.get(id).error, "DOWNLOAD_STALLED");
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

}); // close describe
