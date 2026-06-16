import { MESSAGE, sanitizeFilename } from "./shared.js";
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
const minSizeSelect = document.querySelector("#minSizeSelect");
const showUnsupportedInput = document.querySelector("#showUnsupportedInput");
const downloadDirInput = document.querySelector("#downloadDirInput");
const saveDownloadDirButton = document.querySelector("#saveDownloadDirButton");
const pickDownloadDirButton = document.querySelector("#pickDownloadDirButton");
const langSelector = document.querySelector("#langSelector");

let activeTab = null;
let settings = null;
const jobPollers = new Map();
const pendingDownloads = new Set();
let statusLoading = false;
let statusPending = false;

rescanButton.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  await chrome.tabs.sendMessage(activeTab.id, { type: "page:rescan" }).catch(() => {});
  window.setTimeout(loadMedia, 300);
});

refreshHelperButton.addEventListener("click", loadHelperStatus);

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
window.setInterval(loadHelperStatus, 2000);

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

async function loadMedia() {
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

  renderMedia(response.items || []);
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
    const downloadDir = response?.health?.downloadDir || "";

    console.log("[ds-video-downloader] loadHelperStatus online=%s jobs=%d cached=%d",
      online, liveJobs.length, cachedJobs.length);

    // Merge: live jobs take priority, then fill with cached history
    const liveIds = new Set(liveJobs.map(j => j.id));
    const merged = [
      ...liveJobs,
      ...cachedJobs.filter(j => !liveIds.has(j.id))
    ].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")).slice(0, 20);

    try {
      helperSummary.textContent = online
        ? getMessage("msgActiveJobs", { active: String(runningCount(liveJobs)), total: String(liveJobs.length), plural: liveJobs.length === 1 ? "" : "s" })
        : getMessage("statusHelperOffline");
      helperStatus.className = `helper-status ${online ? "is-online" : "is-offline"}`;
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

function renderMedia(items) {
  list.textContent = "";
  mediaCount.textContent = getMessage("msgCountDetected", { count: String(items.length) });

  if (!items.length) {
    showNotice(getMessage("msgEmptyHint"));
    return;
  }

  hideNotice();
  for (const item of items) {
    const node = template.content.firstElementChild.cloneNode(true);
    const title = node.querySelector(".media-title");
    const kind = node.querySelector(".media-kind");
    const meta = node.querySelector(".media-meta-row");
    const variants = node.querySelector(".variant-list");
    const status = node.querySelector(".job-status");
    const button = node.querySelector(".download-button");

    title.textContent = sanitizeFilename(item.title, item.extension);
    kind.textContent = item.kind.toUpperCase();
    renderMediaMeta(meta, item);
    renderVariants(variants, item.variants || [], item);

    // Remove the separate download button — clicking the media item itself initiates download
    if (button) button.remove();

    // Make the entire media item a clickable download trigger
    node.style.cursor = "pointer";
    node.title = item.isProtected
      ? (item.unsupportedReason || "Unsupported")
      : `Click to download ${sanitizeFilename(item.title, item.extension)}`;

    if (!item.isProtected) {
      node.addEventListener("click", (e) => {
        // Don't trigger when clicking variant chips (those have their own handlers)
        if (e.target.closest(".variant-chip")) return;
        confirmDownload(item, () => startDownload(item, variants, status));
      });
    }

    list.appendChild(node);
  }
}

const helperJobNodes = new Map();

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
      const cancelBtn = existing.querySelector(".cancel-button");
      const showBtn = existing.querySelector(".show-button");
      const deleteBtn = existing.querySelector(".delete-button");

      state.textContent = humanStatus(job.status);
      state.className = `helper-job-state ${job.status === "completed" ? "is-complete" : ""} ${job.status === "failed" ? "is-error" : ""} ${job.status === "cancelled" ? "is-cancelled" : ""}`;
      meta.textContent = job.error || job.progressText || sizeLabel(job);
      pathEl.textContent = job.outputPath || job.url;

      const isActive = job.status === "queued" || job.status === "running";
      const isFinished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
      cancelBtn.disabled = !isActive;
      showBtn.disabled = !job.outputPath;
      deleteBtn.disabled = !isFinished;
    } else {
      // Create new node
      const node = helperJobTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.jobId = job.id;
      node.querySelector(".helper-job-title").textContent = jobTitle(job);
      const state = node.querySelector(".helper-job-state");
      state.textContent = humanStatus(job.status);
      state.classList.toggle("is-complete", job.status === "completed");
      state.classList.toggle("is-error", job.status === "failed");
      state.classList.toggle("is-cancelled", job.status === "cancelled");
      node.querySelector(".helper-job-meta").textContent = job.error || job.progressText || sizeLabel(job);
      node.querySelector(".helper-job-path").textContent = job.outputPath || job.url;

      const cancelButton = node.querySelector(".cancel-button");
      const showButton = node.querySelector(".show-button");
      const deleteButton = node.querySelector(".delete-button");
      const isActive = job.status === "queued" || job.status === "running";
      const isFinished = job.status === "completed" || job.status === "failed" || job.status === "cancelled";
      cancelButton.disabled = !isActive;
      showButton.disabled = !job.outputPath;
      deleteButton.disabled = !isFinished;
      cancelButton.addEventListener("click", () => cancelJob(job.id));
      showButton.addEventListener("click", () => showJobInFolder(job.id));
      deleteButton.addEventListener("click", () => deleteJob(job.id));

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

function confirmDownload(item, callback) {
  // Remove any existing overlay
  const existing = document.querySelector(".confirm-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const title = sanitizeFilename(item.title, item.extension);
  const quality = item.quality ? ` (${item.quality})` : "";
  const kindLabel = item.kind === "direct" ? "Direct download" : `${item.kind.toUpperCase()} stream`;

  overlay.innerHTML = `
    <div class="confirm-dialog">
      <h3>Start Download</h3>
      <p>${title}${quality}<br><span style="color:var(--faint);font-size:10px;">${kindLabel}</span></p>
      <div class="confirm-actions">
        <button class="btn-cancel">Cancel</button>
        <button class="btn-primary">Download</button>
      </div>
    </div>
  `;

  overlay.querySelector(".btn-cancel").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".btn-primary").addEventListener("click", () => {
    overlay.remove();
    callback();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}

async function startDownload(item, variantContainer, statusContainer) {
  // Optimistic feedback + double-click guard
  const downloadButton = statusContainer?.closest(".media-item")?.querySelector(".download-button");
  if (pendingDownloads.has(item.url)) return;
  pendingDownloads.add(item.url);

  if (downloadButton) {
    downloadButton.disabled = true;
    downloadButton.textContent = "Starting...";
  }
  if (statusContainer) {
    statusContainer.hidden = false;
    statusContainer.classList.add("is-pending");
    statusContainer.textContent = "Connecting to helper...";
  }

  if (item.kind === "direct") {
    const hasPermission = await chrome.permissions.contains({ permissions: ["downloads"] });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ permissions: ["downloads"] });
      if (!granted) {
        pendingDownloads.delete(item.url);
        if (downloadButton) {
          downloadButton.disabled = false;
          downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
        }
        if (statusContainer) statusContainer.classList.remove("is-pending");
        showNotice(getMessage("msgDownloadPermission"), true);
        return;
      }
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.DOWNLOADS_START,
    item
  });

  console.log("[ds-video-downloader] startDownload response ok=%s helperJob=%s error=%s",
    response?.ok, Boolean(response?.helperJob), response?.error);

  pendingDownloads.delete(item.url);
  if (statusContainer) statusContainer.classList.remove("is-pending");

  if (response?.ok) {
    if (response.helperJob) {
      showJobStatus(statusContainer, response.helperJob);
      pollJob(response.helperJob.id, statusContainer);
      await loadHelperStatus();
      showNotice(getMessage("msgHelperStreamStarted"));
    } else {
      showNotice(getMessage("msgDownloadStarted"));
    }
    return;
  }

  if (response?.error === "DRM_PROTECTED_UNSUPPORTED") {
    if (downloadButton) {
      downloadButton.disabled = false;
      downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
    }
    showNotice(getMessage("msgDrmUnsupported"), true);
    return;
  }

  if (response?.error === "SERVER_PROTECTED_UNSUPPORTED") {
    if (downloadButton) {
      downloadButton.disabled = false;
      downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
    }
    showNotice(getMessage("msgServerBlocked"), true);
    return;
  }

  if (response?.error === "HELPER_OFFLINE") {
    const variants = response.variants || [];
    renderVariants(variantContainer, variants, item);
    const count = variants.length;
    if (downloadButton) {
      downloadButton.disabled = false;
      downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
    }
    showNotice(count
      ? getMessage("msgStreamVariantsHint", { count: String(count), plural: count === 1 ? "" : "s" })
      : getMessage("msgStartHelperHint"), true);
    return;
  }

  if (response?.error === "STREAM_VARIANTS_ONLY") {
    if (downloadButton) {
      downloadButton.disabled = false;
      downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
    }
    renderVariants(variantContainer, response.variants || [], item);
    return;
  }

  if (downloadButton) {
    downloadButton.disabled = false;
    downloadButton.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
  }
  showNotice(response?.error || getMessage("msgDownloadFailed"), true);
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
      chip.addEventListener("click", () => confirmDownload(item, () => startVariantDownload(item, variant, container.closest(".media-item")?.querySelector(".job-status"))));
    }
    chip.textContent = [
      variant.quality || getMessage("labelStream"),
      variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "",
      variantSizeLabel(variant)
    ].filter(Boolean).join(" - ");
    container.appendChild(chip);
  }
  container.hidden = false;
}

