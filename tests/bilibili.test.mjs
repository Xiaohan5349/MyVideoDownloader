import test from "node:test";
import assert from "node:assert/strict";
import { parseBvUrl, loadBilibiliDetails, selectBilibiliTracks, readBilibiliApi, bilibiliFileName, API_MAX_BYTES } from "../src/bilibili.js";

const bvid = "BV1111111111";
const url = `https://www.bilibili.com/video/${bvid}`;
const detail = { bvid, title: "Synthetic video", pages: [{ page: 1, cid: 101, part: "One", duration: 2 }, { page: 2, cid: 102, part: "Two", duration: 3 }] };
const video = (id, codecs = "avc1.64001f") => ({ id, codecs, codecid: codecs.startsWith("avc1") ? 7 : 12, baseUrl: `https://media.bilivideo.com/${id}.m4s`, bandwidth: id * 1000 });
const audio = { id: 30280, codecs: "mp4a.40.2", base_url: "https://media.bilivideo.com/audio.m4s", bandwidth: 128000 };

test("file names add the part number and title only for multi-part videos", () => {
  const info = { title: "Synthetic video", pages: [{ p: 1, title: "One" }, { p: 2, title: "Synthetic video" }, { p: 3, title: "P3" }] };
  assert.equal(bilibiliFileName(info, info.pages[0]), "Synthetic video - P1 One");
  assert.equal(bilibiliFileName(info, info.pages[1]), "Synthetic video - P2");
  assert.equal(bilibiliFileName(info, info.pages[2]), "Synthetic video - P3");
  assert.equal(bilibiliFileName({ title: "Single", pages: [{ p: 1, title: "Single" }] }, { p: 1, title: "Single" }), "Single");
});

test("BV input preserves an explicit valid part and rejects ambiguous or invalid p", () => {
  assert.equal(parseBvUrl(`${url}?p=2`).p, 2);
  assert.equal(parseBvUrl(url).p, null);
  for (const p of ["", "0", "-1", "1.0", "1e0", " 1", "01", "Infinity", "9007199254740993", "1&p=2"]) {
    assert.throws(() => parseBvUrl(`${url}?p=${p}`), { code: "INVALID_PART" });
  }
  for (const bad of [url.replace("https:", "http:"), url.replace("www.bilibili.com", "bilibili.com.evil.example"), "https://b23.tv/synthetic", "file:///video"]) {
    assert.throws(() => parseBvUrl(bad), { code: "UNSUPPORTED_SOURCE" });
  }
});

