# AGENTS.md — DS Video Downloader Project Rules

## Project overview
Chrome MV3 extension + local Node helper for downloading HLS/DASH streams and direct media files.
Content-script HLS downloads are the primary path for Cloudflare-protected sites; the helper only
runs ffmpeg locally. Keep the helper bound to 127.0.0.1.

## Hard constraints
- Do NOT modify the parent `cleanVideoDownloader/` reference project.
- Keep `manifest.json` and `package.json` versions in sync.
- `helper/helper-jobs.json`, `helper/helper-settings.json`, and `helper/downloads/*` are runtime
  data and must never be committed.
- `src/content.js` and `helper/server.js` contain duplicated shared logic (SYNC-POINT comments).
  When shared parsing/classification logic changes, update all three copies.
- The content script must not use custom headers or `credentials: "include"` for CDN fetches;
  that triggers CORS preflight and breaks protected sites. Safe single `Range` headers are OK.

## Review rules (learned from v1.5.0 review failures)
1. **Trace every new error code end-to-end.**
   For each new error: who produces it, every consumer, fallback behavior, final job state, and
   whether the user gets an actionable message. Add a test for the unhappy path.
2. **Guard closure.** Every new guard must answer: what happens to the job after it fires, who
   notifies the client, and what UI state remains. Never leave a job `running` after a rejected
   request.
3. **Worst-case math before changing timeouts/retries/stalls.**
   Compute total retry time versus `sweepStalledJobs` for both helper and browser jobs. Do not
   let a legitimate retry sequence outlive the stall timer.
4. **Audit UI state machines.** Every click path must handle promise resolve, reject, and early
   return: pending guards, button/status text, hidden state, and user feedback. Remove DOM nodes
   that later code still queries.
5. **Performance budget.** No full history rewrite per segment upload; throttle persistence. Do
   not buffer whole uploads in memory; stream to disk. Keep concurrent `ArrayBuffer` usage bounded.
6. **HLS/DASH spec coverage.** Check parsers against tags such as `#EXT-X-BYTERANGE`,
   `#EXT-X-MAP`, `#EXT-X-KEY`, `#EXT-X-SESSION-KEY`, and DRM markers before changing stream code.
7. **Idempotency.** Retried uploads must not double-count `receivedSegments` or `downloadedBytes`.
8. **Security boundary.** The local helper token prevents webpage CSRF, not local-process access.
   Never bind the helper to non-loopback interfaces. Redact signed URLs from logs in release builds.
9. **Fresh-eyes review.** After non-trivial changes, open a fresh session or use another model to
   review the diff before declaring the work done.
