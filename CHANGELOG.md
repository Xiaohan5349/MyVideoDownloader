# Changelog

## v1.6.7 - 2026-08-16

### Fixed
- Network-detected media no longer loses its source when the same URL is later detected by DOM scan.
- MAIN-world discoveries are now tagged as `main` and preserved during Rescan, matching network media.

## v1.6.6 - 2026-08-16

### Fixed
- Rescan now keeps webRequest-discovered media that DOM scanning cannot replay, while replacing DOM-scan results.

## v1.6.5 - 2026-08-16

### Fixed
- Unknown direct sizes now use page and helper probes in parallel, with captured request headers available to the helper fallback.
- Direct-size probes reject HTML/JSON/XML responses instead of reporting login or error page sizes.
- Rescan waits for detected media to reach background storage before refreshing the popup.
- Reloading the same URL now clears stale tab media before new requests are detected.

## v1.6.4 - 2026-08-16

### Fixed
- Direct media with unknown size now gets probed from page context via HEAD / Range when the popup loads.
- Rescan now clears the previous page cache before scanning, so old results are replaced instead of merged.

## v1.6.3 - 2026-08-16

### Fixed
- Removed fuzzy direct-media deduplication that could hide different 360p/720p/1080p MP4 URLs.
- Manifest enrichment now merges into the latest media list inside the same per-tab mutation queue as detection, so new videos detected during inspection are no longer overwritten.
- Stale enrichment results are filtered by the current tab URL, so navigating away cannot revive old-page media.

### Changed
- Direct-media titles display quality/size when available to make duplicate candidates distinguishable.

## v1.6.2 - 2026-08-16

### Fixed
- Concurrent media detections could overwrite each other and lose scan results.
- Service-worker restarts no longer clear cached tab media.
- Re-detecting an HLS stream no longer erases already parsed variants, quality, or size estimates.
- HTTP 206 responses now use Content-Range total size instead of the chunk Content-Length.
- m3u8 URLs with image-looking query parameters are no longer filtered out.
- Popup media loading no longer waits indefinitely for slow manifest inspections.
- BYTERANGE downloads now validate 206 ranges and handle servers that ignore Range.

### Changed
- Duplicate direct-media entries with the same title and size are collapsed in the popup.
- Direct-media titles now show quality and size when available.

## v1.6.1 - 2026-08-16

### Fixed
- Fixed media detected on a previous page remaining in the popup after a full-page navigation to another path on the same site.
- Main-frame navigations now clear the previous tab media cache, and items are filtered by the tracked top-level page URL.

## v1.6.0 - 2026-08-16

### Added
- Paginated `GET /jobs` with `limit` / `offset` and global dashboard stats.
- Dashboard job pagination with Prev / Next controls.
- 5000-record history protection cap; only oldest `File missing` records are pruned.

### Changed
- Popup fetches only the latest 20 helper jobs and uses server-side stats.
- Browser segment concurrency now adapts to device memory (3-6 workers).
- MAIN-world scan serialization is bounded by node count and string length.

### Fixed
- Eliminated simultaneous same-segment upload double-counting with per-job upload locks.
- Fixed cancel/ffmpeg-close persistence ordering so `etaSeconds` and `exitCode` are saved correctly.
- Persistence failures now emit a warning instead of failing silently.

## v1.5.0 - 2026-08-15

### Added
- Added `Clear missing` action to the extension popup and helper dashboard; removes all `File missing` history records.
- Added helper auth token (`GET /auth` + `X-DS-Token`) so web pages cannot use the local helper without the token.

### Changed
- HLS segment downloads now retry failed segments in two additional passes before failing the job.
- Segment fetch retries increased from 3 to 5 with exponential backoff and jitter.
- Browser-fed HLS jobs now use a more lenient stall timeout (3x the regular timeout).
- `tabs.sendMessage` now targets the detecting frame explicitly to avoid duplicate downloads on pages with iframes.

### Fixed
- Fixed popup helper-job list failing to render on initial popup open (`helperJobNodes` TDZ error).
- Fixed DRM-protected stream errors being incorrectly reported as `HELPER_OFFLINE`.
- Fixed malformed percent-encoded URLs crashing media detection.
- Fixed stale version strings in service worker and options page.

## v1.4.6 - 2026-07-18

### Fixed
- Fixed detection of signed, extensionless media routes when the page declares a valid media type such as `video/mp4`.
- Preserved validated media extension metadata across content-script and background normalization passes.

## v1.4.5 - 2026-07-12