test("missing or mismatched page data falls back to detail API, never requests playback for a list", async () => {
  const calls = [];
  const request = async (endpoint, query) => { calls.push([endpoint, query]); return detail; };
  const info = await loadBilibiliDetails(url, { pageData: {}, request });
  assert.equal(info.selection, "playlist");
  assert.equal(info.pages.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/x/web-interface/view");
  assert.equal((await loadBilibiliDetails(`${url}?p=2`, { request })).selected.cid, "102");
  await assert.rejects(loadBilibiliDetails(`${url}?p=3`, { request }), { code: "INVALID_PART" });
  const single = await loadBilibiliDetails(url, { pageData: { ...detail, pages: [detail.pages[0]] }, request: () => { throw Error("unnecessary request"); } });
  assert.equal(single.selection, "single");
  const wrong = await loadBilibiliDetails(url, { pageData: { ...detail, bvid: "BV2222222222" }, request });
  assert.equal(wrong.bvid, bvid);
});

test("track policy selects explicit H.264/AAC, caps quality without upgrading, rejects missing formats", () => {
  const play = { dash: { video: [video(120, "hev1.1.6.L120"), video(80), video(64), video(32)], audio: [audio, { ...audio, codecs: "ec-3", bandwidth: 999999 }] } };
  assert.equal(selectBilibiliTracks(play).actualSelection.qualityId, "80");
  assert.equal(selectBilibiliTracks(play, { mode: "at_most", qualityId: "74" }).actualSelection.qualityId, "64");
  assert.equal(selectBilibiliTracks(play).tracks[1].codec, "mp4a.40.2");
  assert.equal(selectBilibiliTracks({ dash: { video: [{ ...video("80"), bandwidth: 1 }, { ...video("64"), bandwidth: 9999999 }], audio: [audio] } }).actualSelection.qualityId, "80");
  assert.throws(() => selectBilibiliTracks(play, { mode: "at_most", qualityId: "16" }), { code: "FORMAT_SELECTION_REQUIRED" });
  assert.throws(() => selectBilibiliTracks(play, { mode: "at_most", qualityId: "999" }), { code: "FORMAT_SELECTION_REQUIRED" });
  assert.throws(() => selectBilibiliTracks({ dash: { video: [video(80, "av01.0.04M.08")], audio: [audio] } }), { code: "FORMAT_SELECTION_REQUIRED" });
  assert.throws(() => selectBilibiliTracks({ dash: { video: [video(80)], audio: [{ ...audio, codecs: "" }] } }), { code: "FORMAT_SELECTION_REQUIRED" });
});

test("a site-provided bilivideo backup is preferred without expanding the helper origin allowlist", () => {
  const v = { ...video(16), baseUrl: "https://upos-hz-mirrorakam.akamaized.net/video?private-query", backupUrl: ["https://media.bilivideo.com/provided-backup?exact-query"] };
  const selected = selectBilibiliTracks({ dash: { video: [v], audio: [audio] } });
  assert.equal(selected.tracks[0].url, v.backupUrl[0]);
  assert.equal(selectBilibiliTracks({ dash: { video: [{ ...v, backupUrl: ["https://bilivideo.com.evil.example/invalid"] }], audio: [audio] } }).tracks[0].url, v.baseUrl);
});

test("API errors are classified without leaking site response or URL", async () => {
  for (const [status, businessCode, expected] of [[403, 0, "ACCESS_DENIED"], [401, 0, "LOGIN_REQUIRED"], [200, -101, "LOGIN_REQUIRED"], [200, -10403, "ACCESS_DENIED"], [429, 0, "RATE_LIMITED"], [412, 0, "RATE_LIMITED"], [200, -352, "RATE_LIMITED"]]) {
    await assert.rejects(readBilibiliApi("/x/web-interface/view", { bvid }, { fetchImpl: async () => new Response(JSON.stringify({ code: businessCode, message: "signed-secret", data: detail }), { status }) }), (error) => error.code === expected && !error.message.includes("signed-secret"));
  }
});

test("oversized view metadata uses a bounded part-list fallback and preserves explicit p without playback requests", async () => {
  const calls = []; let cancelled = 0;
  const pages = Array.from({ length: 24 }, (_, index) => ({ page: index + 1, cid: 101 + index, part: `Synthetic P${index + 1}`, duration: 2 }));
  const info = await loadBilibiliDetails(`${url}?p=24`, { request: (endpoint, query) => readBilibiliApi(endpoint, query, { fetchImpl: async value => {
    const parsed = new URL(value); calls.push(parsed.pathname); assert.equal(parsed.searchParams.get("bvid"), bvid);
    if (parsed.pathname === "/x/web-interface/view") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(API_MAX_BYTES + 1)); }, cancel() { cancelled++; } }));
    assert.equal(parsed.pathname, "/x/player/pagelist");
    return new Response(JSON.stringify({ code: 0, data: pages }));
  } }) });
  assert.equal(info.pages.length, 24); assert.equal(info.selected.p, 24); assert.equal(info.selected.cid, "124"); assert.equal(info.bvid, bvid);
  assert.deepEqual(calls, ["/x/web-interface/view", "/x/player/pagelist"]); assert.equal(cancelled, 1);
});

test("part-list fallback retains the size cap and cancels an oversized body", async () => {
  let cancelled = 0;
  await assert.rejects(readBilibiliApi("/x/player/pagelist", { bvid }, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(API_MAX_BYTES + 1)); }, cancel() { cancelled++; } })) }), { code: "API_RESPONSE_TOO_LARGE" });
  assert.equal(cancelled, 1);
});

test("part-list fallback does not mask login/permission failures or accept invalid/out-of-range parts", async () => {
  const calls = [];
  await assert.rejects(loadBilibiliDetails(url, { request: async endpoint => { calls.push(endpoint); throw Object.assign(Error("ACCESS_DENIED"), { code: "ACCESS_DENIED" }); } }), { code: "ACCESS_DENIED" });
  assert.deepEqual(calls, ["/x/web-interface/view"]);
  for (const data of [[], [{ page: 1, cid: 0 }], [{ page: 1, cid: 101 }, { page: 1, cid: 102 }]]) {
    await assert.rejects(loadBilibiliDetails(url, { request: async endpoint => { if (endpoint === "/x/web-interface/view") throw Object.assign(Error("API_RESPONSE_TOO_LARGE"), { code: "API_RESPONSE_TOO_LARGE" }); return data; } }), { code: "INVALID_VIDEO_DETAILS" });
  }
  await assert.rejects(loadBilibiliDetails(`${url}?p=3`, { request: async endpoint => { if (endpoint === "/x/web-interface/view") throw Object.assign(Error("API_RESPONSE_TOO_LARGE"), { code: "API_RESPONSE_TOO_LARGE" }); return detail.pages; } }), { code: "INVALID_PART" });
  await assert.rejects(readBilibiliApi("/x/player/pagelist", { bvid }, { fetchImpl: async () => new Response(JSON.stringify({ code: -101 })) }), { code: "LOGIN_REQUIRED" });
});
