import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (name) => pathToFileURL(path.join(__dirname, "..", "src", name)).href;
const {
  buildDashAssetPlan,
  buildDashTracks,
  expandSegmentBase,
  isDashManifest,
  listDashVariants,
  parseIsoDuration,
  parseSidx
} = await import(src("dash-browser.js"));
const { startHlsDownload } = await import(src("hls-download.js"));

const MPD_URL = "https://cdn.example.com/v/manifest.mpd?token=abc";

// 10 s VOD, 4 s segments → 3 segments per track (last one 2 s).
const numberMpd = `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <BaseURL>media/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1"
        initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s?a=1&amp;b=2"/>
      <Representation id="v360" bandwidth="800000" width="640" height="360"/>
      <Representation id="v720" bandwidth="2500000" width="1280" height="720"/>
      <Representation id="v720hi" bandwidth="3500000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <SegmentTemplate timescale="1000" duration="4000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s"/>
      <Representation id="a64" bandwidth="64000"/>
      <Representation id="a128" bandwidth="128000"/>
    </AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/webm">
      <Representation id="vp9-1080" bandwidth="4000000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test("isDashManifest tells an MPD from an HLS playlist", () => {
  assert.equal(isDashManifest(numberMpd), true);
  assert.equal(isDashManifest("#EXTM3U\n#EXTINF:4,\na.ts"), false);
});

test("parseIsoDuration reads MPD durations", () => {
  assert.equal(parseIsoDuration("PT1H2M3.5S"), 3723.5);
  assert.equal(parseIsoDuration("PT0S"), null);
  assert.equal(parseIsoDuration("bogus"), null);
});

test("listDashVariants lists MP4 video qualities only, best first, one per quality", () => {
  const listed = listDashVariants(numberMpd, MPD_URL);
  assert.equal(listed.hasDrm, false);
  assert.equal(listed.durationSeconds, 10);
  assert.deepEqual(listed.variants, [
    { url: MPD_URL, quality: "720p", bandwidth: 3500000 },
    { url: MPD_URL, quality: "360p", bandwidth: 800000 }
  ]);
});

test("buildDashTracks expands $Number$ templates for the best video and audio", () => {
  const dash = buildDashTracks(numberMpd, MPD_URL);
  assert.equal(dash.quality, "720p");
  assert.equal(dash.trackKey, "v720hi|a128");
  const [video, audio] = dash.tracks;
  assert.equal(video.init.url, "https://cdn.example.com/v/media/v720hi/init.mp4");
  assert.deepEqual(video.segments.map((s) => s.url.split("/").pop()), [
    "seg-001.m4s?a=1&b=2", "seg-002.m4s?a=1&b=2", "seg-003.m4s?a=1&b=2"
  ]);
  assert.deepEqual(video.segments.map((s) => s.duration), [4, 4, 2]);
  assert.equal(audio.segments[0].url, "https://cdn.example.com/v/media/a128/1.m4s");
});

test("buildDashTracks honours the requested quality", () => {
  assert.equal(buildDashTracks(numberMpd, MPD_URL, "360p").trackKey, "v360|a128");
});

test("buildDashTracks walks a SegmentTimeline with repeats and $Time$", () => {
  const mpd = `<MPD type="static" mediaPresentationDuration="PT6S"><Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate timescale="90000" initialization="init-$RepresentationID$.mp4" media="t-$Time$.m4s">
        <SegmentTimeline><S t="0" d="180000" r="1"/><S d="90000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v" bandwidth="1" width="1920" height="1080"/>
    </AdaptationSet></Period></MPD>`;
  const [video] = buildDashTracks(mpd, "https://cdn.example.com/x/a.mpd").tracks;
  assert.deepEqual(video.segments.map((s) => s.url.split("/").pop()), ["t-0.m4s", "t-180000.m4s", "t-360000.m4s"]);
  assert.deepEqual(video.segments.map((s) => s.duration), [2, 2, 1]);
});

test("buildDashTracks rejects layouts the browser loop cannot download", () => {
  const wrap = (attrs, body) => `<MPD ${attrs}>${body}</MPD>`;
  const period = '<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" width="1" height="1"/></AdaptationSet></Period>';
  assert.throws(() => buildDashTracks(wrap('type="dynamic"', period), MPD_URL), /DASH_LIVE_UNSUPPORTED/);
  assert.throws(() => buildDashTracks(wrap("", period + period), MPD_URL), /DASH_MULTI_PERIOD_UNSUPPORTED/);
  assert.throws(() => buildDashTracks(wrap("", `<Period><ContentProtection/></Period>`), MPD_URL), /DRM_PROTECTED_UNSUPPORTED/);
  assert.throws(() => buildDashTracks(wrap("", period), MPD_URL), /DASH_SEGMENT_INDEX_MISSING/);
});

// sidx v0 with two references of 1000 and 1500 bytes, timescale 1000.
function sidxBox() {
  const bytes = new Uint8Array(32 + 2 * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set([0x73, 0x69, 0x64, 0x78], 4); // "sidx"
  view.setUint32(12, 1); // reference_ID
  view.setUint32(16, 1000); // timescale
  view.setUint32(24, 0); // first_offset
  view.setUint16(30, 2); // reference_count
  view.setUint32(32, 1000);
  view.setUint32(36, 4000);
  view.setUint32(44, 1500);
  view.setUint32(48, 3000);
  return bytes;
}

test("parseSidx turns references into absolute byte ranges", () => {
  assert.deepEqual(parseSidx(sidxBox(), 800), [
    { byteRange: { offset: 856, length: 1000 }, duration: 4 },
    { byteRange: { offset: 1856, length: 1500 }, duration: 3 }
  ]);
});

test("SegmentBase tracks are expanded from their sidx", async () => {
  const mpd = `<MPD mediaPresentationDuration="PT7S"><Period><AdaptationSet mimeType="video/mp4">
    <Representation id="v" width="1280" height="720"><BaseURL>DASH_720.mp4</BaseURL>
      <SegmentBase indexRange="800-855"><Initialization range="0-799"/></SegmentBase>
    </Representation></AdaptationSet></Period></MPD>`;
  const { tracks } = buildDashTracks(mpd, "https://v.example.com/abc/DASHPlaylist.mpd");
  const requests = [];
  await expandSegmentBase(tracks, async (url, byteRange) => {
    requests.push({ url, byteRange });
    return sidxBox().buffer;
  });
  assert.deepEqual(requests, [{ url: "https://v.example.com/abc/DASH_720.mp4", byteRange: { offset: 800, length: 56 } }]);
  assert.deepEqual(tracks[0].init.byteRange, { offset: 0, length: 800 });
  assert.deepEqual(tracks[0].segments.map((s) => s.byteRange), [
    { offset: 856, length: 1000 }, { offset: 1856, length: 1500 }
  ]);
});

test("buildDashAssetPlan names files per track and writes fMP4 playlists", () => {
  const plan = buildDashAssetPlan(buildDashTracks(numberMpd, MPD_URL).tracks);
  assert.equal(plan.segmentAssetCount, 6);
  assert.deepEqual(plan.assets.map((a) => a.name), [
    "init-v.mp4", "seg-v-000000.m4s", "seg-v-000001.m4s", "seg-v-000002.m4s",
    "init-a.mp4", "seg-a-000000.m4s", "seg-a-000001.m4s", "seg-a-000002.m4s"
  ]);
  assert.equal(plan.playlists.video, [
    "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-MAP:URI="init-v.mp4"',
    "#EXTINF:4.000,", "seg-v-000000.m4s",
    "#EXTINF:4.000,", "seg-v-000001.m4s",
    "#EXTINF:2.000,", "seg-v-000002.m4s",
    "#EXT-X-ENDLIST"
  ].join("\n"));
  assert.match(plan.playlists.audio, /#EXT-X-MAP:URI="init-a.mp4"/);
});

test("startHlsDownload downloads an MPD and sends both playlists to the helper", async () => {
  const HELPER = "http://127.0.0.1:8765";
  const MOOF = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    if (url === MPD_URL) return new Response(numberMpd, { status: 200 });
    if (url.startsWith("https://cdn.example.com/v/media/")) return new Response(MOOF, { status: 200 });
    if (url === `${HELPER}/browser-downloads/start`) return Response.json({ ok: true, job: { id: "j" }, receivedFiles: [] }, { status: 202 });
    if (url.startsWith(`${HELPER}/jobs/`)) return Response.json({ id: "j", status: "running" });
    if (url.includes("/browser-downloads/j/")) return Response.json({ ok: true });
    throw new Error(`unexpected fetch ${url}`);
  };

  const handle = await startHlsDownload({
    helperUrl: HELPER,
    manifestUrl: MPD_URL,
    quality: "360p",
    title: "Clip",
    sourcePageUrl: "https://site.example/watch/1",
    strict: true,
    fetchImpl,
    retryDelayMs: () => 0
  });
  assert.deepEqual(await handle.done, { status: "completed" });

  const start = JSON.parse(calls.find((c) => c.url.endsWith("/start")).options.body);
  assert.equal(start.url, MPD_URL);
  assert.equal(start.kind, "dash");
  assert.equal(start.quality, "360p");
  assert.equal(start.trackKey, "v360|a128");
  assert.equal(start.totalSegments, 6);
  assert.equal(start.durationSeconds, 10);

  const uploads = calls.filter((c) => c.url.includes("/files/")).map((c) => c.url.split("/").pop()).sort();
  assert.equal(uploads.length, 8);
  assert.ok(uploads.includes("init-a.mp4") && uploads.includes("seg-v-000002.m4s"));

  const complete = JSON.parse(calls.find((c) => c.url.endsWith("/complete")).options.body);
  assert.match(complete.playlistText, /init-v\.mp4/);
  assert.match(complete.audioPlaylistText, /init-a\.mp4/);
});
