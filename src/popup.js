import { MESSAGE, ffmpegCommand, highlightRanges, jobProgressFraction, sanitizeFilename, siteKey, sortMediaByQuality } from "./shared.js";
import { getMessage, getUserLanguage, setUserLanguage, applyLanguageUI } from "./i18n.js";
import { bilibiliFileName, parseBvUrl } from "./bilibili.js";

const list = document.querySelector("#mediaList");
const notice = document.querySelector("#notice");
const template = document.querySelector("#mediaItemTemplate");
const helperJobTemplate = document.querySelector("#helperJobTemplate");
const rescanButton = document.querySelector("#rescanButton");
const mediaCount = document.querySelector("#mediaCount");
const filterSummary = document.querySelector("#filterSummary");
const helperSummary = document.querySelector("#helperSummary");
const helperStatus = document.querySelector("#helperStatus");
const helperJobs = document.querySelector("#helperJobs");
const refreshHelperButton = document.querySelector("#refreshHelperButton");
const clearMissingButton = document.querySelector("#clearMissingButton");
const jobSearchInput = document.querySelector("#jobSearchInput");
const jobSiteSelect = document.querySelector("#jobSiteSelect");
const kindFilter = document.querySelector("#kindFilter");
const minSizeSelect = document.querySelector("#minSizeSelect");
const showUnsupportedInput = document.querySelector("#showUnsupportedInput");
const downloadDirInput = document.querySelector("#downloadDirInput");
const saveDownloadDirButton = document.querySelector("#saveDownloadDirButton");
const pickDownloadDirButton = document.querySelector("#pickDownloadDirButton");
const langSelector = document.querySelector("#langSelector");
const mediaTabCount = document.querySelector("#mediaTabCount");
const helperTabCount = document.querySelector("#helperTabCount");
const mediaCountNum = document.querySelector("#mediaCountNum");
const runTile = document.querySelector("#runTile");
const runTitle = document.querySelector("#runTitle");
const runValue = document.querySelector("#runValue");
const runNav = document.querySelector("#runNav");
const runPos = document.querySelector("#runPos");
const runDots = document.querySelector("#runDots");
const mediaPanel = document.querySelector("#mediaPanel");
const scanLabel = document.querySelector("#scanLabel");
const biliTile = document.querySelector("#biliTile");
const biliTitle = document.querySelector("#biliTitle");
const biliParts = document.querySelector("#biliParts");
const biliSelectAll = document.querySelector("#biliSelectAll");
const biliInvert = document.querySelector("#biliInvert");
const biliClear = document.querySelector("#biliClear");
const biliPick = document.querySelector("#biliPick");
const biliSummary = document.querySelector("#biliSummary");
const biliFocus = document.querySelector("#biliFocus");
const biliQuality = document.querySelector("#biliQuality");
const biliDownload = document.querySelector("#biliDownload");
const biliStatus = document.querySelector("#biliStatus");
const resumeAllButton = document.querySelector("#resumeAllButton");
const siteDirList = document.querySelector("#siteDirList");

let activeTab = null;
let settings = null;
const jobPollers = new Map();
const pendingDownloads = new Set();
const helperJobNodes = new Map();
let statusLoading = false;
let statusPending = false;
let scansRunning = 0;
let helperOnline = false;
let helperDownloadDir = "";
// media URL -> { node, variants, status, item } of the rendered item
const mediaNodes = new Map();
// Media URL -> { count, at } of probes this popup asked for (scan or
// MEDIA_ENRICH). An item still without a size is retried a few times: its
// first probe may have run before the page's cookies/referer were captured.
const enrichAttempts = new Map();
const ENRICH_RETRY_MS = 5000;
const ENRICH_MAX_ATTEMPTS = 3;
let mediaRefreshTimer = null;
let refreshAfterScan = false;
// Run tile carousel: which active job is shown, and since when.
const RUN_ROTATE_MS = 4000;
let runJobId = null;
let runShownAt = 0;
let lastRunJobs = [];
// Job search: the helper filters its whole history; typing waits a moment.
const JOB_SEARCH_DELAY_MS = 250;
let jobSearchTimer = null;
let renderedJobQuery = "";
// Site filter options as last rendered, so the 2 s poll rebuilds them only on change.
let renderedSites = "";
// Media type filter ("all" or an item.kind); the chips show only when the
// page has more than one kind.
const KIND_ORDER = ["hls", "dash", "direct"];
let mediaKindFilter = "all";
let lastMediaItems = [];
// Download dialog saved while the Windows folder picker is open: the popup
// closes when it loses focus, and restores the dialog when it reopens.
const PENDING_DIALOG_KEY = "pendingDownloadDialog";
const PENDING_DIALOG_TTL_MS = 10 * 60_000;
// Bilibili tile: the video's parts from the API, and which ones are ticked (by p).
let biliInfo = null;
const biliChecked = new Set();
// Part chips by p, built once per video, and the last clicked part (where a
// Shift+click range starts).
const biliChips = new Map();
let biliAnchor = null;
// Job list groups (one per Bilibili video with several parts): bvid -> nodes,
// and the groups the user opened, kept across the 2 s re-render.
const jobGroupNodes = new Map();
const expandedJobGroups = new Set();

rescanButton.addEventListener("click", () => whileScanning(async () => {
  if (!activeTab?.id) return;
  // Clear first so rescan replaces the previous page results instead of merging.
  await chrome.runtime.sendMessage({ type: "page:clearMedia", tabId: activeTab.id, keepNetwork: true }).catch(() => {});
  const response = await chrome.tabs.sendMessage(activeTab.id, { type: "page:rescan" }).catch(() => null);
  if (!response?.ok) {
    showNotice(response?.error || getMessage("msgCouldNotReadMedia"), true);
    return;
  }
  await loadMedia();
}));

biliSelectAll.addEventListener("click", () => setBiliSelection(() => true));
biliInvert.addEventListener("click", () => setBiliSelection((p) => !biliChecked.has(p)));
biliClear.addEventListener("click", () => setBiliSelection(() => false));
// Leaving the grid shows the last clicked part (or the one open in the tab) again.
biliParts.addEventListener("mouseleave", () => {
  if (biliInfo) showBiliFocus(biliPage(biliAnchor) || biliInfo.selected || biliInfo.pages[0]);
});
biliDownload.addEventListener("click", () => confirmBiliDownload());

refreshHelperButton.addEventListener("click", loadHelperStatus);
resumeAllButton.addEventListener("click", resumeAllJobs);
document.querySelector("#runPrev").addEventListener("click", () => renderRunTile(lastRunJobs, -1));
document.querySelector("#runNext").addEventListener("click", () => renderRunTile(lastRunJobs, 1));
clearMissingButton.addEventListener("click", clearMissingJobs);
jobSearchInput.addEventListener("input", () => {
  window.clearTimeout(jobSearchTimer);
  jobSearchTimer = window.setTimeout(loadHelperStatus, JOB_SEARCH_DELAY_MS);
});
jobSiteSelect.addEventListener("change", loadHelperStatus);
jobSearchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !jobSearchInput.value) return;
  // Clear the search instead of closing the popup.
  event.preventDefault();
  jobSearchInput.value = "";
  loadHelperStatus();
});

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => activatePanel(button.dataset.panel));
});

minSizeSelect.addEventListener("change", () => updateSettings({
  minSizeBytes: Number(minSizeSelect.value)
}));

showUnsupportedInput.addEventListener("change", () => updateSettings({
  showUnsupported: showUnsupportedInput.checked
}));

saveDownloadDirButton.addEventListener("click", updateHelperDownloadDir);
pickDownloadDirButton.addEventListener("click", pickHelperDownloadDir);
if (langSelector) {
  langSelector.value = (await getUserLanguage()).startsWith("zh") ? "zh_CN" : "en";
  langSelector.addEventListener("change", async () => {
    await setUserLanguage(langSelector.value);
    await applyLanguageUI();
  });
}

await applyLanguageUI();
await Promise.all([loadSettings(), loadMedia().then(loadBilibili), loadHelperStatus()]);
window.setInterval(() => {
  retryUnknownSizes();
  return loadHelperStatus();
}, 2000);
chrome.storage.onChanged.addListener(onMediaStorageChanged);
await restorePendingDialog();

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.SETTINGS_GET });
  settings = response?.settings || { minSizeBytes: 1024 * 1024, showUnsupported: true };
  minSizeSelect.value = String(settings.minSizeBytes);
  if (minSizeSelect.value !== String(settings.minSizeBytes)) minSizeSelect.value = "1048576";
  showUnsupportedInput.checked = Boolean(settings.showUnsupported);
  updateFilterSummary();
  renderSiteDirs();
}

// --- Download folder per site ---

