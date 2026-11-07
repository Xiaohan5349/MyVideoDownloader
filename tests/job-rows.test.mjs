import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_JOB_SORT, jobDateLabel, jobRows, qualityGrade, recentRows, sortRows } from "../src/shared.js";

test("download dates are short this year and carry the year otherwise", () => {
  const now = new Date(2026, 10, 6, 20, 0);
  assert.equal(jobDateLabel(new Date(2026, 10, 6, 9, 5).toISOString(), now), "11-06 09:05");
  assert.equal(jobDateLabel(new Date(2025, 0, 31, 23, 59).toISOString(), now), "2025-01-31");
  assert.equal(jobDateLabel("", now), "");
  assert.equal(jobDateLabel("not a date", now), "");
});

const media = (width, height, codec, bitrate) => ({ width, height, codec, bitrate });

let clock = 0;
function job(id, extra = {}) {
  clock += 1;
  return {
    id, status: "completed", startedAt: new Date(Date.UTC(2026, 0, 1, 0, clock)).toISOString(),
    downloadedBytes: 100, outputPath: `C:\\Videos\\${id}.mp4`, ...extra
  };
}
const part = (id, bvid, p, extra = {}) => job(id, { inputMode: "bilibili", bilibili: { bvid, p, title: `Made-up ${bvid}` }, ...extra });
const ids = (rows) => rows.map((row) => row.key);
const title = (row) => row.jobs[0].bilibili?.title || row.jobs[0].id;

test("jobRows puts a Bilibili video's parts in one row", () => {
  const rows = jobRows([
    part("p2", "BV1", 2, { downloadedBytes: 300, media: media(1920, 1080, "h264", 1_100_000) }),
    job("solo"),
    part("p1", "BV1", 1, { downloadedBytes: 200, media: media(1920, 1080, "h264", 5_600_000) }),
    part("only", "BV2", 1)
  ]);
  assert.deepEqual(ids(rows), ["bv:BV1", "solo", "only"]);
  const set = rows[0];
  assert.deepEqual(set.jobs.map((entry) => entry.id), ["p1", "p2"]);
  assert.equal(set.bytes, 500);
  assert.equal(set.grade, 2);
  assert.equal(set.bitrate, 1_100_000);
  assert.equal(set.blurryCount, 1);
  assert.equal(set.startedAt, [...set.jobs.map((entry) => entry.startedAt)].sort().at(-1), "the newest part's time");
});

test("a set's grade comes from the parts that have one", () => {
  const [row] = jobRows([
    part("a", "BV3", 1, { media: media(1280, 720, "h264", 2_400_000) }),
    part("b", "BV3", 2, { status: "running" })
  ]);
  assert.equal(row.grade, 3);
  assert.equal(row.blurryCount, 0);
});

test("recentRows counts a set as one row", () => {
  const jobs = [];
  for (let p = 1; p <= 8; p += 1) jobs.push(part(`set${p}`, "BV4", p));
  jobs.push(job("x"), job("y"), job("z"));
  assert.deepEqual(ids(recentRows(jobs, 2)), ["z", "y"]);
  assert.equal(recentRows(jobs, 20).length, 4);
});

test("sortRows orders by size, quality and name", () => {
  const rows = jobRows([
    job("small", { downloadedBytes: 10, media: media(1920, 1080, "h264", 5_600_000) }),
    job("big", { downloadedBytes: 900, media: media(1280, 720, "h264", 2_400_000) }),
    job("none", { downloadedBytes: 500, status: "missing" }),
    job("sharp", { downloadedBytes: 50, media: media(3840, 2160, "h264", 18_000_000) })
  ]);
  assert.deepEqual(ids(sortRows(rows, { key: "size", dir: "desc" }, title)), ["big", "none", "sharp", "small"]);
  assert.deepEqual(ids(sortRows(rows, { key: "quality", dir: "desc" }, title)), ["sharp", "small", "big", "none"]);
  assert.deepEqual(ids(sortRows(rows, { key: "quality", dir: "asc" }, title)), ["big", "small", "sharp", "none"]);
  assert.deepEqual(ids(sortRows(rows, DEFAULT_JOB_SORT, title)), ["sharp", "none", "big", "small"]);
  assert.deepEqual(ids(rows), ["small", "big", "none", "sharp"], "the input is not reordered");
});

test("sortRows by name mixes scripts and breaks ties by newest first", () => {
  const rows = jobRows([job("b2"), job("中文"), job("a10"), job("a9")]);
  const byName = (row) => (row.key.startsWith("b") ? "same" : row.key === "中文" ? "same" : row.key);
  // Where Han sorts against Latin depends on the system locale; numbers sort as numbers.
  assert.deepEqual(ids(sortRows(rows, { key: "name", dir: "asc" }, (row) => row.key)).filter((key) => key !== "中文"), ["a9", "a10", "b2"]);
  assert.deepEqual(ids(sortRows(rows, { key: "name", dir: "asc" }, byName)).slice(-2), ["中文", "b2"]);
});

test("qualityGrade rates resolution and bitrate", () => {
  const cases = [
    [media(3840, 2160, "h264", 18_400_000), 5, false, "4K"],
    [media(1920, 1080, "h264", 5_600_000), 4, false, "1080p"],
    [media(1920, 1080, "h264", 1_100_000), 2, true, "1080p"],
    [media(1280, 720, "h264", 2_400_000), 3, false, "720p"],
    [media(854, 480, "h264", 1_000_000), 1, false, "480p"],
    [media(1920, 1080, "hevc", 2_500_000), 4, false, "1080p"],
    [media(640, 360, "h264", 100_000), 1, true, "360p"]
  ];
  for (const [input, grade, lowBitrate, tier] of cases) {
    assert.deepEqual(qualityGrade(input), { grade, tier, lowBitrate }, JSON.stringify(input));
  }
});

test("qualityGrade uses the short side, so portrait video is not 4K", () => {
  assert.deepEqual(qualityGrade(media(1080, 1920, "h264", 5_600_000)), { grade: 4, tier: "1080p", lowBitrate: false });
});

test("qualityGrade without a bitrate rates the resolution only", () => {
  assert.deepEqual(qualityGrade(media(1920, 1080, "h264", null)), { grade: 4, tier: "1080p", lowBitrate: false });
  assert.deepEqual(qualityGrade(media(1920, 1080, "h264", 0)), { grade: 4, tier: "1080p", lowBitrate: false });
  assert.deepEqual(qualityGrade({ width: 1920, height: 1080 }), { grade: 4, tier: "1080p", lowBitrate: false });
});

test("qualityGrade gives no grade without video facts", () => {
  const none = { grade: 0, tier: "", lowBitrate: false };
  assert.deepEqual(qualityGrade(null), none);
  assert.deepEqual(qualityGrade(undefined), none);
  assert.deepEqual(qualityGrade({ failed: true, probedAt: 1 }), none);
  assert.deepEqual(qualityGrade({ noVideo: true, probedAt: 1 }), none);
});
