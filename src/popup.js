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
await loadSettings();
await loadMedia();
await loadHelperStatus();
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
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.HELPER_STATUS_GET });
  const online = Boolean(response?.online);
  const jobs = response?.jobs || [];
  const downloadDir = response?.health?.downloadDir || "";

  helperSummary.textContent = online
    ? getMessage("msgActiveJobs", { active: String(runningCount(jobs)), total: String(jobs.length), plural: jobs.length === 1 ? "" : "s" })
    : getMessage("statusHelperOffline");
  helperStatus.className = `helper-status ${online ? "is-online" : "is-offline"}`;
  helperStatus.textContent = online
    ? getMessage("msgHelperRunning", { dir: downloadDir || getMessage("labelDefaultFolder") })
    : getMessage("msgHelperEmpty");

  if (online && downloadDir && document.activeElement !== downloadDirInput) {
    downloadDirInput.value = downloadDir;
  }

  renderHelperJobs(jobs);
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
    const button = node.querySelector(".download-button");
    const variants = node.querySelector(".variant-list");
    const status = node.querySelector(".job-status");

    title.textContent = sanitizeFilename(item.title, item.extension);
    kind.textContent = item.kind.toUpperCase();
    renderMediaMeta(meta, item);
    renderVariants(variants, item.variants || [], item);
    button.disabled = Boolean(item.isProtected);
    button.textContent = item.kind === "direct" ? getMessage("btnSave") : getMessage("btnDownload");
    button.addEventListener("click", () => startDownload(item, variants, status));

    list.appendChild(node);
  }
}

function renderHelperJobs(jobs) {
  helperJobs.textContent = "";
  if (!jobs.length) {
    helperJobs.innerHTML = `<div class="helper-status">${getMessage("msgNoJobs")}</div>`;
    return;
  }

  for (const job of jobs) {
    const node = helperJobTemplate.content.firstElementChild.cloneNode(true);
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
  }
}

async function startDownload(item, variantContainer, statusContainer) {
  if (item.kind === "direct") {
    const hasPermission = await chrome.permissions.contains({ permissions: ["downloads"] });
    if (!hasPermission) {
      const granted = await chrome.permissions.request({ permissions: ["downloads"] });
      if (!granted) {
        showNotice(getMessage("msgDownloadPermission"), true);
        return;
      }
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.DOWNLOADS_START,
    item
  });

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

  if (response?.error === "STREAM_VARIANTS_ONLY") {
    renderVariants(variantContainer, response.variants || [], item);
    return;
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
      chip.addEventListener("click", () => startVariantDownload(item, variant, container.closest(".media-item")?.querySelector(".job-status")));
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