// "Remember for <site>" under a dialog's folder field. The dialog starts in
// the site's remembered folder; confirming saves or forgets it.
function siteFolderOption(initial = {}) {
  const site = siteKey(activeTab?.url);
  if (!site) return null;
  const remembered = settings?.siteDownloadDirs?.[site] || "";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = initial.rememberSite ?? Boolean(remembered);
  const label = document.createElement("label");
  label.className = "confirm-check";
  label.append(box, textSpan("", getMessage("dialogRememberSite", { site })));
  return { site, remembered, box, element: label };
}

function applySiteFolder(option, folder) {
  if (!option) return;
  const dirs = { ...(settings?.siteDownloadDirs || {}) };
  if (option.box.checked && folder) dirs[option.site] = folder;
  else delete dirs[option.site];
  if (dirs[option.site] !== settings?.siteDownloadDirs?.[option.site]) saveSiteDirs(dirs);
}

async function saveSiteDirs(dirs) {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.SETTINGS_UPDATE, settings: { siteDownloadDirs: dirs } }).catch(() => null);
  if (!response?.ok) {
    showNotice(response?.error || getMessage("msgSettingsSaveFailed"), true);
    return;
  }
  settings = response.settings;
  renderSiteDirs();
}

// Settings panel: each remembered site with its folder and a Remove button.
function renderSiteDirs() {
  siteDirList.textContent = "";
  const entries = Object.entries(settings?.siteDownloadDirs || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) {
    siteDirList.appendChild(textSpan("site-dir-empty", getMessage("settingsSiteDirsEmpty")));
    return;
  }
  for (const [site, folder] of entries) {
    const row = document.createElement("div");
    row.className = "site-dir-row";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "small-button";
    remove.textContent = getMessage("btnRemove");
    remove.addEventListener("click", () => {
      const dirs = { ...settings.siteDownloadDirs };
      delete dirs[site];
      saveSiteDirs(dirs);
    });
    row.append(textSpan("site-dir-site", site), textSpan("site-dir-folder", folder), remove);
    siteDirList.appendChild(row);
  }
}

async function updateSettings(patch) {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.SETTINGS_UPDATE,
    settings: patch
  });
  if (!response?.ok) {
    showNotice(response?.error || getMessage("msgSettingsSaveFailed"), true);
    return;
  }
  settings = response.settings;
  updateFilterSummary();
  await loadMedia();
}

// The background reads manifests and probes sizes/resolutions before it
// answers, which can take several seconds; show that the scan is running.
async function whileScanning(task) {
  scansRunning += 1;
  setScanning(true);
  try {
    return await task();
  } finally {
    scansRunning -= 1;
    if (!scansRunning) setScanning(false);
    if (!scansRunning && refreshAfterScan) {
      refreshAfterScan = false;
      refreshMediaList();
    }
  }
}

// Sizes and resolutions found after the scan answered, and media detected
// while the popup is open, arrive through storage; show them as they come.
function onMediaStorageChanged(changes, area) {
  if (area !== "local" || !activeTab?.id || !changes[`tabMedia:${activeTab.id}`]) return;
  window.clearTimeout(mediaRefreshTimer);
  mediaRefreshTimer = window.setTimeout(refreshMediaList, 300);
}

async function refreshMediaList() {
  // A running scan renders the final list itself; refresh once it is done.
  if (scansRunning) {
    refreshAfterScan = true;
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.MEDIA_GET_FOR_TAB,
    tabId: activeTab.id,
    enrich: false
  }).catch(() => null);
  if (!response?.ok) return;
  const items = sortMediaByQuality(response.items || []);
  renderMedia(items, { live: true });

  const urls = items.filter(needsProbe).map((item) => item.url);
  if (!urls.length) return;
  for (const url of urls) noteProbe(url);
  chrome.runtime.sendMessage({ type: MESSAGE.MEDIA_ENRICH, tabId: activeTab.id, urls }).catch(() => {});
}

// Runs on the 2 s status poll, so a retry does not wait for a storage change.
function retryUnknownSizes() {
  if (scansRunning || !activeTab?.id) return;
  const urls = [...mediaNodes.values()].map((entry) => entry.item).filter(needsProbe).map((item) => item.url);
  if (!urls.length) return;
  for (const url of urls) noteProbe(url);
  chrome.runtime.sendMessage({ type: MESSAGE.MEDIA_ENRICH, tabId: activeTab.id, urls }).catch(() => {});
}

// New media is probed once; media still without a size is probed again
// after ENRICH_RETRY_MS, up to ENRICH_MAX_ATTEMPTS in all.
function needsProbe(item) {
  const attempt = enrichAttempts.get(item.url);
  if (!attempt) return true;
  if (item.size || item.estimatedSize || item.isProtected) return false;
  return attempt.count < ENRICH_MAX_ATTEMPTS && Date.now() - attempt.at >= ENRICH_RETRY_MS;
}

function noteProbe(url) {
  enrichAttempts.set(url, { count: (enrichAttempts.get(url)?.count || 0) + 1, at: Date.now() });
}

function setScanning(active) {
  mediaPanel.classList.toggle("is-scanning", active);
  mediaPanel.ariaBusy = String(active);
  rescanButton.disabled = active;
  scanLabel.textContent = getMessage(active ? "labelScanning" : "labelDetected");
}

function loadMedia() {
  return whileScanning(async () => {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      showNotice(getMessage("msgNoActiveTab"), true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.MEDIA_GET_FOR_TAB,
      tabId: activeTab.id
    });

    if (!response?.ok) {
      showNotice(response?.error || getMessage("msgCouldNotReadMedia"), true);
      return;
    }

    const items = response.items || [];
    for (const item of items) noteProbe(item.url);
    renderMedia(sortMediaByQuality(items));
  });
}

async function loadHelperStatus() {
  // Prevent concurrent calls from overwriting each other's results.
  // The 2s poll and post-download refresh can interleave: the poll's
  // response (fetched before the job was created) could arrive after
  // the download's response and clear the just-rendered job list.
  if (statusLoading) {
    statusPending = true;
    return;
  }
  statusLoading = true;
  try {
    const query = jobSearchInput.value.trim();
    const site = jobSiteSelect.value;
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.HELPER_STATUS_GET, query, site });
    const online = Boolean(response?.online);
    const liveJobs = response?.jobs || [];
    const cachedJobs = response?.cachedJobs || [];
    const stats = response?.stats || null;
    const downloadDir = response?.health?.downloadDir || "";
    helperOnline = online;
    helperDownloadDir = downloadDir;

    console.log("[ds-video-downloader] loadHelperStatus online=%s jobs=%d cached=%d",
      online, liveJobs.length, cachedJobs.length);

    // Merge: live jobs take priority, then fill with cached history
    const liveIds = new Set(liveJobs.map(j => j.id));
    const merged = [
      ...liveJobs,
      ...cachedJobs.filter(j => !liveIds.has(j.id))
    ].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")).slice(0, 20);

    try {
      const activeCount = stats ? stats.active : runningCount(liveJobs);
      const totalCount = stats ? stats.total : liveJobs.length;
      helperSummary.textContent = online
        ? getMessage("msgActiveJobs", { active: String(activeCount), total: String(totalCount), plural: totalCount === 1 ? "" : "s" })
        : getMessage("statusHelperOffline");
      setTabCount(helperTabCount, online ? activeCount : 0);
      helperSummary.classList.toggle("is-offline", !online);
      helperStatus.className = `helper-status tile ${online ? "is-online" : "is-offline"}`;
      helperStatus.textContent = online
        ? getMessage("msgHelperRunning", { dir: downloadDir || getMessage("labelDefaultFolder") })
        : getMessage("msgHelperEmpty");

      if (online && downloadDir && document.activeElement !== downloadDirInput) {
        downloadDirInput.value = downloadDir;
      }
    } catch (domError) {
      console.warn("[ds-video-downloader] loadHelperStatus DOM update failed", domError);
    }

    const resumable = online ? Number(stats?.resumable) || 0 : 0;
    resumeAllButton.hidden = !resumable;
    resumeAllButton.textContent = getMessage("btnResumeAll", { count: String(resumable) });

    // Searching needs the helper: offline there is only the cached recent list.
    jobSearchInput.disabled = !online;
    jobSiteSelect.disabled = !online;
    if (online) renderSiteOptions(response.sites || []);
    const searching = online && Boolean(query || site);
    renderHelperJobs(searching ? (response.searchJobs || []) : merged, searching ? query : "", searching ? site : "");
    renderRunTile(merged);
  } catch (error) {
    console.error("[ds-video-downloader] loadHelperStatus failed", error);
  } finally {
    statusLoading = false;
    if (statusPending) {
      statusPending = false;
      await loadHelperStatus();
    }
  }
}

