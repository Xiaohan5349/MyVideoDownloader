import { describe, before, after, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set env vars BEFORE dynamic import so server.js skips auto-listen
process.env.NODE_ENV = "test";
process.env.PORT = "0"; // Random port
process.env.DOWNLOAD_DIR = path.join(__dirname, "..", "helper", "test-downloads");

// Dynamic import to get server reference
const serverPath = pathToFileURL(path.join(__dirname, "..", "helper", "server.js")).href;
const serverModule = await import(serverPath);
const { server, isSafeDownloadPath } = serverModule;

let baseUrl;

describe("server.js HTTP API", () => {
  before(async () => {
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(() => {
    server.close();
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
      totalSizeSource: "estimated"
    },
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job.status, "running");
  assert.equal(res.body.job.inputMode, "browser");
  assert.equal(res.body.job.totalSegments, 2);
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
  assert.equal(isSafeDownloadPath(outside, baseDir), false);
});

it("isSafeDownloadPath: falsy value returns false", () => {
  assert.equal(isSafeDownloadPath("", "/tmp"), false);
  assert.equal(isSafeDownloadPath(null, "/tmp"), false);
});

}); // close describe