async function startVariantDownload(item, variant, statusContainer) {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.DOWNLOADS_START,
    item,
    variant
  });

  if (response?.ok) {
    if (response.helperJob) {
      showJobStatus(statusContainer, response.helperJob);
      pollJob(response.helperJob.id, statusContainer);
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
}

function pollJob(jobId, container) {
  if (!jobId || !container) return;
  window.clearInterval(jobPollers.get(jobId));

  const timer = window.setInterval(async () => {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.DOWNLOADS_JOB_GET,
      jobId
    });

    if (!response?.ok) {
      container.hidden = false;
      container.classList.add("is-error");
      container.textContent = response?.error || getMessage("msgCouldNotReadHelperStatus");
      window.clearInterval(timer);
      jobPollers.delete(jobId);
      return;
    }

    showJobStatus(container, response.job);
    if (response.job.status === "completed" || response.job.status === "failed" || response.job.status === "cancelled") {
      window.clearInterval(timer);
      jobPollers.delete(jobId);
      await loadHelperStatus();
    }
  }, 1000);

  jobPollers.set(jobId, timer);
}

function showJobStatus(container, job) {
  if (!container || !job) return;
  container.hidden = false;
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

async function deleteJob(jobId) {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.DOWNLOADS_JOB_DELETE, jobId });
  if (!response?.ok) {
    showNotice(response?.error || getMessage("msgCouldNotDeleteFile"), true);
    return;
  }
  showNotice(getMessage("msgDeletedOutput"));
  await loadHelperStatus();
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
    cancelled: getMessage("statusStopped")
  };
  return statusMap[value] || value || getMessage("statusDownloading");
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

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.toggle("error", isError);
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("error");
}