// Updates the list in place: existing items keep their node, so a live
// refresh does not wipe a running download's status line.
// live: a refresh from storage; keep whatever notice is showing.
function renderMedia(items, { live = false } = {}) {
  lastMediaItems = items;
  mediaCount.textContent = getMessage("msgCountDetected", { count: String(items.length) });
  mediaCountNum.textContent = String(items.length);
  setTabCount(mediaTabCount, items.length);

  if (!items.length) {
    list.textContent = "";
    mediaNodes.clear();
    renderKindFilter(items);
    // A Bilibili page lists its parts in its own tile instead.
    if (biliTile.hidden) showNotice(getMessage("msgEmptyHint"));
    return;
  }

  if (!live || notice.textContent === getMessage("msgEmptyHint")) hideNotice();
  renderKindFilter(items);
  const seen = new Set();
  for (const item of items) {
    seen.add(item.url);
    const entry = mediaNodes.get(item.url) || createMediaNode();
    entry.item = item;
    fillMediaNode(entry);
    // Hidden, not removed: a filtered-out item keeps its running download status.
    entry.node.hidden = mediaKindFilter !== "all" && item.kind !== mediaKindFilter;
    mediaNodes.set(item.url, entry);
    list.appendChild(entry.node); // re-appending also moves it into sort order
  }
  for (const [url, entry] of mediaNodes) {
    if (seen.has(url)) continue;
    entry.node.remove();
    mediaNodes.delete(url);
  }
}

// Chips "All 12 · HLS 3 · Direct 9"; only when the page has more than one
// kind. A chosen kind that is no longer on the page falls back to All.
function renderKindFilter(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  if (!counts.has(mediaKindFilter)) mediaKindFilter = "all";
  kindFilter.textContent = "";
  kindFilter.hidden = counts.size < 2;
  if (kindFilter.hidden) return;

  const kinds = [...counts.keys()].sort((a, b) => kindRank(a) - kindRank(b));
  for (const kind of ["all", ...kinds]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kind-chip";
    chip.dataset.kind = kind;
    chip.ariaPressed = String(kind === mediaKindFilter);
    const label = kind === "all" ? getMessage("filterAll") : kind === "direct" ? getMessage("labelKindDirect") : kind.toUpperCase();
    chip.textContent = `${label} ${kind === "all" ? items.length : counts.get(kind)}`;
    chip.addEventListener("click", () => {
      mediaKindFilter = kind;
      renderMedia(lastMediaItems, { live: true });
    });
    kindFilter.appendChild(chip);
  }
}

function kindRank(kind) {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
}

function createMediaNode() {
  const node = template.content.firstElementChild.cloneNode(true);
  // Remove the separate download button — clicking the media item itself initiates download
  node.querySelector(".download-button")?.remove();
  const entry = { node, variants: node.querySelector(".variant-list"), status: node.querySelector(".job-status"), item: null };
  node.addEventListener("click", (e) => {
    // Don't trigger when clicking variant chips (those have their own handlers)
    if (e.target.closest(".variant-chip") || entry.item.isProtected) return;
    const item = entry.item;
    confirmDownload(item, (output) => startDownload(item, entry.variants, entry.status, output));
  });
  return entry;
}

function fillMediaNode({ node, item, variants }) {
  node.dataset.kind = item.kind;
  node.classList.toggle("is-locked", Boolean(item.isProtected));
  node.querySelector(".media-title").textContent = displayMediaTitle(item);
  node.querySelector(".media-kind").textContent = item.kind.toUpperCase();
  renderMediaMeta(node.querySelector(".media-meta-row"), item);
  renderVariants(variants, item.variants || [], item);
  // Make the entire media item a clickable download trigger
  node.style.cursor = item.isProtected ? "" : "pointer";
  node.title = item.isProtected
    ? (item.unsupportedReason || getMessage("labelUnsupported"))
    : getMessage("msgClickToDownload", { name: sanitizeFilename(item.title, item.extension) });
}

// query / site: the active search and site filter, for the empty-state text.
function renderHelperJobs(jobs, query = "", site = "") {
  if (!helperJobTemplate) {
    console.warn("[ds-video-downloader] helperJobTemplate not found in DOM");
    return;
  }
  // Nodes are updated in place, which keeps their order; a new search (or
  // leaving one) starts from an empty list so the results keep the helper's order.
  const filterKey = `${query}\n${site}`;
  if (filterKey !== renderedJobQuery) {
    renderedJobQuery = filterKey;
    helperJobs.textContent = "";
    helperJobNodes.clear();
    jobGroupNodes.clear();
  }
  // The search words, marked in each job's name and path.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = bilibiliJobGroups(jobs);
  // Clear empty-state if we have jobs now
  if (jobs.length && helperJobNodes.size === 0) {
    helperJobs.textContent = "";
  }
  const seenIds = new Set();

  for (const job of jobs) {
    seenIds.add(job.id);
    const existing = helperJobNodes.get(job.id);

    if (existing) {
      // Update existing node in place
      const state = existing.querySelector(".helper-job-state");
      const meta = existing.querySelector(".helper-job-meta");
      const pathEl = existing.querySelector(".helper-job-path");
      const sourceBtn = existing.querySelector(".source-button");
      const resumeBtn = existing.querySelector(".resume-button");
      const browserBtn = existing.querySelector(".browser-button");
      const cancelBtn = existing.querySelector(".cancel-button");
      const showBtn = existing.querySelector(".show-button");
      const removeBtn = existing.querySelector(".remove-button");

      state.textContent = jobStateText(job);
      state.className = `helper-job-state ${job.status === "completed" ? "is-complete" : ""} ${job.status === "failed" ? "is-error" : ""} ${job.status === "cancelled" ? "is-cancelled" : ""} ${job.status === "missing" ? "is-missing" : ""}`;
      meta.textContent = humanJobMessage(job);
      setHighlighted(pathEl, job.outputPath || job.url || "", words);
      existing.dataset.status = job.status;
      setProgress(existing, job);

      const isActive = job.status === "queued" || job.status === "running";
      const fileExists = job.fileExists !== false && Boolean(job.outputPath);
      sourceBtn.disabled = !job.sourcePageUrl;
      sourceBtn.dataset.sourceUrl = job.sourcePageUrl || "";
      resumeBtn.disabled = !job.resumable;
      browserBtn.disabled = !canRetryInBrowser(job);
      cancelBtn.disabled = !isActive;
      showBtn.disabled = !fileExists;
      removeBtn.disabled = isActive;
      removeBtn.dataset.fileExists = String(fileExists);
      fillSiteTag(existing.querySelector(".site-tag"), job);
      placeJobNode(existing, job, groups);
    } else {
      // Create new node
      const node = helperJobTemplate.content.firstElementChild.cloneNode(true);
      translateNode(node);
      node.dataset.jobId = job.id;
      node.dataset.status = job.status;
      setProgress(node, job);
      setHighlighted(node.querySelector(".helper-job-title"), jobTitle(job), words);
      const state = node.querySelector(".helper-job-state");
      state.textContent = jobStateText(job);
      state.classList.toggle("is-complete", job.status === "completed");
      state.classList.toggle("is-error", job.status === "failed");
      state.classList.toggle("is-cancelled", job.status === "cancelled");
      state.classList.toggle("is-missing", job.status === "missing");
      node.querySelector(".helper-job-meta").textContent = humanJobMessage(job);
      setHighlighted(node.querySelector(".helper-job-path"), job.outputPath || job.url || "", words);

      const sourceButton = node.querySelector(".source-button");
      const resumeButton = node.querySelector(".resume-button");
      const browserButton = node.querySelector(".browser-button");
      const cancelButton = node.querySelector(".cancel-button");
      const showButton = node.querySelector(".show-button");
      const removeButton = node.querySelector(".remove-button");
      const isActive = job.status === "queued" || job.status === "running";
      const fileExists = job.fileExists !== false && Boolean(job.outputPath);
      sourceButton.disabled = !job.sourcePageUrl;
      sourceButton.dataset.sourceUrl = job.sourcePageUrl || "";
      resumeButton.disabled = !job.resumable;
      browserButton.disabled = !canRetryInBrowser(job);
      cancelButton.disabled = !isActive;
      showButton.disabled = !fileExists;
      removeButton.disabled = isActive;
      removeButton.dataset.fileExists = String(fileExists);
      sourceButton.addEventListener("click", () => openSourcePage(sourceButton.dataset.sourceUrl));
      resumeButton.addEventListener("click", () => resumeJob(job.id, resumeButton));
      browserButton.addEventListener("click", () => downloadJobWithBrowser(job));
      cancelButton.addEventListener("click", () => cancelJob(job.id));
      showButton.addEventListener("click", () => showJobInFolder(job.id));
      removeButton.addEventListener("click", () => openRemoveDialog(job.id, removeButton.dataset.fileExists === "true", jobTitle(job)));
      const siteTag = node.querySelector(".site-tag");
      fillSiteTag(siteTag, job);
      siteTag.addEventListener("click", () => filterBySite(siteTag.dataset.site));

      placeJobNode(node, job, groups);
      helperJobNodes.set(job.id, node);
    }
  }

  // Remove stale nodes
  for (const [id, node] of helperJobNodes) {
    if (!seenIds.has(id)) {
      node.remove();
      helperJobNodes.delete(id);
    }
  }
  renderJobGroups(groups);

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "helper-status";
    // textContent: the query is user input.
    empty.textContent = query ? getMessage("msgNoMatches", { query })
      : site ? getMessage("msgNoSiteJobs", { site })
        : getMessage("msgNoJobs");
    helperJobs.textContent = "";
    helperJobs.appendChild(empty);
    helperJobNodes.clear();
    jobGroupNodes.clear();
  }
}

