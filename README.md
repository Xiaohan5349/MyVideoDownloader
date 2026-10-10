# DS Video Downloader

A Chrome MV3 extension for downloading HLS/DASH streaming videos and direct media files. Tile-based ("bento") interface with automatic light and dark themes.

> [中文版](README_zh.md)

## How It Works

The extension detects media on pages you visit and sends download requests to a local Node.js helper server. For HLS (`.m3u8`) and DASH (`.mpd`) streams, the browser fetches the segments and the helper remuxes them with `ffmpeg`: first from a background offscreen document that replays the page's Referer, Origin and Cookie, and from the page itself if the video server refuses that. DASH streams pair the chosen video quality with an audio track; MPDs the browser cannot handle (live, multi-period, WebM-only) fall back to `ffmpeg` in the helper. Direct files (`.mp4`, `.webm`, etc.) are downloaded by the helper, over 4 parallel connections when the server supports byte ranges; if the helper is offline or the server refuses it, Chrome's own downloader is used instead.

## Requirements

| Component | Requirement |
|-----------|-------------|
| Browser | Chrome or Chromium-based (Edge, Brave, Arc) |
| Runtime | [Node.js](https://nodejs.org/) 20+ for the helper |
| FFmpeg | [ffmpeg](https://ffmpeg.org/download.html) installed and on your PATH (`ffprobe`, which ships with it, reads the resolution of unlabelled videos) |

## Installation

### 1. Load the Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this directory
5. The DS icon should appear in your extensions bar

### 2. Start the Helper

```powershell
npm run helper:start
```

This starts the helper in the background, so the terminal can be closed.

The helper dashboard opens at [http://127.0.0.1:8765](http://127.0.0.1:8765). You can monitor downloads, check ffmpeg status, and change the download directory from there.

### Helper Management

```powershell
npm run helper:start     # Start in the background
npm run helper:status    # Check if helper is running
npm run helper:stop      # Stop the helper
npm run helper:restart   # Restart the helper
npm run helper:autostart:install  # Start automatically after Windows sign-in
npm run helper:autostart:status   # Check auto-start registration
npm run helper:autostart:remove   # Disable auto-start
```

## Usage

1. Browse to a page with video content
2. Click the DS Video Downloader icon in your toolbar
3. The popup lists all detected media, sharpest first and then largest, with quality (e.g. 1080p) and size; "scanning…" shows while the list is still loading, and sizes found later fill in while the popup is open. Click a file to download it
4. For HLS and DASH streams, pick a quality variant (1080p, 720p, etc.)
5. In the download dialog, edit the file name and choose the folder (**Browse…**). The folder starts at the helper's download directory; a different one applies to that download only
6. Monitor progress on the helper dashboard or in the popup. With several downloads running, the Helper tab's progress tile cycles through them (or switch with ‹ ›)
7. HLS and DASH downloads keep running when you switch tabs or close the video page. If one stops (you pressed Stop, stalled, refused by the server, helper restarted), click **Resume** on the job in the popup, or download the same video again within 24 hours, to continue from the segments already downloaded. Direct files downloaded over byte ranges resume the same way
8. If the helper cannot download a direct file (for example HTTP 403), click **Download with browser** in the notice or **Browser** on the failed job to let Chrome download it

## Configuration

Set your download directory via the helper dashboard or by creating `helper/helper-settings.json`:

```json
{
  "downloadDir": "C:\\path\\to\\your\\downloads"
}
```

Default: `helper/downloads/` in the project directory.

## What It Supports

- Direct media: `.mp4`, `.webm`, `.mkv`, `.avi`, `.mov`, `.mp3`, `.m4a`, `.flac`, and more, with parallel and resumable downloads when the server supports byte ranges
- HLS streams: `.m3u8` playlists with variant selection and resumable downloads
- DASH streams: `.mpd` manifests (SegmentTemplate, SegmentList, SegmentBase) with quality selection, automatic audio pairing and resumable downloads
- Automatic media detection from `<video>`, `<audio>`, `<source>`, and `<a>` elements
- Cookie/header forwarding for authenticated streams

## What It Does NOT Support

- DRM-protected streams (Widevine, FairPlay, PlayReady)
- Paywall/login-gated content that requires premium accounts
- Cloudflare or bot-detection bypass
- YouTube or other sites that serve media through proprietary APIs

## Security

The helper binds to `127.0.0.1` — only your local machine can reach it. **Do not** expose it to a public network interface. No authentication is required for localhost access. All downloads run locally; no data is sent to any third party.

## Contributing

Bug reports and pull requests welcome. Please test against the test suite before submitting:

```powershell
npm test
```

## License

MIT — see [LICENSE](LICENSE)
