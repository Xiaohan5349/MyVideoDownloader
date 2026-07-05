# Changelog

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