// --- Job groups: a Bilibili video's parts under one row ---

// bvid -> its jobs, for videos with more than one part in the list.
function bilibiliJobGroups(jobs) {
  const byVideo = new Map();
  for (const job of jobs) {
    const bvid = job.inputMode === "bilibili" ? job.bilibili?.bvid : "";
    if (bvid) byVideo.set(bvid, [...(byVideo.get(bvid) || []), job]);
  }
  return new Map([...byVideo].filter(([, parts]) => parts.length > 1));
}

// A job's node goes into its video's group, or stays in the list itself.
function placeJobNode(node, job, groups) {
  const bvid = job.bilibili?.bvid;
  const parent = groups.has(bvid) ? jobGroupNode(bvid).parts : helperJobs;
  if (node.parentNode !== parent) parent.appendChild(node);
}

function jobGroupNode(bvid) {
  if (jobGroupNodes.has(bvid)) return jobGroupNodes.get(bvid);
  const node = document.createElement("article");
  node.className = "job-group";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "job-group-head";
  const state = textSpan("helper-job-state", "");
  const title = textSpan("job-group-title", "");
  head.append(state, title);
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  bar.appendChild(document.createElement("i"));
  const meta = textSpan("job-group-meta", "");
  const parts = document.createElement("div");
  parts.className = "job-group-parts";
  parts.hidden = !expandedJobGroups.has(bvid);
  head.ariaExpanded = String(!parts.hidden);
  head.addEventListener("click", () => {
    parts.hidden = !parts.hidden;
    if (parts.hidden) expandedJobGroups.delete(bvid);
    else expandedJobGroups.add(bvid);
    head.ariaExpanded = String(!parts.hidden);
  });
  node.append(head, bar, meta, parts);
  helperJobs.appendChild(node);
  const group = { node, state, title, meta, parts };
  jobGroupNodes.set(bvid, group);
  return group;
}

// Group rows show the parts' combined state; groups whose video no longer
// has several parts in the list are removed (their part moved out already).
function renderJobGroups(groups) {
  for (const [bvid, group] of jobGroupNodes) {
    const parts = groups.get(bvid);
    if (!parts) {
      group.node.remove();
      jobGroupNodes.delete(bvid);
      continue;
    }
    const count = (...statuses) => parts.filter((job) => statuses.includes(job.status)).length;
    const active = count("running", "queued");
    const done = count("completed");
    const resumable = parts.filter((job) => job.resumable).length;
    const fraction = parts.reduce((sum, job) => sum + (job.status === "completed" ? 1 : jobProgressFraction(job) || 0), 0) / parts.length;
    const status = active ? "running" : done === parts.length ? "completed" : resumable || count("failed") ? "failed" : parts[0].status;
    group.node.dataset.status = status;
    group.node.style.setProperty("--p", `${(fraction * 100).toFixed(1)}%`);
    group.state.textContent = `${humanStatus(status)} ${Math.floor(fraction * 100)}%`;
    group.state.className = `helper-job-state ${status === "completed" ? "is-complete" : ""} ${status === "failed" ? "is-error" : ""}`;
    group.title.textContent = parts[0].bilibili.title || parts[0].bilibili.bvid;
    group.meta.textContent = [
      getMessage("jobGroupDone", { done: String(done), total: String(parts.length) }),
      active ? getMessage("jobGroupActive", { count: String(active) }) : "",
      resumable ? getMessage("jobGroupResumable", { count: String(resumable) }) : ""
    ].filter(Boolean).join(" · ");
  }
}

// The download dialog: an editable file name (the extension is fixed by what
// gets written) and a folder for this download only, starting at the
// helper's saved download folder. onConfirm receives { filename, downloadDir }.
// initial: values restored after the folder picker closed the popup.
function confirmDownload(item, onConfirm, variant = null, initial = {}) {
  const quality = variant?.quality || item.quality;
  const kindLabel = [
    item.kind === "direct" ? getMessage("labelDirectDownload") : getMessage("labelStreamKind", { kind: item.kind.toUpperCase() }),
    quality
  ].filter(Boolean).join(" · ");
  // Offline, a direct file goes to Chrome, which only saves to its own folder.
  const chooseFolder = helperOnline || item.kind !== "direct";

  const fields = document.createElement("div");
  fields.className = "confirm-fields";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = initial.filename ?? defaultFileBase(item);
  nameInput.spellcheck = false;
  const extension = document.createElement("span");
  extension.className = "confirm-ext";
  extension.textContent = `.${outputExtension(item)}`;
  fields.appendChild(dialogField(getMessage("dialogFileNameLabel"), nameInput, extension));

  const siteOption = chooseFolder ? siteFolderOption(initial) : null;
  const dirInput = document.createElement("input");
  dirInput.type = "text";
  dirInput.value = initial.downloadDir || siteOption?.remembered || helperDownloadDir;
  dirInput.spellcheck = false;
  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "ghost-button";
  browseButton.textContent = getMessage("btnBrowse");
  if (chooseFolder) {
    fields.appendChild(dialogField(getMessage("dialogFolderLabel"), dirInput, browseButton));
    if (siteOption) fields.appendChild(siteOption.element);
  } else {
    const hint = document.createElement("p");
    hint.className = "confirm-hint";
    hint.textContent = getMessage("dialogChromeFolderHint");
    fields.appendChild(hint);
  }
  fields.appendChild(copyActions(item, variant, () => `${nameInput.value.trim() || defaultFileBase(item)}.${outputExtension(item)}`));

  const overlay = openDialog(getMessage("confirmDownloadTitle"), "", kindLabel, [
    { label: getMessage("btnCancel"), className: "btn-ghost" },
    {
      label: getMessage("btnDownload"),
      className: "btn-primary",
      onClick: () => {
        applySiteFolder(siteOption, dirInput.value.trim());
        onConfirm({
          filename: nameInput.value.trim(),
          downloadDir: chooseFolder ? dirInput.value.trim() : ""
        });
      }
    }
  ], "", { content: fields, onClose: clearPendingDialog });

  const submit = (event) => {
    if (event.key === "Enter") overlay.querySelector(".btn-primary")?.click();
  };
  nameInput.addEventListener("keydown", submit);
  dirInput.addEventListener("keydown", submit);
  wireBrowseButton(browseButton, dirInput, () => ({ item, variant, filename: nameInput.value, rememberSite: siteOption?.box.checked }));

  nameInput.focus?.();
  nameInput.select?.();
  return overlay;
}

// The Windows folder picker closes the popup, so the dialog is saved first
// and restorePendingDialog brings it back. dialogState: what it needs for that.
function wireBrowseButton(browseButton, dirInput, dialogState) {
  browseButton.addEventListener("click", async () => {
    browseButton.disabled = true;
    await chrome.storage.session?.set({
      [PENDING_DIALOG_KEY]: {
        tabId: activeTab?.id,
        ...dialogState(),
        downloadDir: dirInput.value,
        savedAt: Date.now()
      }
    }).catch(() => {});
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.HELPER_FOLDER_PICK,
      options: { initialDir: dirInput.value.trim(), persist: false, reopenPopup: true }
    }).catch(() => null);
    // Only reached when the popup stayed open during the picker.
    browseButton.disabled = false;
    if (response?.ok) {
      dirInput.value = response.settings?.downloadDir || dirInput.value;
    } else if (response?.error && response.error !== "FOLDER_PICK_CANCELLED") {
      showNotice(response.error === "HELPER_OFFLINE" ? getMessage("msgHelperOfflinePickDir") : response.error, true);
    }
  });
}

// For using the media in another tool: its URL (the chosen quality's), and
// for HLS/DASH a ready ffmpeg command. The command carries only the Referer;
// cookies stay out of the clipboard. getFileName: the dialog's current name.
function copyActions(item, variant, getFileName) {
  const url = variant?.url || item.url;
  const row = document.createElement("div");
  row.className = "confirm-copy";
  row.appendChild(copyButton(getMessage("btnCopyUrl"), () => url));
  if (item.kind !== "direct") {
    row.appendChild(copyButton(getMessage("btnCopyFfmpeg"), () => ffmpegCommand(url, item.sourcePageUrl, getFileName())));
  }
  return row;
}

