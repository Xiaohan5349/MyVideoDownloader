// MAIN world injection — looks for stream URLs in page JS variables
// and sends them to the content script via CustomEvent.

(function () {
  const EVENT = "ds-video-downloader-found";
  const KNOWN_KEYS = [
    "playerConfig", "player_config", "videoConfig", "video_config",
    "mediaConfig", "media_config", "hlsConfig", "hls_config",
    "pageData", "appData", "streamData", "videoData", "vodData",
    "playerData", "sourceData", "configData", "__INITIAL_STATE__"
  ];

  function scan() {
    const found = [];

    // Check known window keys for stream URLs
    for (const key of KNOWN_KEYS) {
      try {
        const v = window[key];
        if (v === undefined || v === null) continue;
        const s = safeString(v);
        if (s && /\.m3u8\b/i.test(s.slice(0, 50000))) {
          found.push({ source: `window.${key}`, text: s.slice(0, 50000) });
        }
      } catch (_) {}
    }

    // Walk other window properties
    try {
      const seen = new WeakSet();
      for (const key of Object.keys(window).slice(0, 200)) {
        try {
          const v = window[key];
          if (!v || typeof v !== "object" || seen.has(v)) continue;
          seen.add(v);
          const s = safeString(v);
          if (s && /\.m3u8\b/i.test(s.slice(0, 50000))) {
            found.push({ source: `window.${key}`, text: s.slice(0, 50000) });
          }
        } catch (_) {}
      }
    } catch (_) {}

    return found;
  }

  function safeString(v) {
    try { return JSON.stringify(v, (_k, val) => {
      if (typeof val === "function" || typeof val === "symbol") return undefined;
      if (val instanceof Node) return undefined;
      return val;
    }); } catch { return ""; }
  }

  function notify(findings) {
    if (!findings.length) return;
    document.dispatchEvent(new CustomEvent(EVENT, {
      detail: { findings, url: location.href }
    }));
  }

  // Scan after page loads
  setTimeout(() => {
    const first = scan();
    notify(first);
    // Re-scan for lazy-loaded configs
    setTimeout(() => {
      const second = scan();
      const fresh = second.filter((f) =>
        !first.some((i) => i.source === f.source));
      if (fresh.length) notify(fresh);
    }, 3000);
  }, 1500);

})();