### Changed
- Consolidated `Remove file` and `Remove record` into one `Remove` action in the helper dashboard and extension popup.
- Jobs with an existing output now offer `Remove file`, `Remove record`, or `Remove both`.
- Jobs without an output remove their history record directly; active jobs must still be stopped first.
- `Open folder` is now available for any non-active job whose output file exists, including stopped partial downloads.

## v1.4.4 - 2026-07-12

### Changed
- Enabled `Remove record` for completed, failed, stopped, and missing jobs in both the helper dashboard and extension popup.
- Active queued or downloading jobs must still be stopped before their history can be removed.
- Removing a completed record continues to preserve its downloaded media file.

## v1.4.3 - 2026-07-12

### Changed
- Updated the dashboard and popup typography to Bahnschrift with matched Windows UI CJK fallbacks for a cleaner, more architectural flat-transparent interface.
- Kept Cascadia Code for paths, sizes, speeds, and other instrument-style metadata.

## v1.4.2 - 2026-07-12

### Changed
- Made the dashboard queue, rows, summary metrics, service bar, and controls flat transparent so the background remains continuous across the page.
- Applied the same border-led transparent treatment to popup media cards, job rows, tabs, settings, notices, and buttons.
- Reduced the global background tint and panel blur while preserving text contrast and clear hover states.

## v1.4.1 - 2026-07-12

### Changed
- Reworked completed-job actions to show `Source`, `Open folder`, and `Remove file`.
- Failed and missing jobs now show `Source` and `Remove record`; unavailable file actions are hidden.
- Removing a completed file keeps its source history, changes the job to `File missing`, and makes `Remove record` available.
- Redesigned the popup and dashboard around a flat transparent visual system with thin light borders and a muted original landscape background.

### Added
- Added an optimized 44 KB WebP background asset generated specifically for the downloader UI.
- Added a cached helper route for the dashboard background asset.

## v1.4.0 - 2026-07-12

### Added
- Added a separate `Remove record` action for failed and missing jobs in the helper dashboard and extension popup.
- Added `DELETE /jobs/:id/history`; it removes only failed or missing history and never deletes a media file.

### Changed
- Redesigned the extension popup as a compact, neutral download manager with clearer typography, simpler tabs, stable dimensions, and contextual actions.
- Redesigned the helper dashboard with a compact service bar, restrained summary strip, scan-friendly job rows, and responsive action toolbars.
- Removed remote popup fonts, decorative gradients, clipped corners, glow effects, oversized display type, and nonfunctional thumbnail decoration.

## v1.3.2 - 2026-07-12

### Fixed
- Browser-fed HLS downloads now fetch and locally rewrite accessible AES-128 key URIs, including keys whose remote filenames misleadingly end in `.ts`.
- The active content-script path now preserves HLS initialization maps and real segment extensions through the shared tested asset planner.
- Jable-style AES-128 playlists no longer reach ffmpeg with a missing local key file.

### Changed
- The content script and offscreen downloader now share the same HLS asset-planning implementation instead of maintaining divergent key/map/segment logic.

## v1.3.1 - 2026-07-12

### Added
- Added `npm run helper:start` to start the helper as a hidden background process.
- Added per-user Windows auto-start install, status, and removal commands using Task Scheduler.

### Changed
- Background start is idempotent and will not create a duplicate helper process when port 8765 is already active.

## v1.3.0 - 2026-07-12

### Added
- Added bounded retries and 30-second timeouts for browser-fed HLS segment requests.
- Added a helper watchdog that stops jobs after two minutes without real byte or media-time progress.
- Added source-page links to new helper jobs in both the dashboard and extension popup.

### Changed
- Completed job history is reconciled with files on disk whenever jobs are read.
- Deleting an output now retains its history and source link with a clear `File missing` state.
- Helper tests now use isolated settings and history files instead of the user's live helper data.

### Fixed
- Failed HLS segments can no longer be silently ignored and passed to ffmpeg as an incomplete playlist.
- Interrupted jobs loaded after a helper restart are marked failed instead of remaining stuck as downloading.
- File actions now reject sibling paths that merely share the download directory's name prefix.

## v1.2.9 - 2026-07-05

### Added
- **Content-script-driven HLS downloads**: all external HTTP requests (manifest fetch, segment download) now go through the content script which runs in the page context, bypassing Cloudflare TLS fingerprint checks. The helper server only handles local ffmpeg muxing.
- **MAIN world injection** (`src/inject-main.js`): scans page JS variables for stream URLs and sends them to the content script via CustomEvent.
- **Parallel segment fetching**: 8 concurrent segment downloads from the content script context.

