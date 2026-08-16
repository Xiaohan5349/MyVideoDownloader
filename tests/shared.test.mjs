import test from "node:test";
import assert from "node:assert/strict";
import {
  addUniqueMedia,
  classifyMedia,
  estimateBytes,
  fallbackBandwidthForQuality,
  mergeSettings,
  inferQualityLabel,
  normalizeMediaItem,
  parseDashManifest,
  parseHlsManifest,
  sanitizeFilename
} from "../src/shared.js";

test("classifyMedia detects direct URLs and manifests", () => {
  assert.deepEqual(classifyMedia("https://example.com/video.mp4"), { extension: "mp4", kind: "direct" });
  assert.deepEqual(classifyMedia("https://example.com/live/master.m3u8"), { extension: "m3u8", kind: "hls" });
  assert.deepEqual(classifyMedia("https://example.com/watch?src=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8"), { extension: "m3u8", kind: "hls" });
  assert.deepEqual(classifyMedia("https://example.com/manifest", "application/dash+xml"), { extension: "mpd", kind: "dash" });
  assert.equal(classifyMedia("https://example.com/page.html"), null);
});

test("normalizeMediaItem keeps a validated type for extensionless signed media URLs", () => {
  const item = normalizeMediaItem({
    url: "https://example.com/media/video/111086/720p?expires=123&signature=test",
    sourcePageUrl: "https://example.com/watch",
    title: "Signed video",
    extension: "mp4",
    kind: "direct"
  });
  assert.equal(item.extension, "mp4");
  assert.equal(item.kind, "direct");
  assert.equal(item.quality, "720p");
});

test("sanitizeFilename strips invalid path characters and adds extension", () => {
  assert.equal(sanitizeFilename('bad:/name*"test"', "mp4"), "bad name test.mp4");
  assert.equal(sanitizeFilename("clip.webm", ".webm"), "clip.webm");
  assert.equal(sanitizeFilename("", "mp4"), "video.mp4");
});

test("addUniqueMedia preserves enriched variants and sizes on re-detection", () => {
  const first = addUniqueMedia([], [{
    url: "https://cdn.example.com/master.m3u8",
    sourcePageUrl: "https://site.example",
    title: "Stream",
    extension: "m3u8",
    kind: "hls",
    variants: [{ url: "https://cdn.example.com/720p.m3u8", quality: "720p" }],
    estimatedSize: 5000000,
    durationSeconds: 100,
    quality: "720p"
  }]);
  const second = addUniqueMedia(first, [{
    url: "https://cdn.example.com/master.m3u8",
    sourcePageUrl: "https://site.example",
    title: "video",
    extension: "m3u8",
    kind: "hls"
  }]);

  assert.equal(second.length, 1);
  assert.equal(second[0].quality, "720p");
  assert.equal(second[0].estimatedSize, 5000000);
  assert.equal(second[0].durationSeconds, 100);
  assert.equal(second[0].variants.length, 1);
});

test("sanitizeFilename avoids Windows reserved device names", () => {
  assert.equal(sanitizeFilename("CON", "mp4"), "_CON.mp4");
  assert.equal(sanitizeFilename("nul", "mp4"), "_nul.mp4");
  assert.equal(sanitizeFilename("COM1", "mp4"), "_COM1.mp4");
  assert.equal(sanitizeFilename("CON.video", "mp4"), "_CON.video.mp4");
});

test("addUniqueMedia deduplicates by page and URL", () => {
  const first = addUniqueMedia([], [
    { url: "https://cdn.example.com/a.mp4", sourcePageUrl: "https://site.example", title: "A" }
  ]);
  const second = addUniqueMedia(first, [
    { url: "https://cdn.example.com/a.mp4", sourcePageUrl: "https://site.example", title: "A updated" }
  ]);
  assert.equal(second.length, 1);
  assert.equal(second[0].title, "A updated");
});

test("addUniqueMedia keeps different direct URLs even when title/size match", () => {
  const items = addUniqueMedia([], [
    { url: "https://cdn.example.com/a.mp4", sourcePageUrl: "https://site.example", title: "Same", extension: "mp4", kind: "direct", quality: "360p", size: null },
    { url: "https://cdn.example.com/b.mp4", sourcePageUrl: "https://site.example", title: "Same", extension: "mp4", kind: "direct", quality: "720p", size: null },
    { url: "https://cdn.example.com/c.mp4", sourcePageUrl: "https://site.example", title: "Same", extension: "mp4", kind: "direct", size: 12345 },
    { url: "https://cdn.example.com/d.mp4", sourcePageUrl: "https://site.example", title: "Same", extension: "mp4", kind: "direct", size: 12345 },
    { url: "https://cdn.example.com/a.mp4", sourcePageUrl: "https://site.example", title: "Same", extension: "mp4", kind: "direct" }
  ]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.url).sort(), [
    "https://cdn.example.com/a.mp4",
    "https://cdn.example.com/b.mp4",
    "https://cdn.example.com/c.mp4",
    "https://cdn.example.com/d.mp4"
  ]);
});