function copyButton(label, getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    const copied = await navigator.clipboard.writeText(getText()).then(() => true, () => false);
    button.textContent = getMessage(copied ? "msgCopied" : "msgCopyFailed");
    window.setTimeout(() => { button.textContent = label; }, 1200);
  });
  return button;
}

function dialogField(labelText, input, trailing) {
  const field = document.createElement("label");
  field.className = "confirm-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const row = document.createElement("div");
  row.className = "confirm-input-row";
  row.appendChild(input);
  row.appendChild(trailing);
  field.appendChild(label);
  field.appendChild(row);
  return field;
}

// HLS/DASH are muxed to mp4 by the helper; direct files keep their own type.
function outputExtension(item) {
  return item.kind === "direct" ? (item.extension || "mp4") : "mp4";
}

function defaultFileBase(item) {
  let base = sanitizeFilename(item.title);
  for (const extension of new Set([item.extension, outputExtension(item)])) {
    if (extension && base.toLowerCase().endsWith(`.${extension}`)) base = base.slice(0, -extension.length - 1);
  }
  return base;
}

// Reopens the download dialog the folder picker interrupted, with the folder
// the background stored after the picker closed.
async function restorePendingDialog() {
  const stored = await chrome.storage.session?.get(PENDING_DIALOG_KEY).catch(() => null);
  const state = stored?.[PENDING_DIALOG_KEY];
  if (!state?.item && !state?.bilibili) return;
  if (state.tabId !== activeTab?.id || Date.now() - state.savedAt > PENDING_DIALOG_TTL_MS) {
    await clearPendingDialog();
    return;
  }
  if (state.bilibili) {
    if (biliInfo?.bvid !== state.bilibili.bvid) return clearPendingDialog();
    biliChecked.clear();
    for (const p of state.bilibili.parts) biliChecked.add(p);
    biliQuality.value = state.bilibili.quality;
    renderBiliParts();
    confirmBiliDownload(state);
    return;
  }
  const nodes = mediaNodes.get(state.item.url) || {};
  const start = state.variant
    ? (output) => startVariantDownload(state.item, state.variant, nodes.status, output)
    : (output) => startDownload(state.item, nodes.variants, nodes.status, output);
  confirmDownload(state.item, start, state.variant, state);
}

function clearPendingDialog() {
  return chrome.storage.session?.remove(PENDING_DIALOG_KEY).catch(() => {});
}

// --- Bilibili tile ---

const BILIBILI_ERRORS = {
  LOGIN_REQUIRED: "biliErrLogin",
  RATE_LIMITED: "biliErrRateLimited",
  ACCESS_DENIED: "biliErrAccess",
  FORMAT_SELECTION_REQUIRED: "biliErrFormat",
  HELPER_OFFLINE: "msgStartHelperHint"
};

function bilibiliErrorMessage(code, fallback) {
  return BILIBILI_ERRORS[code] ? getMessage(BILIBILI_ERRORS[code]) : code || fallback;
}

// A BV page gets its own tile: the parts come from Bilibili's API (asked by
// the background, with the user's cookies), not from the scanned media list.
async function loadBilibili() {
  try {
    parseBvUrl(activeTab?.url || "");
  } catch {
    return;
  }
  biliTile.hidden = false;
  if (notice.textContent === getMessage("msgEmptyHint")) hideNotice();
  setBiliStatus(getMessage("biliLoading"));
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.BILIBILI_INFO_GET, url: activeTab.url }).catch(() => null);
  if (!response?.ok) {
    setBiliStatus(bilibiliErrorMessage(response?.error, getMessage("msgCouldNotReadMedia")), true);
    return;
  }
  biliInfo = response.info;
  biliChecked.clear();
  biliAnchor = null;
  biliChecked.add((biliInfo.selected || biliInfo.pages[0]).p);
  biliTitle.textContent = biliInfo.title;
  setBiliStatus("");
  renderBiliParts();
}

// Multi-part videos show a grid of numbered chips, like Bilibili's own part
// picker; the line under it names the part hovered or last clicked.
function renderBiliParts() {
  biliParts.textContent = "";
  biliChips.clear();
  const multi = biliInfo.pages.length > 1;
  const digits = Math.max(2, String(Math.max(...biliInfo.pages.map((page) => page.p))).length);
  for (const page of biliInfo.pages) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "bili-chip";
    chip.textContent = String(page.p).padStart(digits, "0");
    chip.title = biliPartLabel(page);
    // The part open in the tab.
    chip.classList.toggle("is-current", page.p === biliInfo.selected?.p);
    chip.addEventListener("click", (event) => toggleBiliPart(page.p, event.shiftKey));
    chip.addEventListener("mouseenter", () => showBiliFocus(page));
    chip.addEventListener("focus", () => showBiliFocus(page));
    biliChips.set(page.p, chip);
    biliParts.appendChild(chip);
  }
  biliParts.hidden = !multi;
  biliPick.hidden = !multi;
  biliFocus.hidden = !multi;
  showBiliFocus(biliInfo.selected || biliInfo.pages[0]);
  biliChips.get(biliInfo.selected?.p)?.scrollIntoView?.({ block: "nearest" });
  updateBiliActions();
}

// Shift+click sets every part from the last clicked one to this one to this
// part's new state, so a range can be ticked or cleared in one go.
function toggleBiliPart(p, range) {
  const select = !biliChecked.has(p);
  const order = biliInfo.pages.map((page) => page.p);
  const to = order.indexOf(p);
  const from = range && biliAnchor !== null ? order.indexOf(biliAnchor) : to;
  for (const part of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (select) biliChecked.add(part);
    else biliChecked.delete(part);
  }
  biliAnchor = p;
  updateBiliActions();
}

function setBiliSelection(isSelected) {
  for (const page of biliInfo.pages) {
    if (isSelected(page.p)) biliChecked.add(page.p);
    else biliChecked.delete(page.p);
  }
  updateBiliActions();
}

function biliPage(p) {
  return biliInfo.pages.find((page) => page.p === p) || null;
}

function biliPartLabel(page) {
  return [`P${page.p}`, page.title, formatClock(page.durationSeconds)].filter(Boolean).join(" · ");
}

function showBiliFocus(page) {
  biliFocus.textContent = biliPartLabel(page);
}

function updateBiliActions() {
  const count = biliChecked.size;
  const multi = biliInfo.pages.length > 1;
  for (const [p, chip] of biliChips) chip.ariaPressed = String(biliChecked.has(p));
  biliSummary.textContent = multi ? getMessage("biliSummary", { total: String(biliInfo.pages.length), count: String(count) }) : "";
  biliDownload.disabled = !count;
  biliDownload.textContent = multi ? getMessage("biliDownloadCount", { count: String(count) }) : getMessage("btnDownload");
}

function setBiliStatus(text, isError = false) {
  biliStatus.textContent = text;
  biliStatus.hidden = !text;
  biliStatus.classList.toggle("is-error", isError);
}

function textSpan(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function formatClock(seconds) {
  if (!(seconds > 0)) return "";
  const total = Math.round(seconds);
  const pad = (value) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

// One ticked part can be renamed; a batch is named by bilibiliFileName.
// initial: the dialog the folder picker interrupted.
function confirmBiliDownload(initial = {}) {
  const pages = biliInfo.pages.filter((page) => biliChecked.has(page.p));
  if (!pages.length) return;
  const fields = document.createElement("div");
  fields.className = "confirm-fields";

  let nameInput = null;
  if (pages.length === 1) {
    nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = initial.filename ?? bilibiliFileName(biliInfo, pages[0]);
    nameInput.spellcheck = false;
    fields.appendChild(dialogField(getMessage("dialogFileNameLabel"), nameInput, textSpan("confirm-ext", ".mp4")));
  }
  const siteOption = siteFolderOption(initial);
  const dirInput = document.createElement("input");
  dirInput.type = "text";
  dirInput.value = initial.downloadDir || siteOption?.remembered || helperDownloadDir;
  dirInput.spellcheck = false;
  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "ghost-button";
  browseButton.textContent = getMessage("btnBrowse");
  fields.appendChild(dialogField(getMessage("dialogFolderLabel"), dirInput, browseButton));
  if (siteOption) fields.appendChild(siteOption.element);

  const overlay = openDialog(getMessage("confirmDownloadTitle"), "", getMessage("biliDialogKind", { count: String(pages.length) }), [
    { label: getMessage("btnCancel"), className: "btn-ghost" },
    {
      label: getMessage("btnDownload"),
      className: "btn-primary",
      onClick: () => {
        applySiteFolder(siteOption, dirInput.value.trim());
        startBiliDownload(pages, { filename: nameInput?.value.trim() || "", downloadDir: dirInput.value.trim() });
      }
    }
  ], "", { content: fields, onClose: clearPendingDialog });

  const submit = (event) => {
    if (event.key === "Enter") overlay.querySelector(".btn-primary")?.click();
  };
  nameInput?.addEventListener("keydown", submit);
  dirInput.addEventListener("keydown", submit);
  wireBrowseButton(browseButton, dirInput, () => ({
    bilibili: { bvid: biliInfo.bvid, parts: pages.map((page) => page.p), quality: biliQuality.value },
    filename: nameInput?.value,
    rememberSite: siteOption?.box.checked
  }));
  (nameInput || dirInput).focus?.();
}

async function startBiliDownload(pages, output) {
  const parts = pages.map((page) => ({
    p: page.p,
    cid: page.cid,
    filename: pages.length === 1 && output.filename ? output.filename : bilibiliFileName(biliInfo, page)
  }));
  biliDownload.disabled = true;
  setBiliStatus(getMessage("biliStarting", { count: String(parts.length) }));
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.BILIBILI_DOWNLOAD,
    bvid: biliInfo.bvid,
    title: biliInfo.title,
    parts,
    quality: biliQuality.value,
    downloadDir: output.downloadDir
  }).catch(() => null);
  biliDownload.disabled = false;

  const started = response?.helperJobs?.length || 0;
  if (response?.ok) {
    setBiliStatus(getMessage("biliStarted", { count: String(started) }));
  } else {
    const error = bilibiliErrorMessage(response?.error, getMessage("msgDownloadFailed"));
    setBiliStatus(started ? getMessage("biliPartlyStarted", { started: String(started), total: String(parts.length), error }) : error, true);
  }
  if (started) await loadHelperStatus();
}

