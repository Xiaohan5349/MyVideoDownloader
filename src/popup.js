import { MESSAGE, jobProgressFraction, sanitizeFilename, sortMediaByQuality } from "./shared.js";
import { getMessage, getUserLanguage, setUserLanguage, applyLanguageUI } from "./i18n.js";

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
const openDashboardButton = document.querySelector("#openDashboardButton");
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
// Download dialog saved while the Windows folder picker is open: the popup
// closes when it loses focus, and restores the dialog when it reopens.
const PENDING_DIALOG_KEY = "pendingDownloadDialog";
const PENDING_DIALOG_TTL_MS = 10 * 60_000;

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

refreshHelperButton.addEventListener("click", loadHelperStatus);
document.querySelector("#runPrev").addEventListener("click", () => renderRunTile(lastRunJobs, -1));
document.querySelector("#runNext").addEventListener("click", () => renderRunTile(lastRunJobs, 1));
clearMissingButton.addEventListener("click", clearMissingJobs);
openDashboardButton.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:8765" });
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
await Promise.all([loadSettings(), loadMedia(), loadHelperStatus()]);
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
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.HELPER_STATUS_GET });
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

    renderHelperJobs(merged);
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
  mediaCount.textContent = getMessage("msgCountDetected", { count: String(items.length) });
  mediaCountNum.textContent = String(items.length);
  setTabCount(mediaTabCount, items.length);

  if (!items.length) {
    list.textContent = "";
    mediaNodes.clear();
    showNotice(getMessage("msgEmptyHint"));
    return;
  }

  if (!live || notice.textContent === getMessage("msgEmptyHint")) hideNotice();
  const seen = new Set();
  for (const item of items) {
    seen.add(item.url);
    const entry = mediaNodes.get(item.url) || createMediaNode();
    entry.item = item;
    fillMediaNode(entry);
    mediaNodes.set(item.url, entry);
    list.appendChild(entry.node); // re-appending also moves it into sort order
  }
  for (const [url, entry] of mediaNodes) {
    if (seen.has(url)) continue;
    entry.node.remove();
    mediaNodes.delete(url);
  }
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

function renderHelperJobs(jobs) {
  if (!helperJobTemplate) {
    console.warn("[ds-video-downloader] helperJobTemplate not found in DOM");
    return;
  }
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

      state.textContent = humanStatus(job.status);
      state.className = `helper-job-state ${job.status === "completed" ? "is-complete" : ""} ${job.status === "failed" ? "is-error" : ""} ${job.status === "cancelled" ? "is-cancelled" : ""} ${job.status === "missing" ? "is-missing" : ""}`;
      meta.textContent = humanJobMessage(job);
      pathEl.textContent = job.outputPath || job.url;
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
    } else {
      // Create new node
      const node = helperJobTemplate.content.firstElementChild.cloneNode(true);
      translateNode(node);
      node.dataset.jobId = job.id;
      node.dataset.status = job.status;
      setProgress(node, job);
      node.querySelector(".helper-job-title").textContent = jobTitle(job);
      const state = node.querySelector(".helper-job-state");
      state.textContent = humanStatus(job.status);
      state.classList.toggle("is-complete", job.status === "completed");
      state.classList.toggle("is-error", job.status === "failed");
      state.classList.toggle("is-cancelled", job.status === "cancelled");
      state.classList.toggle("is-missing", job.status === "missing");
      node.querySelector(".helper-job-meta").textContent = humanJobMessage(job);
      node.querySelector(".helper-job-path").textContent = job.outputPath || job.url;

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

      helperJobs.appendChild(node);
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

  if (!jobs.length) {
    helperJobs.innerHTML = `<div class="helper-status">${getMessage("msgNoJobs")}</div>`;
    helperJobNodes.clear();
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

  const dirInput = document.createElement("input");
  dirInput.type = "text";
  dirInput.value = initial.downloadDir || helperDownloadDir;
  dirInput.spellcheck = false;
  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "ghost-button";
  browseButton.textContent = getMessage("btnBrowse");
  if (chooseFolder) {
    fields.appendChild(dialogField(getMessage("dialogFolderLabel"), dirInput, browseButton));
  } else {
    const hint = document.createElement("p");
    hint.className = "confirm-hint";
    hint.textContent = getMessage("dialogChromeFolderHint");
    fields.appendChild(hint);
  }

  const overlay = openDialog(getMessage("confirmDownloadTitle"), "", kindLabel, [
    { label: getMessage("btnCancel"), className: "btn-ghost" },
    {
      label: getMessage("btnDownload"),
      className: "btn-primary",
      onClick: () => onConfirm({
        filename: nameInput.value.trim(),
        downloadDir: chooseFolder ? dirInput.value.trim() : ""
      })
    }
  ], "", { content: fields, onClose: clearPendingDialog });

  const submit = (event) => {
    if (event.key === "Enter") overlay.querySelector(".btn-primary")?.click();
  };
  nameInput.addEventListener("keydown", submit);
  dirInput.addEventListener("keydown", submit);

  browseButton.addEventListener("click", async () => {
    browseButton.disabled = true;
    await chrome.storage.session?.set({
      [PENDING_DIALOG_KEY]: {
        tabId: activeTab?.id,
        item,
        variant,
        filename: nameInput.value,
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

  nameInput.focus?.();
  nameInput.select?.();
  return overlay;
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
  if (!state?.item) return;
  if (state.tabId !== activeTab?.id || Date.now() - state.savedAt > PENDING_DIALOG_TTL_MS) {
    await clearPendingDialog();
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
    showNotice(response?.error || getMessage("msgResumeFailed"), true);
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
  if (job.error === "DOWNLOAD_STALLED") return job.progressText || getMessage("msgDownloadStalled");
  if (job.error === "HELPER_RESTARTED") return getMessage("msgHelperRestarted");
  if (job.error === "SOURCE_PAGE_CLOSED") return getMessage("msgSourcePageClosed");
  if (String(job.error || "").startsWith("BROWSER_BLOCKED")) return getMessage("msgBrowserBlocked");
  return job.error || job.progressText || sizeLabel(job);
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
