# Bug Fixes & Download History — Design Spec

**Date:** 2026-06-16
**Status:** Approved

## Overview

Two independent workstreams on the DS Video Downloader Chrome extension + Node.js helper:

| Stream | Type | Files Touched |
|--------|------|---------------|
| A: Bug Fixes | 3 fixes (speed, feedback, folder button) | `popup.js`, `popup.css`, `server.js` |
| B: History | New feature (download persistence) | `server.js`, `background.js`, `popup.js` |

**Execution order:** Subagent A first, Subagent B builds on top (both touch `popup.js` and `server.js`).

---

## Stream A: Bug Fixes

### A1 — Parallelize Popup Load (popup.js)

**Current (sequential):**
```js
await loadSettings();
await loadMedia();
await loadHelperStatus();
setInterval(loadHelperStatus, 2000);
```

**Target (parallel):**
```js
await Promise.all([loadSettings(), loadMedia(), loadHelperStatus()]);
setInterval(loadHelperStatus, 2000);
```

### A2 — Targeted DOM Updates (popup.js, renderHelperJobs)

Replace full `helperJobs.textContent = ""` + complete rebuild with incremental updates:
- Maintain `Map<jobId, HTMLElement>` tracking existing job DOM nodes
- On poll tick, iterate live jobs: update existing nodes (status text, progress), create new rows, remove stale rows
- Use `dataset.jobId` on row elements for lookup

### A3 — Optimistic Download Button (popup.js, startDownload)

On click, before any async work:
```js
button.disabled = true;
button.textContent = "Starting...";
statusContainer.hidden = false;
statusContainer.textContent = "Connecting to helper...";
statusContainer.classList.add("is-pending");
```

On success: update with real job info. On failure: re-enable button, show error, remove is-pending.

### A4 — Double-Click Guard (popup.js)

Maintain `const pendingDownloads = new Set()` (URL-based). Check before sending download message. Add on click, remove on response.

### A5 — CSS: .is-pending State (popup.css)

```css
.job-status.is-pending {
  color: var(--cyan);
  animation: pulseRunning 2.4s ease-in-out infinite;
}
```

### A6 — Fix isSafeDownloadPath (server.js:484)

**Current (broken — fails on cross-drive Windows paths):**
```js
function isSafeDownloadPath(value, baseDir = downloadDir) {
  if (!value) return false;
  const relative = path.relative(baseDir, path.resolve(value));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
```

**Target (fixed):**
```js
function isSafeDownloadPath(value, baseDir = downloadDir) {
  if (!value) return false;
  const resolved = path.resolve(value);
  const base = path.resolve(baseDir);
  return resolved.toLowerCase().startsWith(base.toLowerCase());
}
```

Case-insensitive prefix check works on all platforms and handles cross-drive paths correctly.

---

## Stream B: Download History Persistence

### B1 — Helper-Side Persistence (server.js)

- New constant: `JOBS_PATH = path.join(__dirname, "helper-jobs.json")`
- On startup: load jobs from `JOBS_PATH` into the in-memory Map (parse JSON, reconstruct job objects)
- On every job state change (queued→running→completed/failed/cancelled): write all jobs to disk
  - Use atomic write pattern: write to `JOBS_PATH.tmp`, then `rename` to `JOBS_PATH`
  - Persist all jobs regardless of status
- Add `helper-jobs.json` and `helper-jobs.json.tmp` to `.gitignore`
- Export `persistJobs()` function

### B2 — Extension-Side Cache (background.js)

- New message type: `DOWNLOADS_JOB_SYNC` (internal, not user-facing)
- After each successful `getHelperStatus()` call: cache the returned jobs array to `chrome.storage.local` under key `"recentJobs"`
- Cap at 20 most recent entries (sorted by `startedAt` descending)
- On `HELPER_STATUS_GET`, always return cached jobs if helper is offline

### B3 — Merged Job Display (popup.js)

- `loadHelperStatus()` response now includes `cachedJobs` from chrome.storage
- Merge logic:
  - Active jobs (queued/running) from live helper take priority
  - Completed/failed/cancelled from live helper take priority over cache
  - If helper is offline, show cached jobs with "[offline]" indicator
  - Cap popup display to 20 most recent
- Dashboard (`GET /jobs`) already shows full history — no changes needed

### B4 — Dashboard Auto-Shows History

No dashboard changes. `GET /jobs` returns all persisted jobs from the Map. After restart, jobs are loaded from disk, so dashboard naturally shows full history.

---

## Conflict Prevention

Both subagents modify `popup.js` and `server.js`. Strategy:
1. **Subagent A runs first** — implements bug fixes in isolation
2. **Subagent B runs second** — builds history feature on top of fixed code
3. Each subagent works in its own clearly labeled code regions (comments like `// ─── Bug Fix A3: Optimistic button ───`)

## Testing

- A1-A5: Manual testing via extension popup (Chrome-specific APIs can't run in Node)
- A6: Unit test in `tests/server.test.mjs` — add `isSafeDownloadPath` export and test cross-drive paths
- B1: Integration tests — verify job persistence across server restart
- B2-B3: Manual testing via extension popup