// Builds a modal: yellow header slab, paper body, action buttons. Every button
// closes the dialog first, then runs its onClick. Backdrop click and Escape
// behave like the cancel path (close without a callback).
// options.content: extra element shown above the buttons.
// options.onClose: runs whenever the dialog closes, by any path.
let closeActiveDialog = null;

function openDialog(titleText, nameText, kindText, actions, actionsClassName = "", options = {}) {
  closeActiveDialog?.();

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  const dialog = document.createElement("div");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const head = document.createElement("header");
  head.className = "confirm-head";
  const title = document.createElement("h3");
  title.textContent = titleText;
  head.appendChild(title);

  const body = document.createElement("div");
  body.className = "confirm-body";
  if (nameText) {
    const name = document.createElement("p");
    name.className = "confirm-name";
    name.textContent = nameText;
    body.appendChild(name);
  }
  if (options.content) body.appendChild(options.content);
  if (kindText) {
    const kind = document.createElement("p");
    kind.className = "confirm-kind";
    kind.textContent = kindText;
    body.appendChild(kind);
  }

  const row = document.createElement("div");
  row.className = `confirm-actions ${actionsClassName}`.trim();
  let focusTarget = null;
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (closeActiveDialog === close) closeActiveDialog = null;
    options.onClose?.();
  };
  closeActiveDialog = close;
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.className || "";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      close();
      action.onClick?.();
    });
    if (action.focus) focusTarget = button;
    row.appendChild(button);
  }
  body.appendChild(row);

  dialog.appendChild(head);
  dialog.appendChild(body);
  overlay.appendChild(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  (focusTarget || row.querySelector("button"))?.focus?.();
  return overlay;
}

// output: { filename, downloadDir } from the dialog; viaBrowser: true sends a
// direct file to Chrome's downloader instead of the helper.
async function startDownload(item, variantContainer, statusContainer, output = {}) {
  if (pendingDownloads.has(item.url)) {
    showNotice(getMessage("msgDownloadInProgress"), true);
    return;
  }
  pendingDownloads.add(item.url);

  let releasePending = true;
  let keepStatus = false;

  if (statusContainer) {
    statusContainer.hidden = false;
    statusContainer.classList.add("is-pending");
    statusContainer.textContent = getMessage("statusConnecting");
  }

  try {
    // Only Chrome's downloader needs the optional "downloads" permission.
    if (item.kind === "direct" && (output.viaBrowser || !helperOnline)) {
      try {
        const hasPermission = await chrome.permissions.contains({ permissions: ["downloads"] });
        if (!hasPermission) {
          const granted = await chrome.permissions.request({ permissions: ["downloads"] });
          if (!granted) {
            showNotice(getMessage("msgDownloadPermission"), true);
            return;
          }
        }
      } catch (error) {
        console.error("[ds-video-downloader] permission check failed", error);
        showNotice(getMessage("msgDownloadFailed"), true);
        return;
      }
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGE.DOWNLOADS_START,
        item,
        output
      });
    } catch (error) {
      console.error("[ds-video-downloader] startDownload sendMessage failed", error);
      showNotice(getMessage("msgDownloadFailed"), true);
      return;
    }

    console.log("[ds-video-downloader] startDownload response ok=%s helperJob=%s error=%s",
      response?.ok, Boolean(response?.helperJob), response?.error);

    if (response?.ok) {
      if (response.helperJob) {
        keepStatus = true;
        releasePending = false;
        showJobStatus(statusContainer, response.helperJob);
        pollJob(response.helperJob.id, statusContainer, (job) => {
          pendingDownloads.delete(item.url);
          if (item.kind === "direct" && job?.status === "failed") offerBrowserDownload(item, output, job.error);
        });
        await loadHelperStatus();
        showNotice(getMessage(item.kind === "direct" ? "msgHelperDirectStarted" : "msgHelperStreamStarted"));
      } else {
        showNotice(getMessage("msgDownloadStarted"));
      }
      return;
    }

    if (response?.browserFallback) {
      offerBrowserDownload(item, output, response.error);
      return;
    }

    if (response?.error === "DRM_PROTECTED_UNSUPPORTED") {
      showNotice(getMessage("msgDrmUnsupported"), true);
      return;
    }

    if (response?.error === "SERVER_PROTECTED_UNSUPPORTED") {
      showNotice(getMessage("msgServerBlocked"), true);
      return;
    }

    if (response?.error === "HELPER_OFFLINE") {
      const variants = response.variants || [];
      renderVariants(variantContainer, variants, item);
      const count = variants.length;
      showNotice(count
        ? getMessage("msgStreamVariantsHint", { count: String(count), plural: count === 1 ? "" : "s" })
        : getMessage("msgStartHelperHint"), true);
      return;
    }

    showNotice(response?.error || getMessage("msgDownloadFailed"), true);
  } finally {
    if (releasePending) pendingDownloads.delete(item.url);
    if (!keepStatus) clearPendingStatus(statusContainer);
  }
}

// The helper could not fetch a direct file (e.g. 403 without the browser's
// cookies): offer Chrome's own downloader with the same file name.
function offerBrowserDownload(item, output, error) {
  const nodes = mediaNodes.get(item.url) || {};
  showNotice(getMessage("msgDirectHelperFailed", { error: error || getMessage("statusUnknownError") }), true, {
    label: getMessage("btnDownloadWithBrowser"),
    onClick: () => startDownload(item, nodes.variants, nodes.status, { ...output, viaBrowser: true })
  });
}

// Failed helper downloads of direct files stay retryable with Chrome from the
// job list, after the popup was closed and reopened.
function canRetryInBrowser(job) {
  return job.inputMode === "direct" && job.status === "failed" && /^https?:\/\//i.test(job.url || "");
}

function downloadJobWithBrowser(job) {
  const name = jobTitle(job);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "mp4";
  const item = { url: job.url, kind: "direct", extension, title: name, sourcePageUrl: job.sourcePageUrl || "" };
  startDownload(item, null, null, { filename: dot > 0 ? name.slice(0, dot) : name, viaBrowser: true });
}

function displayMediaTitle(item) {
  const base = sanitizeFilename(item.title, item.extension);
  if (item.kind !== "direct") return base;
  const details = [
    item.quality,
    item.size ? formatBytes(item.size) : item.estimatedSize ? `~${formatBytes(item.estimatedSize)}` : ""
  ].filter(Boolean);
  return details.length ? `${base} (${details.join(" · ")})` : base;
}

function renderVariants(container, variants, item = null) {
  if (!container) return;
  container.textContent = "";
  if (!variants.length) {
    container.hidden = true;
    return;
  }

  for (const variant of variants) {
    const chip = document.createElement(item ? "button" : "span");
    chip.className = "variant-chip";
    if (item) {
      chip.type = "button";
      chip.addEventListener("click", () => confirmDownload(
        item,
        (output) => startVariantDownload(item, variant, container.closest(".media-item")?.querySelector(".job-status"), output),
        variant
      ));
    }
    const quality = document.createElement("b");
    quality.textContent = variant.quality || getMessage("labelStream");
    const detail = document.createElement("small");
    const details = [
      variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "",
      variantSizeLabel(variant)
    ].filter(Boolean);
    // One fact per line inside the narrow ticket (CSS white-space: pre-line).
    detail.textContent = details.join("\n");
    chip.appendChild(quality);
    if (detail.textContent) chip.appendChild(detail);
    chip.title = [quality.textContent, ...details].join(" - ");
    container.appendChild(chip);
  }
  container.hidden = false;
}

