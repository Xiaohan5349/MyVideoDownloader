# DS Video Downloader

A Chrome MV3 extension for downloading HLS/DASH streaming videos and direct media files. Anime-themed UI with tactical HUD aesthetics inspired by Honkai: Star Rail and Zenless Zone Zero.

> [中文版](README_zh.md)

## How It Works

The extension detects media on pages you visit and sends download requests to a local Node.js helper server. For HLS (`.m3u8`) and DASH (`.mpd`) streams, the helper invokes `ffmpeg` to download and remux the video. For direct files (`.mp4`, `.webm`, etc.), it uses Chrome's built-in download API.

## Requirements

| Component | Requirement |
|-----------|-------------|
| Browser | Chrome or Chromium-based (Edge, Brave, Arc) |
| Runtime | [Node.js](https://nodejs.org/) 20+ for the helper |
| FFmpeg | [ffmpeg](https://ffmpeg.org/download.html) installed and on your PATH |

## Installation

### 1. Load the Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this directory
5. The DS icon should appear in your extensions bar

### 2. Start the Helper

```powershell
npm run helper
```

The helper dashboard opens at [http://127.0.0.1:8765](http://127.0.0.1:8765). You can monitor downloads, check ffmpeg status, and change the download directory from there.

### Helper Management

```powershell
npm run helper:status    # Check if helper is running
npm run helper:stop      # Stop the helper
npm run helper:restart   # Restart the helper
```

## Usage

1. Browse to a page with video content
2. Click the DS Video Downloader icon in your toolbar
3. The popup lists all detected media — click a file to download it
4. For HLS streams, pick a quality variant (1080p, 720p, etc.)
5. Monitor progress on the helper dashboard or in the popup

## Configuration

Set your download directory via the helper dashboard or by creating `helper/helper-settings.json`:

```json
{
  "downloadDir": "C:\\path\\to\\your\\downloads"
}
```

Default: `helper/downloads/` in the project directory.

## What It Supports

- Direct media: `.mp4`, `.webm`, `.mkv`, `.avi`, `.mov`, `.mp3`, `.m4a`, `.flac`, and more
- HLS streams: `.m3u8` playlists with variant selection
- DASH streams: `.mpd` manifests
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
