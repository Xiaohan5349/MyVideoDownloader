import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  looksLikeMediaSegment,
  parseHlsMaster,
  pickVariant,
  startHlsDownload
} = await import(pathToFileURL(path.join(__dirname, "..", "src", "hls-download.js")).href);

const HELPER = "http://127.0.0.1:8765";
const MASTER = "https://cdn.example.com/v/master.m3u8";
const MEDIA = "https://cdn.example.com/v/720.m3u8";
const TS = new Uint8Array([0x47, 0x40, 0x00, 0x10]);
const HTML = new TextEncoder().encode("<!doctype html><html>blocked</html>");

const masterText = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
  "360.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
  "720.m3u8"
].join("\n");
const mediaText = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:4,", "s0.ts",
  "#EXTINF:4,", "s1.ts",
  "#EXTINF:4,", "s2.ts",
  "#EXT-X-ENDLIST"
].join("\n");

// Routes a fake network: CDN playlists/segments plus the helper API.
function fakeNetwork({ segment = () => ({ body: TS }), receivedFiles = [], resumed = false } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    if (url === MASTER) return new Response(masterText, { status: 200 });
    if (url === MEDIA) return new Response(mediaText, { status: 200 });
    if (url.startsWith("https://cdn.example.com/v/s")) {
      const { status = 200, body, contentType = "video/mp2t" } = segment(url);
      return new Response(body, { status, headers: { "Content-Type": contentType } });
    }
    if (url === `${HELPER}/browser-downloads/start`) {
      return Response.json({ ok: true, job: { id: "job-1", status: "running" }, resumed, receivedFiles }, { status: 202 });
    }
    if (url.startsWith(`${HELPER}/jobs/`)) return Response.json({ id: "job-1", status: "running" });
    if (/\/browser-downloads\/job-1\/files\//.test(url)) return Response.json({ ok: true });
    if (url.endsWith("/browser-downloads/job-1/complete")) return Response.json({ ok: true }, { status: 202 });
    if (url.endsWith("/browser-downloads/job-1/fail")) return Response.json({ ok: true });
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetch };
}

const segmentFetches = (calls) => calls.filter((c) => /\/v\/s\d\.ts$/.test(c.url)).map((c) => c.url.split("/").pop());
const helperPosts = (calls, suffix) => calls.filter((c) => c.url.endsWith(suffix));

function baseOptions(net, extra = {}) {
  return {
    helperUrl: HELPER,
    manifestUrl: MASTER,
    quality: "720p",
    title: "Video",
    sourcePageUrl: "https://site.example/watch/1",
    fetchImpl: net.fetch,
    retryDelayMs: () => 0,
    ...extra
  };
}

test("looksLikeMediaSegment accepts TS, fMP4 and packed audio but not HTML", () => {
  assert.equal(looksLikeMediaSegment(TS), true);
  assert.equal(looksLikeMediaSegment(new Uint8Array([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70])), true); // styp
  assert.equal(looksLikeMediaSegment(new Uint8Array([0, 0, 0, 24, 0x6d, 0x6f, 0x6f, 0x66])), true); // moof
  assert.equal(looksLikeMediaSegment(new Uint8Array([0x49, 0x44, 0x33, 4])), true); // ID3
  assert.equal(looksLikeMediaSegment(new Uint8Array([0xff, 0xf1, 0x50, 0x80])), true); // ADTS
  assert.equal(looksLikeMediaSegment(HTML), false);
  assert.equal(looksLikeMediaSegment(TS, "text/html; charset=utf-8"), false);
});

test("parseHlsMaster and pickVariant choose the requested quality", () => {
  const master = parseHlsMaster(masterText, MASTER);
  assert.equal(master.variants.length, 2);
  assert.equal(pickVariant(master.variants, "720p").url, MEDIA);
  assert.equal(pickVariant(master.variants, "").url, MEDIA, "defaults to the highest quality");
});

