# Changelog

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