async function startVariantDownload(item, variant, statusContainer, output = {}) {
  if (pendingDownloads.has(item.url)) {
    showNotice(getMessage("msgDownloadInProgress"), true);
    return;
  }
  pendingDownloads.add(item.url);

  let releasePending = true;
  let keepStatus = false;

  try {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGE.DOWNLOADS_START,
        item,
        variant,
        output
      });
    } catch (error) {
      console.error("[ds-video-downloader] startVariantDownload sendMessage failed", error);
      showNotice(getMessage("msgVariantFailed"), true);
      return;
    }

    if (response?.ok) {
      if (response.helperJob) {
        keepStatus = true;
        releasePending = false;
        showJobStatus(statusContainer, response.helperJob);
        pollJob(response.helperJob.id, statusContainer, () => pendingDownloads.delete(item.url));
        await loadHelperStatus();
      }
      showNotice(getMessage("msgVariantStreamStarted"));
      return;
    }

    if (response?.error === "HELPER_OFFLINE") {
      showNotice(getMessage("msgVariantHelperOffline"), true);
      return;
    }

    showNotice(response?.error || getMessage("msgVariantFailed"), true);
  } finally {
    if (releasePending) pendingDownloads.delete(item.url);
    if (!keepStatus) clearPendingStatus(statusContainer);
  }
}
function pollJob(jobId, container, onSettled) {
  if (!jobId || !container) {
    onSettled?.();
    return;
  }
  window.clearInterval(jobPollers.get(jobId));

  const timer = window.setInterval(async () => {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.DOWNLOADS_JOB_GET,
      jobId
    });

    if (!response?.ok) {
      container.hidden = false;
      container.classList.remove("is-running");
      container.classList.add("is-error");
      container.textContent = response?.error || getMessage("msgCouldNotReadHelperStatus");
      window.clearInterval(timer);
      jobPollers.delete(jobId);
      onSettled?.();
      return;
    }

    showJobStatus(container, response.job);
    if (response.job.status === "completed" || response.job.status === "failed" || response.job.status === "cancelled") {
      window.clearInterval(timer);
      jobPollers.delete(jobId);
      onSettled?.(response.job);
      await loadHelperStatus();
    }
  }, 1000);

  jobPollers.set(jobId, timer);
}
function clearPendingStatus(container) {
  if (!container) return;
  container.classList.remove("is-pending", "is-running");
  container.hidden = true;
  container.textContent = "";
}

function showJobStatus(container, job) {
  if (!container || !job) return;
  container.hidden = false;
  container.classList.toggle("is-running", job.status === "queued" || job.status === "running");
  setProgress(container, job);
  container.classList.toggle("is-complete", job.status === "completed");
  container.classList.toggle("is-error", job.status === "failed");
  container.classList.toggle("is-cancelled", job.status === "cancelled");

  if (job.status === "completed") {
    container.textContent = getMessage("statusCompletedLabel", { path: job.outputPath });
    return;
  }

  if (job.status === "failed") {
    container.textContent = getMessage("statusFailedLabel", { error: job.error || getMessage("statusUnknownError") });
    return;
  }

  if (job.status === "cancelled") {
    container.textContent = getMessage("statusStoppedByUser");
    return;
  }

  container.textContent = [humanStatus(job.status), job.progressText || ""].filter(Boolean).join(" - ");
}

async function showJobInFolder(jobId) {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_SHOW, jobId });
  if (!response?.ok) showNotice(response?.error || getMessage("msgCouldNotShowFile"), true);
}

function openRemoveDialog(jobId, fileExists, title) {
  if (!fileExists) {
    removeJob(jobId, "record");
    return;
  }

  openDialog(getMessage("removeDialogTitle"), title, "", [
    { label: getMessage("btnRemoveBoth"), className: "btn-danger", onClick: () => removeJob(jobId, "both") },
    { label: getMessage("btnRemoveFile"), onClick: () => removeJob(jobId, "file") },
    { label: getMessage("btnRemoveRecord"), onClick: () => removeJob(jobId, "record") },
    { label: getMessage("btnCancel"), className: "btn-ghost", focus: true }
  ], "remove-actions");
}

async function removeJob(jobId, mode) {
  if (mode === "file" || mode === "both") {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_DELETE, jobId });
    if (!response?.ok) {
      showNotice(response?.error || getMessage("msgCouldNotDeleteFile"), true);
      return;
    }
  }

  if (mode === "record" || mode === "both") {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_FORGET, jobId });
    if (!response?.ok) {
      showNotice(response?.error || getMessage("msgCouldNotRemoveRecord"), true);
      await loadHelperStatus();
      return;
    }
  }

  const messageKey = mode === "both" ? "msgRemovedBoth" : mode === "file" ? "msgDeletedOutput" : "msgRemovedRecord";
  showNotice(getMessage(messageKey));
  await loadHelperStatus();
}

async function clearMissingJobs() {
  clearMissingButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.DOWNLOADS_JOBS_CLEAR_MISSING
    });
    if (!response?.ok) {
      showNotice(response?.error === "HELPER_OFFLINE"
        ? getMessage("msgHelperOfflineClearMissing")
        : response?.error || getMessage("msgClearMissingFailed"), true);
      return;
    }
    showNotice(getMessage("msgClearMissingDone", { count: String(response.removedCount || 0) }));
    await loadHelperStatus();
  } finally {
    clearMissingButton.disabled = false;
  }
}

async function cancelJob(jobId) {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_CANCEL, jobId });
  if (!response?.ok) {
    showNotice(response?.error || getMessage("msgCouldNotStopJob"), true);
    return;
  }
  showNotice(getMessage("msgStoppedJob"));
  await loadHelperStatus();
}

async function resumeJob(jobId, button) {
  button.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_RESUME, jobId }).catch(() => null);
  if (response?.ok) {
    showNotice(getMessage("msgResumeStarted"));
  } else if (response?.error === "SOURCE_PAGE_OPENED") {
    showNotice(getMessage("msgResumeOpenPage"));
  } else {
    button.disabled = false;
    // A Bilibili resume needs the exact stream it started with.
    showNotice(response?.error === "FORMAT_SELECTION_REQUIRED"
      ? getMessage("biliErrResumeFormat")
      : bilibiliErrorMessage(response?.error, getMessage("msgResumeFailed")), true);
  }
  await loadHelperStatus();
}

// Every resumable job; the background resumes them one by one (Bilibili jobs
// need fresh stream URLs each) and opens no pages for streams that fail.
async function resumeAllJobs() {
  resumeAllButton.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOBS_RESUME_ALL }).catch(() => null);
  resumeAllButton.disabled = false;
  if (response?.ok) {
    showNotice(getMessage("msgResumeAllStarted", { count: String(response.resumed) }));
  } else {
    showNotice(getMessage("msgResumeAllPartial", {
      resumed: String(response?.resumed || 0),
      failed: String(response?.failed || 0),
      error: bilibiliErrorMessage(response?.error, getMessage("msgResumeFailed"))
    }), true);
  }
  await loadHelperStatus();
}

function openSourcePage(url) {
  if (!/^https?:\/\//i.test(url || "")) return;
  chrome.tabs.create({ url });
}

async function updateHelperDownloadDir() {
  const downloadDir = downloadDirInput.value.trim();
  if (!downloadDir) {
    showNotice(getMessage("msgEnterDownloadDir"), true);
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.HELPER_SETTINGS_UPDATE,
    settings: { downloadDir }
  });

  if (!response?.ok) {
    showNotice(response?.error === "HELPER_OFFLINE"
      ? getMessage("msgHelperOfflineSaveDir")
      : response?.error || getMessage("msgCouldNotSaveDir"), true);
    return;
  }

  downloadDirInput.value = response.settings?.downloadDir || downloadDir;
  showNotice(getMessage("msgDirSaved"));
  await loadHelperStatus();
}

async function pickHelperDownloadDir() {
  pickDownloadDirButton.disabled = true;
  showNotice(getMessage("msgPickerOpening"));
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.HELPER_FOLDER_PICK });
  pickDownloadDirButton.disabled = false;

  if (!response?.ok) {
    if (response?.error === "FOLDER_PICK_CANCELLED") return;
    showNotice(response?.error === "HELPER_OFFLINE"
      ? getMessage("msgHelperOfflinePickDir")
      : response?.error || getMessage("msgCouldNotOpenPicker"), true);
    return;
  }

  downloadDirInput.value = response.settings?.downloadDir || downloadDirInput.value;
  showNotice(getMessage("msgFolderSelected"));
  await loadHelperStatus();
}

function activatePanel(panelId) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.panel === panelId);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
}

function updateFilterSummary() {
  if (!settings) return;
  filterSummary.textContent = settings.minSizeBytes > 0
    ? getMessage("msgDirectFilesHidden", { size: formatBytes(settings.minSizeBytes) })
    : getMessage("msgNoSizeFilter");
}