test("a full download uploads every segment and completes the helper job", async () => {
  const net = fakeNetwork();
  const handle = await startHlsDownload(baseOptions(net, { downloadMode: "extension" }));
  const outcome = await handle.done;

  assert.equal(handle.job.id, "job-1");
  assert.equal(outcome.status, "completed");
  assert.deepEqual(segmentFetches(net.calls).sort(), ["s0.ts", "s1.ts", "s2.ts"]);
  const start = JSON.parse(helperPosts(net.calls, "/browser-downloads/start")[0].options.body);
  assert.equal(start.downloadMode, "extension");
  assert.equal(start.totalSegments, 3);
  assert.equal(helperPosts(net.calls, "/complete").length, 1);
});

test("a resumed job only fetches segments the helper does not have", async () => {
  const net = fakeNetwork({ resumed: true, receivedFiles: ["seg-000000.ts", "seg-000002.ts"] });
  const handle = await startHlsDownload(baseOptions(net));
  const outcome = await handle.done;

  assert.equal(handle.resumed, true);
  assert.equal(outcome.status, "completed");
  assert.deepEqual(segmentFetches(net.calls), ["s1.ts"]);
});

test("strict mode probes the first segment and throws before creating a job when blocked", async () => {
  const net = fakeNetwork({ segment: () => ({ body: HTML, contentType: "text/html" }) });

  await assert.rejects(
    startHlsDownload(baseOptions(net, { strict: true })),
    (error) => error.blocked === true
  );
  assert.equal(helperPosts(net.calls, "/browser-downloads/start").length, 0);
});

test("strict mode reuses the probed segment instead of fetching it twice", async () => {
  const net = fakeNetwork();
  const handle = await startHlsDownload(baseOptions(net, { strict: true }));
  await handle.done;

  assert.deepEqual(segmentFetches(net.calls).sort(), ["s0.ts", "s1.ts", "s2.ts"]);
});

test("strict mode reports a mid-download 403 as blocked and fails the job as BROWSER_BLOCKED", async () => {
  const net = fakeNetwork({
    segment: (url) => (url.endsWith("s2.ts") ? { status: 403, body: "denied" } : { body: TS })
  });
  const handle = await startHlsDownload(baseOptions(net, { strict: true }));
  const outcome = await handle.done;

  assert.equal(outcome.status, "blocked");
  assert.equal(segmentFetches(net.calls).filter((name) => name === "s2.ts").length, 1, "no retries once blocked");
  const fail = JSON.parse(helperPosts(net.calls, "/fail")[0].options.body);
  assert.match(fail.error, /^BROWSER_BLOCKED/);
  assert.equal(helperPosts(net.calls, "/complete").length, 0);
});

test("page mode keeps retrying a 403 and reports SEGMENT_DOWNLOAD_FAILED", async () => {
  const net = fakeNetwork({
    segment: (url) => (url.endsWith("s1.ts") ? { status: 403, body: "denied" } : { body: TS })
  });
  const handle = await startHlsDownload(baseOptions(net, { retries: 2 }));
  const outcome = await handle.done;

  assert.equal(outcome.status, "failed");
  assert.ok(segmentFetches(net.calls).filter((name) => name === "s1.ts").length > 1);
  const fail = JSON.parse(helperPosts(net.calls, "/fail")[0].options.body);
  assert.match(fail.error, /^SEGMENT_DOWNLOAD_FAILED/);
});

test("allowUrls sees every host before it is fetched", async () => {
  const net = fakeNetwork();
  const seen = [];
  const handle = await startHlsDownload(baseOptions(net, { allowUrls: async (urls) => { seen.push(...urls); } }));
  await handle.done;

  for (const call of net.calls.filter((c) => c.url.startsWith("https://cdn.example.com/"))) {
    assert.ok(seen.includes(call.url), `${call.url} was fetched without allowUrls`);
  }
});
