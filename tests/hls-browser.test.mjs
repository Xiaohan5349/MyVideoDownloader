import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHlsAssetPlan,
  buildLocalHlsPlaylist,
  parseHlsMediaPlaylist
} from "../src/hls-browser.js";

test("parseHlsMediaPlaylist extracts segments, map, key, and duration", () => {
  const parsed = parseHlsMediaPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:4.0,",
      "seg0.jpeg",
      "#EXTINF:6.5,",
      "https://cdn.example.com/path/seg1.jpeg"
    ].join("\n"),
    "https://cdn.example.com/path/video.m3u8"
  );

  assert.equal(parsed.hasDrm, false);
  assert.equal(parsed.durationSeconds, 10.5);
  assert.deepEqual(parsed.maps.map((item) => item.url), ["https://cdn.example.com/path/init.mp4"]);
  assert.deepEqual(parsed.keys.map((item) => item.url), ["https://cdn.example.com/path/key.bin"]);
  assert.deepEqual(parsed.segments.map((item) => item.url), [
    "https://cdn.example.com/path/seg0.jpeg",
    "https://cdn.example.com/path/seg1.jpeg"
  ]);
});

test("parseHlsMediaPlaylist rejects DRM-style HLS keys but allows plain AES-128", () => {
  const sampleAes = parseHlsMediaPlaylist(
    "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://license\"\n#EXTINF:4,\nseg.ts",
    "https://cdn.example.com/video.m3u8"
  );
  const keyformat = parseHlsMediaPlaylist(
    "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT=\"com.apple.streamingkeydelivery\",URI=\"key.bin\"\n#EXTINF:4,\nseg.ts",
    "https://cdn.example.com/video.m3u8"
  );
  const aes128 = parseHlsMediaPlaylist(
    "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg.ts",
    "https://cdn.example.com/video.m3u8"
  );

  assert.equal(sampleAes.hasDrm, true);
  assert.equal(keyformat.hasDrm, true);
  assert.equal(aes128.hasDrm, false);
});

test("buildLocalHlsPlaylist rewrites remote URIs to local helper files", () => {
  const playlist = buildLocalHlsPlaylist(
    [
      "#EXTM3U",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
      "#EXTINF:4.0,",
      "seg0.jpeg",
      "#EXTINF:6.5,",
      "seg1.jpeg"
    ].join("\n"),
    "https://cdn.example.com/path/video.m3u8",
    new Map([
      ["https://cdn.example.com/path/init.mp4", "init-000000.mp4"],
      ["https://cdn.example.com/path/key.bin", "key-000000.key"],
      ["https://cdn.example.com/path/seg0.jpeg", "seg-000000.ts"],
      ["https://cdn.example.com/path/seg1.jpeg", "seg-000001.ts"]
    ])
  );

  assert.match(playlist, /#EXT-X-MAP:URI="init-000000\.mp4"/);
  assert.match(playlist, /#EXT-X-KEY:METHOD=AES-128,URI="key-000000\.key"/);
  assert.match(playlist, /\nseg-000000\.ts\n/);
  assert.match(playlist, /\nseg-000001\.ts$/);
});

test("Jable-style AES-128 key with a .ts name is downloaded and rewritten as a key asset", () => {
  const manifestUrl = "https://cdn.example.com/hls/60502/60502.m3u8";
  const text = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"a84c3dee1788d22c.ts\",IV=0x22e85870185b0973fd1e88f0fec7a735",
    "#EXTINF:6.0,",
    "605020.ts",
    "#EXTINF:6.0,",
    "605021.ts"
  ].join("\n");
  const parsed = parseHlsMediaPlaylist(text, manifestUrl);
  const plan = buildHlsAssetPlan(parsed);
  const playlist = buildLocalHlsPlaylist(text, manifestUrl, plan.assetNameByUrl);

  assert.equal(parsed.hasDrm, false);
  assert.equal(plan.segmentAssetCount, 2);
  assert.deepEqual(plan.assets.map((asset) => [asset.role, asset.name]), [
    ["key", "key-000000.key"],
    ["segment", "seg-000000.ts"],
    ["segment", "seg-000001.ts"]
  ]);
  assert.match(playlist, /#EXT-X-KEY:METHOD=AES-128,URI="key-000000\.key",IV=/);
});
