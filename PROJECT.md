# DS Video Downloader — Project Overview

## What It Is

A Chrome MV3 browser extension + local Node.js helper for downloading HLS/DASH streaming videos and direct media files from any website. Forked and customized from `cleanVideoDownloader` (v0.1.30).

## Quick Start

```powershell
# Start the local helper (required for HLS/DASH downloads)
npm run helper

# Check if it's running
npm run helper:status

# Stop it
npm run helper:stop

# Run tests
npm test
```

- **Extension popup**: Click the extension icon in Chrome toolbar
- **Helper dashboard**: http://127.0.0.1:8765
- **Options page**: Right-click extension → Options (or `src/options.html`)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension (MV3)                    │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ popup.html   │  │ background.js│  │ content.js       │  │
│  │ popup.css    │  │ (service     │  │ (page scanner,   │  │
│  │ popup.js     │  │  worker,     │  │  runs in every   │  │
│  │ i18n.js      │  │  message     │  │  tab, detects    │  │
│  │ (UI layer)   │  │  router)     │  │  video/audio)    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │            │
│         └─────────┬───────┘                    │            │
│                   │ chrome.runtime.sendMessage │            │
│                   │                            │            │
│  ┌────────────────┴────────────────────────────┴──────────┐ │
│  │                    shared.js                            │ │
│  │  (MESSAGE constants, classifyMedia, parseHlsManifest,  │ │
│  │   parseDashManifest, sanitizeFilename, etc.)           │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────────┐
│  │ options.html + options.js  (language settings page)      │
│  └──────────────────────────────────────────────────────────┘
│                                                             │
│  ┌──────────────────────────────────────────────────────────┐
│  │ _locales/en/messages.json  +  _locales/zh_CN/            │
│  │ (Chrome i18n — used for manifest strings & popup labels)│
│  └──────────────────────────────────────────────────────────┘
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTP fetch to 127.0.0.1:8765
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Local Helper (Node.js)                      │
│                                                             │
│  helper/server.js  (plain http module, NO Express)           │
│  Port: 8765  Host: 127.0.0.1                                │
│                                                             │
│  Endpoints:                                                 │
│  GET  /              → Dashboard HTML (inline CSS/JS)        │
│  GET  /health        → { ok, ffmpeg, downloadDir }          │
│  GET  /jobs          → List all download jobs                │
│  POST /download      → Start ffmpeg HLS/DASH download        │
│  POST /inspect       → Probe manifest URLs for size/variants │
│  POST /settings      → Change download directory             │
│  POST /pick-folder   → Windows folder picker dialog          │
│  DELETE /jobs/:id    → Delete downloaded file                │
│  POST /jobs/:id/cancel → Cancel running download             │
│  POST /jobs/:id/show → Show file in Explorer                 │
│                                                             │
│  Dependencies: ffmpeg (must be on PATH)                      │
│  Config file: helper/helper-settings.json (auto-created)     │
└─────────────────────────────────────────────────────────────┘
```

## File Map (Complete)

| File | Lines | Purpose |
|------|-------|---------|
| `manifest.json` | 43 | Chrome MV3 manifest, i18n, permissions, options page |
| `package.json` | 13 | npm scripts for helper lifecycle & tests |
| `.gitignore` | 14 | Excludes node_modules, downloads, test-media, logs, CLAUDE.md |
| **Extension Source** | | |
| `src/background.js` | 513 | Service worker: message routing, network detection, HLS parsing, header capture, helper API calls |
| `src/content.js` | 183 | Page scanner: finds `<video>`, `<audio>`, `<source>`, `<a>` elements with media URLs |
| `src/shared.js` | 287 | Shared constants (MESSAGE, DEFAULT_SETTINGS), media classification, HLS/DASH parsing, filename sanitization |
| `src/popup.html` | — | Extension popup markup with Google Fonts, tab panels, templates |
| `src/popup.css` | ~776 | Tactical HUD anime theme: CSS variables, glass panels, star fields, magic circle, scan lines |
| `src/popup.js` | 512 | Popup logic: tab scanning, media list rendering, download initiation, helper job polling, settings |
| `src/i18n.js` | 67 | i18n module: locale loading, message interpolation, `data-i18n` attribute binding, language persistence |
| `src/options.html` | 68 | Full-page settings UI with language selector |
| `src/options.js` | 22 | Options page logic: language switching and persistence |
| **Locales** | | |
| `_locales/en/messages.json` | 90 | English strings for manifest + popup UI (~80 messages) |
| `_locales/zh_CN/messages.json` | 90 | Chinese (Simplified) translations |
| **Helper** | | |
| `helper/server.js` | 1820 | HTTP server + inline dashboard HTML/CSS/JS + ffmpeg download engine + manifest inspection + segment size probing |
| `helper/pick-folder.ps1` | — | PowerShell script for native Windows folder picker dialog |
| **Scripts** | | |
| `scripts/helper-control.ps1` | 66 | PowerShell: start/stop/restart/status for the helper via port 8765 |
| **Tests** | | |
| `tests/shared.test.mjs` | 110 | Node test runner tests for shared.js (12 tests covering classifyMedia, sanitizeFilename, parseHlsManifest, parseDashManifest, mergeSettings, inferQualityLabel) |
| **Icons** | | |
| `icons/icon-{16,32,48,128}.png` | — | Extension icons (hexagonal gacha token design) |

## Data Flow

### 1. Media Detection
```
Page loads → content.js observes DOM (MutationObserver)
  → Scans <video>, <audio>, <source>, <a> elements
  → Classifies URLs (direct/HLS/DASH)
  → Sends MESSAGE.MEDIA_ADD_DETECTED to background.js
  → background.js stores in chrome.storage.local by tab ID
