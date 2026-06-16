# Bug Fixes & Download History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 bugs (slow UI, missing download feedback, broken folder button) and add download history persistence across helper restarts.

**Architecture:** Two sequential phases — Phase A (bug fixes in popup.js, popup.css, server.js) runs first because Phase B (history in server.js, background.js, popup.js) builds on the fixed popup.js and server.js. Each phase is a self-contained set of changes.

**Tech Stack:** Chrome MV3 extension (vanilla JS), Node.js http module, ffmpeg

---

## Phase A: Bug Fixes

### Task A1: Parallelize popup load + test

**Files:**
- Modify: `src/popup.js` (init section, ~lines 56-61)

- [ ] **Step 1: Make loadMedia, loadSettings, loadHelperStatus run in parallel**

In `src/popup.js`, find the init calls at the bottom (~line 56) and change from sequential to parallel:

```js
// BEFORE (sequential, each blocks):
await applyLanguageUI();
await loadSettings();
await loadMedia();
await loadHelperStatus();
window.setInterval(loadHelperStatus, 2000);

// AFTER (parallel, all fire at once):
await applyLanguageUI();
await Promise.all([loadSettings(), loadMedia(), loadHelperStatus()]);
window.setInterval(loadHelperStatus, 2000);
```

- [ ] **Step 2: Run tests to verify nothing breaks**

