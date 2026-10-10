// Extension mode: downloads HLS streams outside any tab, so the download
// keeps going when the source page is frozen, discarded or closed. The
// background installs a session rule that replays the page's
// Referer/Origin/Cookie on these requests; this document only reports which
// hosts it is about to contact so the rule can cover them.
import { startHlsDownload } from "./hls-download.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "offscreen:downloadStream") return;
  startExtensionDownload(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), blocked: Boolean(error?.blocked) }));
  return true;
});

async function startExtensionDownload({ helperUrl, manifestUrl, quality, title, sourcePageUrl, ruleId, filename, downloadDir }) {
  const allowedHosts = new Set();
  const allowUrls = async (urls) => {
    const hosts = [...new Set(urls.map(hostOf).filter((host) => host && !allowedHosts.has(host)))];
    if (!hosts.length || ruleId == null) return;
    for (const host of hosts) allowedHosts.add(host);
    await chrome.runtime.sendMessage({ type: "offscreen:allowHosts", ruleId, hosts });
  };

  const handle = await startHlsDownload({
    helperUrl,
    manifestUrl,
    quality,
    title,
    sourcePageUrl,
    filename,
    downloadDir,
    downloadMode: "extension",
    strict: true,
    credentials: "include",
    allowUrls
  });

  handle.done.then((outcome) => {
    chrome.runtime.sendMessage({ type: "offscreen:finished", jobId: handle.job.id, outcome }).catch(() => {});
  });
  return { ok: true, helperJob: handle.job, resumed: handle.resumed };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}