function renderMediaMeta(container, item) {
  container.textContent = "";
  const chips = [
    { text: item.extension ? `.${item.extension}` : "", className: "" },
    { text: item.quality || "", className: "is-quality" },
    { text: mediaSizeLabel(item), className: item.estimatedSize && !item.size ? "is-quality" : "" },
    { text: item.isProtected ? item.unsupportedReason || getMessage("labelUnsupported") : "", className: "is-warning" }
  ].filter((chip) => chip.text);

  for (const chip of chips) {
    const element = document.createElement("span");
    element.className = `meta-chip ${chip.className}`.trim();
    element.textContent = chip.text;
    container.appendChild(element);
  }
}

function mediaSizeLabel(item) {
  if (item.size) return formatBytes(item.size);
  if (item.estimatedSize) return `~${formatBytes(item.estimatedSize)}`;
  return getMessage("labelSizeUnknown");
}

function variantSizeLabel(variant) {
  if (variant.size) return formatBytes(variant.size);
  if (variant.estimatedSize) return `${variant.sizeSource === "exact" ? "" : "~"}${formatBytes(variant.estimatedSize)}`;
  return "";
}

// A job's site ("site.example", from the helper) as a tag that filters by it.
// Cached offline jobs have no site, and keep the tag hidden.
function fillSiteTag(tag, job) {
  tag.hidden = !job.site;
  tag.textContent = job.site || "";
  tag.dataset.site = job.site || "";
}

function filterBySite(site) {
  if (!site) return;
  jobSiteSelect.value = site;
  // Shown even with a single site, so the active filter can be cleared.
  jobSiteSelect.hidden = false;
  loadHelperStatus();
}

// "All sites" plus every site in the helper's history with its count. Hidden
// with fewer than two sites, unless a site filter is active.
function renderSiteOptions(sites) {
  const allLabel = getMessage("filterAllSites");
  const signature = [allLabel, ...sites.map((entry) => `${entry.site}:${entry.count}`)].join("\n");
  if (signature !== renderedSites) {
    renderedSites = signature;
    const selected = jobSiteSelect.value;
    jobSiteSelect.textContent = "";
    for (const [value, label] of [["", allLabel], ...sites.map((entry) => [entry.site, `${entry.site} · ${entry.count}`])]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      jobSiteSelect.appendChild(option);
    }
    jobSiteSelect.value = sites.some((entry) => entry.site === selected) ? selected : "";
  }
  jobSiteSelect.hidden = sites.length < 2 && !jobSiteSelect.value;
}

// Writes text into el with the search words wrapped in <mark>. Built from
// text nodes, so a file name never turns into HTML.
function setHighlighted(el, text, words) {
  el.textContent = "";
  let pos = 0;
  for (const [start, end] of highlightRanges(text, words)) {
    if (start > pos) el.append(text.slice(pos, start));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    el.append(mark);
    pos = end;
  }
  el.append(text.slice(pos));
}

function jobTitle(job) {
  const name = String(job.outputPath || job.url || getMessage("statusHelperJob")).split(/[\\/]/).pop();
  return name || getMessage("statusHelperJob");
}

function runningCount(jobs) {
  return jobs.filter((job) => job.status === "queued" || job.status === "running").length;
}

function humanStatus(value) {
  const statusMap = {
    queued: getMessage("statusQueued"),
    running: getMessage("statusDownloading"),
    completed: getMessage("statusCompleted"),
    failed: getMessage("statusFailed"),
    cancelled: getMessage("statusStopped"),
    missing: getMessage("statusMissing")
  };
  return statusMap[value] || value || getMessage("statusDownloading");
}

function humanJobMessage(job) {
  const message = baseJobMessage(job);
  if (job.resumable) return `${message} ${getMessage("msgDownloadResumable")}`;
  const isActive = job.status === "queued" || job.status === "running";
  const mode = { extension: "labelModeExtension", page: "labelModePage" }[job.downloadMode];
  return isActive && mode ? `${getMessage(mode)} · ${message}` : message;
}

function baseJobMessage(job) {
  const live = liveByteProgress(job);
  if (live) return live;
  if (job.error === "DOWNLOAD_STALLED") return job.progressText || getMessage("msgDownloadStalled");
  if (job.error === "HELPER_RESTARTED") return getMessage("msgHelperRestarted");
  if (job.error === "SOURCE_PAGE_CLOSED") return getMessage("msgSourcePageClosed");
  if (String(job.error || "").startsWith("BROWSER_BLOCKED")) return getMessage("msgBrowserBlocked");
  return job.error || job.progressText || sizeLabel(job);
}

// Running helper downloads (direct files, Bilibili) as "1.2 GB / 1.6 GB ·
// 5.0 MB/s · 1:02 left", from the job's numbers so it follows the popup's
// language. "" where the helper's own progress text says more.
function liveByteProgress(job) {
  if (job.inputMode !== "direct" && job.inputMode !== "bilibili") return "";
  if (job.status === "queued") return getMessage("jobWaitingSlot");
  if (job.status !== "running") return "";
  if (job.phase === "merge") return getMessage("jobMerging");
  if (!job.totalBytes) return "";
  const pieces = [`${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`];
  if (job.transferRateBytesPerSecond > 0) pieces.push(`${formatBytes(job.transferRateBytesPerSecond)}/s`);
  if (job.etaSeconds != null) pieces.push(getMessage("jobEta", { eta: formatClock(job.etaSeconds) || "0:00" }));
  return pieces.join(" · ");
}

// "Running 42%" while a job runs and its progress is known.
function jobStateText(job) {
  const fraction = job.status === "running" ? jobProgressFraction(job) : null;
  return fraction === null ? humanStatus(job.status) : `${humanStatus(job.status)} ${Math.floor(fraction * 100)}%`;
}

function sizeLabel(job) {
  if (!job.totalBytes) return getMessage("labelTotalUnknown");
  return `${job.totalSizeSource === "estimated" ? "~" : ""}${formatBytes(job.totalBytes)} ${job.totalSizeSource || ""}`.trim();
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function setTabCount(element, count) {
  if (!element) return;
  element.textContent = count > 0 ? String(count) : "";
  element.hidden = !(count > 0);
}

// Progress bars read a --p custom property. Unknown progress leaves it unset,
// and adds is-indeterminate, which the CSS renders as a sliding "working" bar.
function setProgress(element, job) {
  const fraction = jobProgressFraction(job);
  element.classList.toggle("is-indeterminate", fraction === null);
  if (fraction === null) element.style.removeProperty("--p");
  else element.style.setProperty("--p", `${(fraction * 100).toFixed(1)}%`);
}

// Helper panel headline tile: one queued/running job and its progress.
// Hidden when nothing is active, so the helper status tile takes the full row.
// With several active jobs it switches to the next one every RUN_ROTATE_MS
// (on the 2 s status poll, paused while hovered); step -1/+1 switches now.
function renderRunTile(jobs, step = 0) {
  lastRunJobs = jobs;
  const active = jobs.filter((entry) => entry.status === "running" || entry.status === "queued");
  runTile.hidden = !active.length;
  runNav.hidden = active.length < 2;
  runDots.hidden = active.length < 2;
  if (!active.length) return;

  const now = Date.now();
  let index = active.findIndex((entry) => entry.id === runJobId);
  if (index < 0) {
    index = 0;
    runShownAt = now;
  } else if (step || (active.length > 1 && now - runShownAt >= RUN_ROTATE_MS && !runTile.matches?.(":hover"))) {
    index = (index + (step || 1) + active.length) % active.length;
    runShownAt = now;
  }
  const job = active[index];
  runJobId = job.id;
  runPos.textContent = `${index + 1}/${active.length}`;
  // Keep the dots between polls so the active one animates when it moves.
  if (runDots.children.length !== active.length) {
    runDots.textContent = "";
    for (let dot = 0; dot < active.length; dot += 1) runDots.appendChild(document.createElement("i"));
  }
  Array.from(runDots.children).forEach((mark, dot) => mark.classList.toggle("is-active", dot === index));
  const fraction = jobProgressFraction(job);
  runTitle.textContent = jobTitle(job);
  runValue.textContent = fraction === null ? humanStatus(job.status) : String(Math.floor(fraction * 100));
  runValue.classList.toggle("is-word", fraction === null);
  setProgress(runTile, job);
}

// Template clones never pass through applyLanguageUI, so translate them here.
function translateNode(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = getMessage(el.getAttribute("data-i18n"));
  }
}

// action: optional { label, onClick } shown as a button inside the notice.
function showNotice(message, isError = false, action = null) {
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle("error", isError);
  if (!action) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button notice-action";
  button.textContent = action.label;
  button.addEventListener("click", () => {
    hideNotice();
    action.onClick();
  });
  notice.appendChild(button);
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("error");
}
