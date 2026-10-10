import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

// The version is written in four places; a release that bumps only the
// manifest leaves the options page and the service-worker log behind.
test("every version string matches manifest.json", async () => {
  const { version } = JSON.parse(await read("manifest.json"));
  assert.equal(JSON.parse(await read("package.json")).version, version, "package.json");
  assert.match(await read("src/background.js"), new RegExp(`Service worker started v${version.replaceAll(".", "\\.")}"`), "src/background.js startup log");
  assert.match(await read("src/options.html"), new RegExp(`DS Video Downloader v${version.replaceAll(".", "\\.")}<`), "src/options.html");
});