### Changed
- Browser-first download strategy: content script fetches manifest + segments, uploads to helper for muxing.
- WebRequest detection is now more selective: skips localhost traffic, analytics, CDN assets, `.ts` segment files, and obfuscated segment patterns.
- Content script no longer scans `<a href>` elements (too many false positives on listing pages).
- Content script skips `.ts` files entirely (they are always HLS segments).
- Stale tab media is cleared on navigation and on service worker startup.
- Media list per tab capped at 30 items.

### Fixed
- Helper ffmpeg no longer passes `-reconnect` flags when muxing local browser-fed playlists.
- Content script fetch no longer uses `credentials: "include"` + custom headers (triggered CORS preflight → "Failed to fetch").
- Internal helper traffic (`127.0.0.1`) no longer pollutes the media list.
- Segment files (`.m4s`, `.jpeg`, numbered/hex-named `.ts`) are filtered from webRequest detection.

## v1.1.4 - 2026-07-04

### Added
- Added a browser-fed HLS fallback path inspired by the lawful architecture pattern in Video DownloadHelper: when the helper cannot fetch an HLS stream directly, an MV3 offscreen document fetches accessible HLS playlists/segments in extension browser context and uploads local bytes to the helper for ffmpeg muxing.
- Added helper `/browser-downloads/*` endpoints for browser-fed jobs, segment uploads, local playlist completion, and failure reporting.
- Added HLS media playlist planning tests for segment/key/init-map discovery and local playlist rewriting.

### Fixed
- HLS DRM detection now keeps a DRM-positive state if a later plain AES-128 key appears in the same playlist.

### Notes
- This does not copy paid entitlement code, call private vendor servers, or bypass DRM/bot protection. It only changes the download path for media URLs the extension can fetch normally.

## v1.1.3 - 2026-07-04

### Fixed
- Added script-text media discovery so HLS/DASH URLs embedded in page JavaScript are detected like richer downloader extensions do.
- Cached captured request headers by URL, not just request id, so DOM/script-discovered media can reuse browser-observed request context later.
- Helper requests now receive safe fallback page context headers (`Accept`, `Referer`, `Origin`, `User-Agent`, `Accept-Language`) when captured headers are missing.
- Variant downloads now look up cached headers for the selected variant URL.
- URL classification now recognizes media extensions embedded in decoded query strings.

## v1.1.2 - 2026-07-04

### Fixed
- Stream variant inspection now falls back to the local helper when extension-side manifest fetch is blocked.
- `180p` HLS quality labels are recognized in shared, content-script, and helper parsing paths.
- Captured `Range` request headers are preserved for helper inspection/download requests.

## v1.1.1 - 2026-06-16

### Fixed
- Folder button opening wrong directory on Windows (replaced fragile `explorer /select,<path>` with `path.dirname()` directory open)
- Race condition in `loadHelperStatus` where 2s poll and post-download refresh could interleave and clear the job list
- Removed `windowsHide: true` from explorer.exe spawn that may prevent window from opening

### Added
- Console log diagnostics in `loadHelperStatus` and `startDownload` for easier debugging
- Null-check guard for `helperJobTemplate` in `renderHelperJobs`

## v1.1.0 - 2026-06-16

### Added
- Download history persistence: `helper-jobs.json` on disk + `chrome.storage` cache, survives helper restarts
- Confirmation dialog before each download
- Click-to-download on media items (no separate download button needed)
- Incremental DOM updates in helper job list for faster UI

### Fixed
- Optimistic download feedback (button disable, "Starting..." text) with double-click guard
- Parallelized popup load (`Promise.all` instead of sequential awaits)
- Cross-drive path safety in `isSafeDownloadPath`
- Folder button now spawns `explorer.exe` directly instead of PowerShell
- Empty download queue state not clearing when jobs appear

### Changed
- Version bump from 1.0.1 to 1.1.0

## v1.0.1 - 2026-06-16

### Added
- Chinese (Simplified) i18n support with ~80 translated messages
- Language switcher in options page
- i18n locale validation tests (8 tests)
- Server HTTP API integration tests (15 tests)
- Vue documentation in `PROJECT.md`

### Fixed
- Version sync between `manifest.json` and `package.json`
- CLAUDE.md file map updated with i18n/options/locale files
- Code duplication sync comments added to `content.js` and `server.js`

## v1.0.0 - Initial Release

### Added
- Chrome MV3 browser extension with popup UI
- Local Node.js helper server on port 8765
- HLS/DASH stream detection and download via ffmpeg
- Direct media download via Chrome downloads API
- Tactical HUD / anime visual theme
- English i18n
- Helper web dashboard at http://127.0.0.1:8765
- 12 unit tests for shared utilities