test("parseHlsManifest extracts variants and DRM state", () => {
  const parsed = parseHlsManifest(
    [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "low/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720",
      "mid/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080",
      "https://cdn.example.com/high/index.m3u8"
    ].join("\n"),
    "https://cdn.example.com/master.m3u8"
  );
  assert.equal(parsed.hasDrm, false);
  assert.equal(parsed.variants.length, 3);
  assert.equal(parsed.variants[0].url, "https://cdn.example.com/low/index.m3u8");
  assert.equal(parsed.variants[0].quality, "360p");
  assert.equal(parsed.variants[1].quality, "720p");
  assert.equal(parsed.variants[2].quality, "1080p");
});

test("parseHlsManifest reads media playlist duration for estimates", () => {
  const parsed = parseHlsManifest("#EXTM3U\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:6.5,\nseg1.ts");
  assert.equal(parsed.durationSeconds, 10.5);
  assert.equal(estimateBytes(parsed.durationSeconds, 800000), 1050000);
});

test("fallbackBandwidthForQuality gives usable HLS estimates", () => {
  assert.equal(fallbackBandwidthForQuality("720p"), 2800000);
  assert.equal(fallbackBandwidthForQuality("1080p"), 5000000);
  assert.equal(fallbackBandwidthForQuality("unknown"), null);
});

test("parseHlsManifest marks DRM-style encrypted streams as protected", () => {
  const parsed = parseHlsManifest("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\"\nsegment.ts");
  assert.equal(parsed.hasDrm, true);
});

test("parseHlsManifest keeps DRM state when later keys are plain AES-128", () => {
  const parsed = parseHlsManifest([
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\"",
    "#EXTINF:4.0,",
    "segment0.ts",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
    "#EXTINF:4.0,",
    "segment1.ts"
  ].join("\n"));
  assert.equal(parsed.hasDrm, true);
});

test("parseHlsManifest allows accessible AES-128 HLS keys", () => {
  const parsed = parseHlsManifest("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.key\"\n#EXTINF:4.0,\nsegment.ts");
  assert.equal(parsed.hasDrm, false);
});

test("parseDashManifest extracts representations and DRM state", () => {
  const parsed = parseDashManifest(
    '<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation bandwidth="1200000" width="1280" height="720"/></AdaptationSet></Period></MPD>',
    "https://cdn.example.com/stream.mpd"
  );
  assert.equal(parsed.hasDrm, true);
  assert.deepEqual(parsed.variants[0], {
    url: "https://cdn.example.com/stream.mpd",
    quality: "720p",
    bandwidth: 1200000
  });
});

test("mergeSettings keeps defaults and applies local overrides", () => {
  const defaults = mergeSettings();
  assert.equal(defaults.minSizeBytes, 1024 * 1024);

  const settings = mergeSettings({ minSizeBytes: 2048 });
  assert.equal(settings.minSizeBytes, 2048);
  assert.equal(settings.showUnsupported, true);
});

test("inferQualityLabel reads common HLS quality URL patterns", () => {
  assert.equal(inferQualityLabel("https://cdn.example.com/hls/1080p/index.m3u8"), "1080p");
  assert.equal(inferQualityLabel("https://cdn.example.com/video/1280x720/playlist.m3u8"), "720p");
  assert.equal(inferQualityLabel("https://cdn.example.com/stream_360/index.m3u8"), "360p");
  assert.equal(inferQualityLabel("https://cdn.example.com/hls/180p/video.m3u8"), "180p");
  assert.equal(inferQualityLabel("https://cdn.example.com/master.m3u8"), "");
});

test("inferQualityLabel and normalizeMediaItem tolerate malformed percent encoding", () => {
  assert.equal(inferQualityLabel("https://cdn.example.com/a%zz/video.m3u8"), "");
  const item = normalizeMediaItem({ url: "https://cdn.example.com/a%zz/video", contentType: "video/mp4" });
  assert.equal(item.kind, "direct");
  assert.equal(item.extension, "mp4");
  assert.equal(item.quality, "");
});