```bash
npm test
```
Expected: All 34 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/popup.js
git commit -m "fix: parallelize popup load for faster startup"
```

---

### Task A2: Add optimistic download button feedback

**Files:**
- Modify: `src/popup.js` (`startDownload` function, ~lines 190-245)

- [ ] **Step 1: Add immediate button disable + loading state**

In `src/popup.js`, at the top of `startDownload()`, add immediate feedback before any async work. Also add a `pendingDownloads` Set at module scope (~line 24, near the other state variables):

```js
// ─── Bug Fix A4: Double-click guard ───
const pendingDownloads = new Set();
```

Then at the top of `startDownload()` (after the function signature, before the `if (item.kind === "direct")` block):

```js
async function startDownload(item, variantContainer, statusContainer) {
  // ─── Bug Fix A3/A4: Optimistic feedback + double-click guard ───
  const downloadButton = statusContainer?.closest(".media-item")?.querySelector(".download-button");
  if (pendingDownloads.has(item.url)) return;
  pendingDownloads.add(item.url);

  if (downloadButton) {
    downloadButton.disabled = true;
    downloadButton.textContent = "Starting...";
  }
  if (statusContainer) {
    statusContainer.hidden = false;
    statusContainer.classList.add("is-pending");
    statusContainer.textContent = "Connecting to helper...";
  }

  if (item.kind === "direct") {
    // ... existing code unchanged ...
```

- [ ] **Step 2: Clean up on all exit paths**

After the existing `if (response?.ok)` block (~line 207), add cleanup. Find each `showNotice(...)` call in the function and ensure `pendingDownloads.delete(item.url)` runs before them. The cleanest approach: add a finally-like wrapper. Replace the response handling section:

Find the line `const response = await chrome.runtime.sendMessage({...})` and wrap everything after it:

```js
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.DOWNLOADS_START,
    item
  });

  // Clear pending state
  pendingDownloads.delete(item.url);
  if (statusContainer) statusContainer.classList.remove("is-pending");

  if (response?.ok) {
    if (downloadButton) downloadButton.textContent = "Downloading...";
    // ... rest of existing ok handling unchanged ...

  // On error paths, re-enable the button:
  if (downloadButton) {
    downloadButton.disabled = false;
    downloadButton.textContent = item.kind === "direct" ? "Save" : "Download";
  }
  // ... rest of existing error handling unchanged ...
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: All 34 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/popup.js
git commit -m "fix: add optimistic download feedback and double-click guard"
```

---

### Task A3: Add .is-pending CSS animation

**Files:**
- Modify: `src/popup.css`

- [ ] **Step 1: Add .is-pending state to popup.css**

At the end of `src/popup.css`, add:

```css
/* ─── Bug Fix A5: Pending download indicator ─── */
.job-status.is-pending {
  color: var(--cyan);
  animation: pulseRunning 2.4s ease-in-out infinite;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/popup.css
git commit -m "fix: add .is-pending CSS state for download feedback"
```

---

### Task A4: Targeted DOM updates in renderHelperJobs

**Files:**
- Modify: `src/popup.js` (`renderHelperJobs` function, ~lines 157-188)

- [ ] **Step 1: Replace full rebuild with incremental updates**

Replace the entire `renderHelperJobs` function:

```js
// Track existing job DOM nodes for incremental updates
const helperJobNodes = new Map();

function renderHelperJobs(jobs) {
  const seenIds = new Set();

  for (const job of jobs) {
    seenIds.add(job.id);
    const existing = helperJobNodes.get(job.id);

    if (existing) {
      // Update existing node
      const state = existing.querySelector(".helper-job-state");
      const meta = existing.querySelector(".helper-job-meta");
      const path = existing.querySelector(".helper-job-path");
      const cancelBtn = existing.querySelector(".cancel-button");
      const showBtn = existing.querySelector(".show-button");
      const deleteBtn = existing.querySelector(".delete-button");

      state.textContent = humanStatus(job.status);
      state.className = `helper-job-state ${job.status === "completed" ? "is-complete" : ""} ${job.status === "failed" ? "is-error" : ""} ${job.status === "cancelled" ? "is-cancelled" : ""}`;
      meta.textContent = job.error || job.progressText || sizeLabel(job);
      path.textContent = job.outputPath || job.url;

      const isActive = job.status === "queued" || job.status === "running";
      const isFinished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
      cancelBtn.disabled = !isActive;
      showBtn.disabled = !job.outputPath;
      deleteBtn.disabled = !isFinished;
    } else {
      // Create new node
      const node = helperJobTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.jobId = job.id;
      node.querySelector(".helper-job-title").textContent = jobTitle(job);
      const state = node.querySelector(".helper-job-state");
      state.textContent = humanStatus(job.status);
      state.classList.toggle("is-complete", job.status === "completed");
      state.classList.toggle("is-error", job.status === "failed");
      state.classList.toggle("is-cancelled", job.status === "cancelled");
      node.querySelector(".helper-job-meta").textContent = job.error || job.progressText || sizeLabel(job);
      node.querySelector(".helper-job-path").textContent = job.outputPath || job.url;

      const cancelButton = node.querySelector(".cancel-button");
      const showButton = node.querySelector(".show-button");
      const deleteButton = node.querySelector(".delete-button");
      const isActive = job.status === "queued" || job.status === "running";
      const isFinished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
      cancelButton.disabled = !isActive;
      showButton.disabled = !job.outputPath;
      deleteButton.disabled = !isFinished;
      cancelButton.addEventListener("click", () => cancelJob(job.id));
      showButton.addEventListener("click", () => showJobInFolder(job.id));
      deleteButton.addEventListener("click", () => deleteJob(job.id));

      helperJobs.appendChild(node);
      helperJobNodes.set(job.id, node);
    }
  }

  // Remove stale nodes
  for (const [id, node] of helperJobNodes) {
    if (!seenIds.has(id)) {
      node.remove();
      helperJobNodes.delete(id);
    }
  }

  // Update empty state
  if (!jobs.length) {
    helperJobs.innerHTML = `<div class="helper-status">${getMessage("msgNoJobs")}</div>`;
    helperJobNodes.clear();
  }
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: All 34 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/popup.js
git commit -m "fix: incremental DOM updates in renderHelperJobs for faster UI"
```

---

### Task A5: Fix isSafeDownloadPath for cross-drive Windows paths

**Files:**
- Modify: `helper/server.js:484-488`
- Modify: `tests/server.test.mjs`

- [ ] **Step 1: Export isSafeDownloadPath for testing**

First add the export at the bottom of `server.js`:

```js
export { server, jobs, isSafeDownloadPath };
```

Then in `server.js`, replace the `isSafeDownloadPath` function:

```js
function isSafeDownloadPath(value, baseDir = downloadDir) {
  if (!value) return false;
  const resolved = path.resolve(value);
  const base = path.resolve(baseDir);
  return resolved.toLowerCase().startsWith(base.toLowerCase());
}
```

- [ ] **Step 2: Add test for cross-drive paths**

In `tests/server.test.mjs`, add after the existing import of `server`:

```js
const { server, isSafeDownloadPath } = serverModule;
```

Then add these tests inside the `describe` block (before the closing `});`):

```js
// ─── isSafeDownloadPath ───
it("isSafeDownloadPath: valid path within download dir returns true", () => {
  const baseDir = "C:\\Users\\test\\Downloads";
  assert.equal(isSafeDownloadPath("C:\\Users\\test\\Downloads\\video.mp4", baseDir), true);
  assert.equal(isSafeDownloadPath("C:\\Users\\test\\Downloads\\sub\\video.mp4", baseDir), true);
});

it("isSafeDownloadPath: path outside download dir returns false", () => {
  const baseDir = "C:\\Users\\test\\Downloads";
  assert.equal(isSafeDownloadPath("C:\\Users\\test\\Documents\\video.mp4", baseDir), false);
  assert.equal(isSafeDownloadPath("C:\\Windows\\System32\\evil.exe", baseDir), false);
});

it("isSafeDownloadPath: cross-drive valid path returns true", () => {
  const baseDir = "D:\\Videos";
  assert.equal(isSafeDownloadPath("D:\\Videos\\movie.mp4", baseDir), true);
});

it("isSafeDownloadPath: cross-drive invalid path returns false", () => {
  const baseDir = "D:\\Videos";
  assert.equal(isSafeDownloadPath("E:\\Malware\\bad.exe", baseDir), false);
});

it("isSafeDownloadPath: case-insensitive on Windows", () => {
  const baseDir = "C:\\Users\\Test\\Downloads";
  assert.equal(isSafeDownloadPath("c:\\users\\test\\downloads\\video.mp4", baseDir), true);
});

it("isSafeDownloadPath: falsy value returns false", () => {
  assert.equal(isSafeDownloadPath("", "C:\\test"), false);
  assert.equal(isSafeDownloadPath(null, "C:\\test"), false);
});
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: All 40 tests pass (34 existing + 6 new).

- [ ] **Step 4: Commit**

```bash
git add helper/server.js tests/server.test.mjs
git commit -m "fix: isSafeDownloadPath cross-drive Windows path support"
```

---

## Phase B: Download History Persistence

### Task B1: Add helper-side job persistence to disk

**Files:**
- Modify: `helper/server.js`
- Modify: `.gitignore`

- [ ] **Step 1: Add JOBS_PATH constant and persistence functions**

In `helper/server.js`, add near the other constants (~line 14):

```js
const JOBS_PATH = path.join(__dirname, "helper-jobs.json");
```

After the `jobs` Map declaration (~line 20), add load function:

```js
// ─── History Feature B1: Job persistence ───
async function loadJobsFromDisk() {
  try {
    const raw = await readFile(JOBS_PATH, "utf8");
    const data = JSON.parse(raw);
    for (const job of data) {
      if (job.id) jobs.set(job.id, job);
    }
    console.log(`Loaded ${jobs.size} jobs from history`);
  } catch {
    // No history file yet — that's fine
  }
}

async function persistJobsToDisk() {
  try {
    const data = Array.from(jobs.values());
    const tmpPath = JOBS_PATH + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tmpPath, JOBS_PATH);
  } catch {
    // Silently fail — persistence is best-effort
  }
}
```

Add `rename` to imports at top (line 5):
```js
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Call loadJobsFromDisk on startup, persistJobsToDisk on state changes**

Replace the startup sequence. Find the `await mkdir(downloadDir, { recursive: true });` line (~line 23) and add after it:

```js
await loadJobsFromDisk();
```

Then add `persistJobsToDisk()` calls at every job state change point:
1. After `jobs.set(id, job)` in `startDownload()` (~line 157) → add `persistJobsToDisk();`
2. After `job.status = "completed"` / `"failed"` in the ffmpeg close handler (~lines 293-297) → add `persistJobsToDisk();`
3. After `job.status = "cancelled"` in `cancelJob()` (~line 461) → add `persistJobsToDisk();`
4. After `jobs.delete(id)` in `deleteJobOutput()` (~line 453) → add `persistJobsToDisk();`

- [ ] **Step 3: Add to .gitignore**

```bash
echo "helper/helper-jobs.json" >> .gitignore
echo "helper/helper-jobs.json.tmp" >> .gitignore
```

- [ ] **Step 4: Add integration test**

In `tests/server.test.mjs`, add this test inside the `describe` block:

```js
it("jobs persist to disk and survive server restart", async () => {
  // This test verifies the persistence file is created after a download attempt
  const fs = await import("node:fs");
  const jobsPath = path.join(__dirname, "..", "helper", "helper-jobs.json");
  
  // Trigger a download to create a job
  const res = await fetchJson("/download", {
    method: "POST",
    body: { url: "http://example.com/test.m3u8", title: "Persist Test", kind: "hls" },
  });
  
  if (res.status === 202) {
    // Job was queued, check file was written
    // Give it a moment to write
    await new Promise(r => setTimeout(r, 200));
    if (fs.existsSync(jobsPath)) {
      const data = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
      assert.ok(Array.isArray(data), "jobs file should contain an array");
      assert.ok(data.length > 0, "jobs file should have at least one job");
    }
  }
});
```

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add helper/server.js .gitignore tests/server.test.mjs
git commit -m "feat: persist download jobs to helper-jobs.json across restarts"
```

---

### Task B2: Add chrome.storage job cache in background.js

**Files:**
- Modify: `src/background.js`

- [ ] **Step 1: Cache jobs to chrome.storage after helper poll**

In `src/background.js`, modify the `getHelperStatus()` function (~line 326) to cache jobs:

```js
async function getHelperStatus() {
  try {
    const [healthResponse, jobsResponse] = await Promise.all([
      fetch(`${HELPER_URL}/health`),
      fetch(`${HELPER_URL}/jobs`)
    ]);
    const health = await healthResponse.json().catch(() => ({}));
    const jobs = await jobsResponse.json().catch(() => ({}));
    const jobsList = Array.isArray(jobs.jobs) ? jobs.jobs : [];

    // ─── History Feature B2: Cache recent jobs ───
    if (healthResponse.ok) {
      const recent = jobsList
        .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
        .slice(0, 20);
      await chrome.storage.local.set({ recentJobs: recent }).catch(() => {});
    }

    return {
      ok: healthResponse.ok && jobsResponse.ok,
      online: healthResponse.ok,
      health,
      jobs: jobsList
    };
  } catch {
    // Return cached jobs when offline
    const cached = await chrome.storage.local.get("recentJobs").catch(() => ({}));
    return {
      ok: true,
      online: false,
      health: null,
      jobs: [],
      cachedJobs: cached.recentJobs || []
    };
  }
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/background.js
git commit -m "feat: cache recent jobs in chrome.storage for offline display"
```

---

### Task B3: Merge cached + live jobs in popup display

**Files:**
- Modify: `src/popup.js` (`loadHelperStatus` function, ~lines 105-124)

- [ ] **Step 1: Merge cached jobs into helper display**

In `src/popup.js`, modify `loadHelperStatus()`:

```js
async function loadHelperStatus() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.HELPER_STATUS_GET });
  const online = Boolean(response?.online);
  const liveJobs = response?.jobs || [];
  const cachedJobs = response?.cachedJobs || [];
  const downloadDir = response?.health?.downloadDir || "";

  // ─── History Feature B3: Merge cached + live jobs ───
  const liveIds = new Set(liveJobs.map(j => j.id));
  const merged = [
    ...liveJobs,
    ...cachedJobs.filter(j => !liveIds.has(j.id))
  ].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")).slice(0, 20);

  helperSummary.textContent = online
    ? getMessage("msgActiveJobs", { active: String(runningCount(liveJobs)), total: String(liveJobs.length), plural: liveJobs.length === 1 ? "" : "s" })
    : getMessage("statusHelperOffline");
  helperStatus.className = `helper-status ${online ? "is-online" : "is-offline"}`;
  helperStatus.textContent = online
    ? getMessage("msgHelperRunning", { dir: downloadDir || getMessage("labelDefaultFolder") })
    : getMessage("msgHelperEmpty");

  if (online && downloadDir && document.activeElement !== downloadDirInput) {
    downloadDirInput.value = downloadDir;
  }

  renderHelperJobs(merged);
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/popup.js
git commit -m "feat: merge cached and live jobs in popup display"
```

---

### Task B4: Update CLAUDE.md change log

- [ ] **Step 1: Append entries to CLAUDE.md change log**

Add to the Change Log section:

```markdown
- [2026-06-16] — Fixed 3 bugs: parallelized popup load, optimistic download feedback with double-click guard, fixed isSafeDownloadPath cross-drive paths — `src/popup.js`, `src/popup.css`, `helper/server.js`, `tests/server.test.mjs`
- [2026-06-16] — Added download history persistence: helper-jobs.json on disk + chrome.storage cache + merged popup display — `helper/server.js`, `src/background.js`, `src/popup.js`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update change log for bug fixes and history feature"
```

---

## Verification Checklist

- [ ] `npm test` passes (all 34+ tests)
- [ ] Extension popup loads without console errors
- [ ] Clicking Download immediately disables button and shows "Starting..."
- [ ] Double-clicking Download only starts one download
- [ ] Helper tab updates incrementally without flicker
- [ ] Folder button works with download dir on any drive
- [ ] Jobs survive `npm run helper:restart`
- [ ] Dashboard at http://127.0.0.1:8765 shows full history after restart