```

### 2. Network Detection (supplementary)
```
chrome.webRequest.onHeadersReceived fires for media/xhr/other
  → background.js checks Content-Type header
  → Captures request headers from onBeforeSendHeaders
  → Classifies and stores alongside DOM-detected media
```

### 3. Download Flow
```
User clicks "Download" in popup
  → popup.js sends MESSAGE.DOWNLOADS_START to background.js
  → Direct media: uses chrome.downloads API (with optional permission)
  → HLS/DASH: POSTs to helper at /download with URL + headers
    → Helper spawns ffmpeg, tracks progress via stderr parsing
    → Popup polls job status every 1s via /jobs/:id
```

### 4. Stream Inspection (for variant selection)
```
background.js fetches manifest URL (with captured headers)
  → Parses HLS (#EXT-X-STREAM-INF) or DASH (<Representation>)
  → Enriches HLS child playlists with estimated sizes
  → Also POSTs to helper /inspect for server-side probing
  → Merges results, shows quality variants in popup
```

## Key Design Decisions

1. **Port 8765** — chosen for uniqueness, avoiding collisions
2. **No Express** — helper uses raw Node `http` module, zero npm dependencies
3. **MV3 service worker** — uses ES `import` + `"type": "module"` (not background page)
4. **Self-contained dashboard** — `server.js` renders inline HTML/CSS/JS, no external files
5. **Security** — host binds `127.0.0.1` only, no auth, cookie values sanitized (CloudFlare clearance stripped)
6. **Header capture** — only 6 header types forwarded (accept, origin, referer, user-agent, accept-language, cookie), max 500 entries in ring buffer
7. **Filename format**: `{title}-{sha1_8chars}.mp4` (helper), `{title}.{ext}` (direct downloads)
8. **Anime/Tactical HUD visual theme** — high-contrast, glass panels, corner brackets, neon accents, GPU-composited animations, `prefers-reduced-motion` guard

## Known Code Duplication (Intentional)

- **`content.js` duplicates functions from `shared.js`**: MV3 content scripts can't use static ES `import` from the extension bundle. The duplicated functions are `classifyMedia`, `detectExtension`, `normalizeMediaItem`, `inferQualityLabel`, `DIRECT_EXTENSIONS`.
- **`helper/server.js` duplicates functions from `shared.js`**: The helper is a standalone Node.js process and can't import extension source. Duplicated: `estimateBytes`, `fallbackBandwidthForQuality`, `inferQualityLabel`, `qualityLabel`, `readAttribute`, `resolveUrl`, `formatBytes`, `formatDuration`, `parseHlsVariants`.

## Tests

- **Framework**: Node.js built-in test runner (`node --test`)
- **Coverage**: Only `shared.js` is tested (12 tests)
- **Not tested**: `background.js`, `content.js`, `popup.js`, `i18n.js`, `server.js`
- **Run**: `npm test`

## Version Inconsistency

- `manifest.json`: version `1.0.1`
- `package.json`: version `1.0.0`
- These should be synced — `manifest.json` version is what Chrome displays.

## Development Workflow

1. Make changes to `src/` files (extension) or `helper/server.js` (helper)
2. Reload extension at `chrome://extensions/` (click refresh icon)
3. Restart helper if changed: `npm run helper:restart`
4. Run tests: `npm test`
5. For CSS changes, just reload the popup or helper dashboard page

## Key Environment Variables (Helper)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 8765 | Helper listen port |
| `HOST` | 127.0.0.1 | Bind address |
| `DOWNLOAD_DIR` | `helper/downloads/` | Download output directory |
| `SIZE_PROBE_LIMIT` | 1500 | Max segments to probe for exact size |
| `SIZE_PROBE_CONCURRENCY` | 8 | Parallel HEAD requests for segment sizing |
| `SIZE_PROBE_TIMEOUT_MS` | 5000 | Per-segment probe timeout |

## Limitations & Known Issues

1. **No test coverage for background, content, popup, or server** — the test suite only covers `shared.js`
2. **Windows-only folder picker** — `pick-folder.ps1` only works on Windows; server returns 501 on other platforms
3. **ffmpeg must be on PATH** — no bundled ffmpeg; user must install separately
4. **No download queue** — multiple downloads run concurrently (one ffmpeg per request)
5. **No download resume** — failed/cancelled downloads can't be resumed
6. **Inline dashboard** — the helper dashboard CSS is duplicated from popup theme, making visual updates require changes in two places
7. **CLAUDE.md in .gitignore** — project memory file is intentionally not versioned
8. **Content script has no access to shared.js exports** — manual synchronization needed when shared.js functions change

## Dependencies

- **Browser**: Chrome/Edge (MV3 compatible)
- **Helper**: Node.js 18+ (uses `fetch`, `crypto.randomUUID`, ES modules)
- **External tool**: ffmpeg (for HLS/DASH stream assembly)
- **Fonts**: Google Fonts CDN — M PLUS Rounded 1c, M PLUS 1 Code, Rajdhani, Bebas Neue
- **npm packages**: None (zero runtime dependencies)
