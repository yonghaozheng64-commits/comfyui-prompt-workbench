import { loadState, clone, uid } from './state.js';
import { storage } from './storage.js';
import { t, format, prompt, confirm, LOCALE_KEY, currentLocale, initializeI18n } from './i18n.js';
import { templateFillField, jobCount, jobAt } from './batch.js';
import { downloadBackup, validateBackup } from './backup.js';
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { automaticChineseName, bilingualLoraName, looksLikeLora, normalizeLoraKey, translatedLoraName } from "./lora_i18n.js";

const STORAGE_KEY = "prompt-workbench-state-v2";
const SIDEBAR_WIDTH_KEY = "prompt-workbench-sidebar-width";
const BATCH_RUN_PLAN_KEY = "prompt-workbench-batch-run-plan-v1";
const BATCH_RUN_PROGRESS_KEY = "prompt-workbench-batch-run-progress-v1";
const QUEUE_PAGE_SIZE = 25;
const BATCH_SELECTION_PREVIEW_LIMIT = 40;
// A queued prompt contains a complete workflow snapshot. Keeping hundreds of
// snapshots in the renderer makes Chromium retain enough graph/UI state to
// crash the tab. Feed ComfyUI gradually instead.
const BATCH_QUEUE_HIGH_WATER = 8;
const BATCH_QUEUE_POLL_MS = 2000;
const BATCH_SUBMIT_YIELD_MS = 80;
const MODEL_FILE = /\.(safetensors|ckpt|pt|bin|pth|png|jpe?g|webp|gif|mp4|webm|wav|mp3)$/i;
const TEXT_INPUT = /(text|prompt|positive|negative|string|caption|description|tags?|instruction)/i;

let state = loadState();
let queueRoot;
let promptRoot;
let selectionsRoot;
let outputArea;
let templateRoot;
let batchRoot;
let clipTextRoot;
let loraRoot;
let loraSearch;
let loraModelSelect;
let loraItems = [];
let loraLoaded = false;
let loraLoadPromise;
let loraRenderPromise;
let loraRenderDirty = false;
let loraSearchTimer;
let metadataAliases = {};
const knownLoraFiles = new Set();
const expandedLoraEntries = new Set();
let activeTab = "queue";
let activeTemplateId = state.templates[0]?.id;
let activeFieldId = state.templates[0]?.fields.find((field) => !field.fixed)?.id;
let refreshTimer;
let saveStateTimer;
let queueRenderPromise;
let queueRenderTimer;
let queueVisibleLimit = QUEUE_PAGE_SIZE;
let batchQueueRunning = false;
let batchPauseRequested = false;
let batchRunPlan = loadStoredJson(BATCH_RUN_PLAN_KEY);
let batchRunProgress = loadStoredJson(BATCH_RUN_PROGRESS_KEY);
let workflowOnly = false;
let loadedWorkflowNodes = [];
let assetRedoObserver;
let characterArchiveQueueHookInstalled = false;
let batchProgressTrackingInstalled = false;
let translationObserver;

function loadStoredJson(key) {
  try {
    const value = JSON.parse(storage.getItem(key));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function validBatchRun() {
  return batchRunPlan?.id && batchRunProgress?.runId === batchRunPlan.id
    && Array.isArray(batchRunPlan.templates) && Array.isArray(batchRunPlan.entries);
}

function persistBatchRunPlan() {
  if (batchRunPlan) storage.setItem(BATCH_RUN_PLAN_KEY, JSON.stringify(batchRunPlan));
  else storage.removeItem(BATCH_RUN_PLAN_KEY);
}

function persistBatchRunProgress() {
  if (batchRunProgress) storage.setItem(BATCH_RUN_PROGRESS_KEY, JSON.stringify(batchRunProgress));
  else storage.removeItem(BATCH_RUN_PROGRESS_KEY);
}

function clearBatchRun() {
  if (batchQueueRunning) return;
  batchRunPlan = undefined;
  batchRunProgress = undefined;
  persistBatchRunPlan();
  persistBatchRunProgress();
  // Rebuilding the whole batch panel for every execution event while the
  // producer is active creates avoidable DOM churn and can invalidate its
  // progress button. The producer already updates that button in place.
  if (!batchQueueRunning) renderBatchPanel();
}

function batchJobIndexForPrompt(promptId) {
  if (!promptId || !validBatchRun()) return -1;
  for (const [index, job] of Object.entries(batchRunProgress.jobs || {})) {
    if (String(job?.promptId || "") === String(promptId)) return Number(index);
  }
  return -1;
}

function trackBatchExecution(event, phase) {
  const promptId = event?.detail?.prompt_id || event?.detail?.promptId;
  const index = batchJobIndexForPrompt(promptId);
  if (index < 0) return;
  if (phase === "start") {
    batchRunProgress.executionIndex = index;
    batchRunProgress.resumeIndex = index;
    batchRunProgress.status = "executing";
  } else if (phase === "success") {
    batchRunProgress.jobs[String(index)].completed = true;
    batchRunProgress.completedThrough = Math.max(Number(batchRunProgress.completedThrough || 0), index + 1);
    batchRunProgress.resumeIndex = Math.max(Number(batchRunProgress.resumeIndex || 0), index + 1);
    batchRunProgress.status = index + 1 >= batchRunJobCount() ? "completed" : "queued";
  } else {
    batchRunProgress.executionIndex = index;
    batchRunProgress.resumeIndex = index;
    batchRunProgress.status = "interrupted";
  }
  if (batchRunProgress.paused) batchRunProgress.status = 'paused';
  persistBatchRunProgress();
  if (!batchQueueRunning) renderBatchPanel();
}

function installBatchProgressTracking() {
  if (batchProgressTrackingInstalled) return;
  batchProgressTrackingInstalled = true;
  api.addEventListener("execution_start", (event) => trackBatchExecution(event, "start"));
  api.addEventListener("execution_success", (event) => trackBatchExecution(event, "success"));
  api.addEventListener("execution_error", (event) => trackBatchExecution(event, "error"));
  api.addEventListener("execution_interrupted", (event) => trackBatchExecution(event, "interrupted"));
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = t(text);
  return node;
};

const button = (label, onClick, className = "") => {
  const node = el("button", `pwb-button ${className}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};

function persistState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = undefined;
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(persistState, 150);
}

window.addEventListener("pagehide", persistState);
window.addEventListener('pwb-storage-error', () => toast(t("Save failed"), t("Browser storage is unavailable. Export a backup before closing this page."), 'error'));

function displayAliases() {
  return { ...metadataAliases, ...state.loraAliases };
}

function exposeLoraTranslation() {
  window.PromptWorkbenchLoraI18n = {
    label: (value) => bilingualLoraName(value, displayAliases()),
    search: (term, limit = 20) => {
      const needle = String(term || "").trim().toLowerCase();
      if (!needle) return [];
      return [...knownLoraFiles]
        .filter((value) => `${value} ${bilingualLoraName(value, displayAliases())}`.toLowerCase().includes(needle))
        .slice(0, limit);
    },
  };
}

function toast(summary, detail, severity = "info") {
  if (app.extensionManager?.toast?.add) app.extensionManager.toast.add({ severity, summary: t(summary), detail: t(detail), life: 3500 });
  else console.warn('Prompt Workbench:', t(summary), t(detail));
}

function installCharacterArchiveQueueHook() {
  if (characterArchiveQueueHookInstalled) return;
  characterArchiveQueueHookInstalled = true;
  const queuePrompt = api.queuePrompt.bind(api);
  api.queuePrompt = async (number, prompt, ...args) => {
    if (state.autoCharacterFolders && prompt?.output) {
      try {
        const response = await api.fetchApi("/lora-trigger-helper/character-archive/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ output: prompt.output }),
        });
        if (response.ok) {
          const result = await response.json();
          if (result.output) prompt.output = result.output;
        }
      } catch (error) {
        console.warn("Prompt Workbench character archive:", error);
      }
    }
    return queuePrompt(number, prompt, ...args);
  };
}

function ensureStyles() {
  if (document.querySelector('link[data-prompt-workbench="styles"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./prompt_workbench.css", import.meta.url).href;
  link.dataset.promptWorkbench = "styles";
  document.head.append(link);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function workflowNodeMap(extraData) {
  const nodes = extraData?.extra_pnginfo?.workflow?.nodes || [];
  return new Map(nodes.map((node) => [String(node.id), node]));
}

function extractPromptText(item) {
  const prompt = item?.[2] || {};
  const nodeMap = workflowNodeMap(item?.[3]);
  const results = [];
  const seen = new Set();
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const [name, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== "string") continue;
      const text = normalizeText(value);
      if (!text || MODEL_FILE.test(text)) continue;
      if (!TEXT_INPUT.test(name) && text.length < 18 && !text.includes(",")) continue;
      const key = `${nodeId}:${name}:${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const workflowNode = nodeMap.get(String(nodeId));
      results.push({ node: workflowNode?.title || workflowNode?.type || node.class_type || format("Node {0}", [nodeId]), input: name, text });
    }
  }
  return results;
}

function templateTaskSummary(item) {
  const extraData = item?.[3] || {};
  const workflowExtra = extraData?.extra_pnginfo?.workflow?.extra;
  const metadata = workflowExtra?.prompt_workbench_template_task || extraData.prompt_workbench_template_task;
  if (!metadata || typeof metadata !== "object") return null;
  const template = normalizeText(metadata.template);
  const character = normalizeText(metadata.character);
  if (!template && !character) return null;
  return {
    template: template || t("Untitled template"),
    character: character || t("Manual character"),
  };
}

function taskTime(item) {
  const timestamp = item?.[3]?.create_time;
  return timestamp ? new Date(timestamp).toLocaleString() : t("Unknown time");
}

async function cancelPending(promptId) {
  if (!confirm(t("Cancel this queued task?"))) return;
  const response = await api.fetchApi("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!response.ok) return toast(t("Cancel failed"), await response.text(), "error");
  await renderQueue();
}

async function cancelTaskForRedo(promptId, status) {
  const modern = await api.fetchApi(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (modern.ok) return;
  if (modern.status !== 404 && modern.status !== 405) {
    throw new Error((await modern.text()) || format("Could not cancel the original task (HTTP {0})", [modern.status]));
  }
  const endpoint = status === "running" ? "/interrupt" : "/queue";
  const body = status === "running" ? { prompt_id: promptId } : { delete: [promptId] };
  const fallback = await api.fetchApi(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!fallback.ok) throw new Error((await fallback.text()) || format("Could not cancel the original task (HTTP {0})", [fallback.status]));
}

function nextRandomSeed() {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return (values[0] & 0x3ffff) * 0x100000000 + values[1];
}

function randomizePromptSeeds(prompt) {
  let changed = 0;
  for (const node of Object.values(prompt || {})) {
    for (const [name, value] of Object.entries(node?.inputs || {})) {
      if (!/(^|_)seed$/i.test(name) || (typeof value !== "number" && !/^\d+$/.test(String(value)))) continue;
      node.inputs[name] = nextRandomSeed();
      changed++;
    }
  }
  return changed;
}

async function redoTaskAtFront(item, status, control) {
  const promptId = String(item?.[1] || "");
  const prompt = clone(item?.[2] || {});
  const extraData = clone(item?.[3] || {});
  if (!promptId || !Object.keys(prompt).length) return toast(t("Cannot redo"), t("The original prompt data is missing."), "error");
  const changedSeeds = randomizePromptSeeds(prompt);
  const message = status === "running"
    ? format("Interrupt the current task, keep other parameters, randomize {0} seeds and restart ahead of queued tasks?", [changedSeeds])
    : format("Replace the queued task, keep other parameters, randomize {0} seeds and queue the redo first?", [changedSeeds]);
  if (!confirm(message)) return;
  control.disabled = true;
  const oldLabel = control.textContent;
  control.textContent = t("Moving to queue front…");
  let submittedPromptId = "";
  try {
    delete extraData.create_time;
    extraData.prompt_workbench_redo_of = promptId;
    const payload = { prompt, extra_data: extraData, front: true };
    if (api.clientId) payload.client_id = api.clientId;
    const response = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let result = {};
    try { result = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok || result.error) {
      const detail = result.error?.message || result.error?.details || text || `HTTP ${response.status}`;
      throw new Error(detail);
    }
    submittedPromptId = String(result.prompt_id || "");
    await cancelTaskForRedo(promptId, status);
    const seedDetail = changedSeeds ? format("Changed {0} seeds", [changedSeeds]) : t("No editable seed inputs found");
    toast(t("Redo queued first"), format("New task {0} queued first; {1}.", [submittedPromptId.slice(0, 12), seedDetail]), "success");
    await renderQueue();
  } catch (error) {
    if (submittedPromptId) {
      try {
        await api.fetchApi(`/api/jobs/${encodeURIComponent(submittedPromptId)}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {}
    }
    toast(t("Could not queue redo"), error.message, "error");
    control.disabled = false;
    control.textContent = oldLabel;
  }
}

function historyTaskFromResponse(history, promptId) {
  const entry = history?.[promptId] || Object.values(history || {})[0];
  const task = entry?.prompt;
  return Array.isArray(task) ? task : undefined;
}

function assetReferenceFromCard(card) {
  const preview = card.querySelector?.('img[src*="/view?"]');
  if (!preview?.src) return undefined;
  try {
    const url = new URL(preview.src, location.href);
    const filename = url.searchParams.get("filename") || preview.alt || "";
    if (!filename) return undefined;
    return {
      filename,
      subfolder: url.searchParams.get("subfolder") || "",
      type: url.searchParams.get("type") || "output",
    };
  } catch {
    return undefined;
  }
}

function sameAssetOutput(value, reference) {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && value.filename) {
    const normalizePath = (path) => String(path || "").replaceAll("/", "\\").replace(/^\\+|\\+$/g, "");
    return String(value.filename) === reference.filename
      && normalizePath(value.subfolder) === normalizePath(reference.subfolder)
      && String(value.type || "output") === reference.type;
  }
  return Object.values(value).some((child) => sameAssetOutput(child, reference));
}

function historyTaskForAsset(history, reference) {
  const matches = Object.entries(history || {}).filter(([, entry]) => sameAssetOutput(entry?.outputs, reference));
  const [promptId, entry] = matches.at(-1) || [];
  return { promptId, task: Array.isArray(entry?.prompt) ? entry.prompt : undefined };
}

async function redoAssetAtFront(reference, control) {
  const oldLabel = control.textContent;
  control.disabled = true;
  control.textContent = t("Loading…");
  try {
    let sourcePromptId = "";
    let task;
    const assetId = reference?.assetId;
    if (assetId) {
      const assetResponse = await api.fetchApi(`/assets/${encodeURIComponent(assetId)}`);
      if (assetResponse.ok) {
        const asset = await assetResponse.json();
        sourcePromptId = String(asset.job_id || asset.prompt_id || "");
      }
    }

    const historyResponse = await api.fetchApi(sourcePromptId
      ? `/history/${encodeURIComponent(sourcePromptId)}`
      : "/history?max_items=2000");
    if (!historyResponse.ok) throw new Error((await historyResponse.text()) || format("Could not read task history (HTTP {0})", [historyResponse.status]));
    const history = await historyResponse.json();
    if (sourcePromptId) {
      task = historyTaskFromResponse(history, sourcePromptId);
    } else {
      const matched = historyTaskForAsset(history, reference);
      sourcePromptId = String(matched.promptId || "");
      task = matched.task;
    }
    if (!sourcePromptId) throw new Error(t("The history entry for this asset was not found. It may have been cleared."));
    const prompt = clone(task?.[2] || {});
    const extraData = clone(task?.[3] || {});
    if (!Object.keys(prompt).length) throw new Error(t("The original prompt is missing from history."));

    const changedSeeds = randomizePromptSeeds(prompt);
    delete extraData.create_time;
    extraData.prompt_workbench_redo_of = sourcePromptId;
    extraData.prompt_workbench_redo_asset = assetId || `${reference.type}/${reference.subfolder}/${reference.filename}`;
    const payload = { prompt, extra_data: extraData, front: true };
    if (api.clientId) payload.client_id = api.clientId;
    control.textContent = t("Queuing first…");
    const submitResponse = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await submitResponse.text();
    let result = {};
    try { result = text ? JSON.parse(text) : {}; } catch {}
    if (!submitResponse.ok || result.error) {
      throw new Error(result.error?.message || result.error?.details || text || format("Submission failed (HTTP {0})", [submitResponse.status]));
    }
    const seedDetail = changedSeeds ? format("Randomized {0} seeds", [changedSeeds]) : t("No numeric seed inputs found");
    toast(t("Asset redo queued first"), format("New task {0} queued first; {1}.", [String(result.prompt_id || "").slice(0, 12), seedDetail]), "success");
    control.textContent = t("Submitted");
    setTimeout(() => {
      if (control.isConnected) {
        control.disabled = false;
        control.textContent = oldLabel;
      }
    }, 1800);
  } catch (error) {
    toast(t("Asset redo failed"), error.message, "error");
    control.disabled = false;
    control.textContent = oldLabel;
  }
}

function decorateAssetRedoCards(root = document) {
  const previewSelector = 'img[src*="/view?"]';
  if (root instanceof Element && !root.matches(previewSelector) && !root.querySelector(previewSelector)) return;
  const cards = [];
  const selector = "[data-asset-id], [role='button'][draggable='true']";
  if (root instanceof Element) {
    const ownCard = root.matches(selector) ? root : root.closest(selector);
    if (ownCard) cards.push(ownCard);
  }
  cards.push(...root.querySelectorAll?.(selector) || []);
  for (const card of new Set(cards)) {
    const reference = assetReferenceFromCard(card);
    if (!reference) continue;
    let instance = card.__vueParentComponent;
    while (instance && !instance.props?.asset?.id) instance = instance.parent;
    const assetId = card.dataset.assetId || instance?.props?.asset?.id;
    if (assetId) reference.assetId = String(assetId);
    const signature = [reference.type, reference.subfolder, reference.filename, reference.assetId || ""].join("\n");
    if (card.dataset.pwbAssetRedo === signature) continue;
    card.querySelector(":scope > .pwb-asset-redo")?.remove();
    card.dataset.pwbAssetRedo = signature;
    card.classList.add("pwb-asset-redo-host");
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const redo = el("button", "pwb-asset-redo", t("↻ Redo"));
    redo.type = "button";
    redo.title = t("Restore this asset's workflow, randomize seeds and queue it first");
    for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu"]) {
      redo.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
    redo.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      redoAssetAtFront(reference, redo);
    });
    card.append(redo);
  }
}

function startAssetRedoObserver() {
  if (assetRedoObserver) return;
  assetRedoObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added instanceof Element) decorateAssetRedoCards(added);
      }
    }
  });
  assetRedoObserver.observe(document.body, { childList: true, subtree: true });
  decorateAssetRedoCards();
}

function renderTask(item, status, index) {
  const card = el("article", "pwb-task");
  const head = el("div", "pwb-task-head");
  const title = el("div", "pwb-task-title", status === "running" ? t("Running") : format("Queued #{0}", [index + 1]));
  title.prepend(el("span", `pwb-badge ${status}`, status === "running" ? "RUNNING" : "PENDING"));
  head.append(title, el("time", "pwb-time", taskTime(item)));
  card.append(head);
  const templateTask = templateTaskSummary(item);
  if (templateTask) {
    const summary = el("div", "pwb-task-template-summary");
    summary.append(
      el("div", "pwb-task-template-row", t("Template workflow")),
      el("strong", "pwb-task-template-name", templateTask.template),
      el("span", "pwb-task-template-character", format("LoRA character: {0}", [templateTask.character]))
    );
    card.append(summary);
  } else {
    const texts = extractPromptText(item);
    for (const entry of texts) {
      const block = el("div", "pwb-prompt-block");
      block.append(el("div", "pwb-prompt-label", `${entry.node} · ${entry.input}`));
      const content = el("div", "pwb-prompt-text", entry.text);
      content.title = t("Click to copy");
      content.addEventListener("click", async () => {
        await navigator.clipboard.writeText(entry.text);
        toast(t("Copied"), entry.node);
      });
      block.append(content);
      card.append(block);
    }
    if (!texts.length) card.append(el("div", "pwb-empty-inline", t("No text prompts found; this task may only change parameters.")));
  }
  const foot = el("div", "pwb-task-foot");
  foot.append(el("code", "pwb-task-id", String(item?.[1] || "").slice(0, 12)));
  const redo = button(t("Redo next"), () => redoTaskAtFront(item, status, redo), "primary subtle");
  foot.append(redo);
  if (status === "pending") foot.append(button(t("Cancel task"), () => cancelPending(item[1]), "danger subtle"));
  card.append(foot);
  return card;
}

function scheduleQueueRender() {
  if (queueRenderTimer) return;
  queueRenderTimer = setTimeout(() => {
    queueRenderTimer = undefined;
    renderQueue();
  }, 500);
}

async function renderQueue() {
  if (!queueRoot?.isConnected || document.hidden) return;
  if (queueRenderPromise) return queueRenderPromise;
  queueRenderPromise = renderQueueOnce().finally(() => { queueRenderPromise = undefined; });
  return queueRenderPromise;
}

async function renderQueueOnce() {
  const targetRoot = queueRoot;
  try {
    const response = await api.fetchApi("/queue", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (targetRoot !== queueRoot || !targetRoot?.isConnected) return;
    const running = data.queue_running || [];
    const pending = [...(data.queue_pending || [])].sort((a, b) => Number(a?.[0] || 0) - Number(b?.[0] || 0));
    queueRoot.innerHTML = "";
    const summary = el("div", "pwb-queue-summary");
    summary.append(el("span", "", format("Running {0}", [running.length])), el("span", "", format("Pending {0}", [pending.length])), button(t("Refresh"), renderQueue, "subtle"));
    queueRoot.append(summary);
    running.forEach((item, index) => queueRoot.append(renderTask(item, "running", index)));
    pending.slice(0, queueVisibleLimit).forEach((item, index) => queueRoot.append(renderTask(item, "pending", index)));
    if (pending.length > queueVisibleLimit) {
      const more = el("div", "pwb-queue-more");
      more.append(
        el("span", "pwb-muted", format("Showing {0} of {1} pending tasks", [queueVisibleLimit, pending.length])),
        button(format("Show {0} more", [Math.min(QUEUE_PAGE_SIZE, pending.length - queueVisibleLimit)]), () => {
          queueVisibleLimit += QUEUE_PAGE_SIZE;
          renderQueue();
        }, "primary subtle")
      );
      queueRoot.append(more);
    }
    if (!running.length && !pending.length) queueRoot.append(el("div", "pwb-empty", t("The queue is empty. Submitted tasks and their prompts appear here.")));
  } catch (error) {
    if (targetRoot !== queueRoot || !targetRoot?.isConnected) return;
    queueRoot.innerHTML = "";
    queueRoot.append(el("div", "pwb-empty", format("Could not read queue: {0}", [error.message])));
  }
}

function assembledText() {
  return state.selections.map((item) => item.text.trim()).filter(Boolean).join(state.separator);
}

function addSelection(type, label, text, extra = {}) {
  const value = normalizeText(text);
  if (!value) return toast(t("Empty content"), t("There are no prompts to add."), "warn");
  state.selections.push({ id: uid(), type, label, text: value, ...extra });
  saveState();
  renderSelections();
}

function renderSelections() {
  if (!selectionsRoot) return;
  selectionsRoot.innerHTML = "";
  for (const [index, item] of state.selections.entries()) {
    const card = el("article", `pwb-selection ${item.type}`);
    card.draggable = true;
    card.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", String(index)));
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      if (!Number.isInteger(from) || from === index) return;
      const [moved] = state.selections.splice(from, 1);
      state.selections.splice(index, 0, moved);
      saveState();
      renderSelections();
    });
    const head = el("div", "pwb-selection-head");
    head.append(el("strong", "", item.type === "lora" ? `LoRA：${item.label}` : item.label || t("Complete prompt")));
    const actions = el("div", "pwb-actions compact");
    actions.append(
      button(t("Edit"), () => {
        const next = prompt(t("Edit complete content"), item.text);
        if (next?.trim()) {
          item.text = next.trim();
          saveState();
          renderSelections();
        }
      }, "subtle"),
      button("×", () => {
        state.selections.splice(index, 1);
        saveState();
        renderSelections();
      }, "icon danger"),
    );
    head.append(actions);
    const body = el("div", "pwb-selection-text", item.text);
    body.title = t("Double-click to edit");
    body.addEventListener("dblclick", () => actions.firstChild.click());
    card.append(head, body);
    selectionsRoot.append(card);
  }
  if (!state.selections.length) selectionsRoot.append(el("div", "pwb-empty-inline", t("Selected LoRA trigger groups and complete prompts appear here.")));
  outputArea.value = assembledText();
}

function selectedTextWidget() {
  for (const node of Object.values(app.canvas?.selected_nodes || {})) {
    const widgets = node.widgets || [];
    const preferred = widgets.find((widget) => typeof widget.value === "string" && TEXT_INPUT.test(widget.name || ""));
    const fallback = widgets.find((widget) => typeof widget.value === "string" && (widget.type === "text" || widget.inputEl?.tagName === "TEXTAREA"));
    if (preferred || fallback) return { node, widget: preferred || fallback };
  }
}

function writeToSelectedNode() {
  const target = selectedTextWidget();
  if (!target) return toast(t("No writable node"), t("Select a node with a text or prompt input first."), "warn");
  const text = assembledText();
  if (!text) return toast(t("No selected content"), t("Select LoRA triggers or add a complete prompt first."), "warn");
  target.widget.value = text;
  target.widget.callback?.(text, app.canvas, target.node, target.widget);
  target.node.graph?.change?.();
  app.canvas?.setDirty?.(true, true);
  toast(t("Prompt written"), target.node.title || target.node.type, "success");
}

function activeTemplate() {
  return state.templates.find((template) => template.id === activeTemplateId) || state.templates[0];
}

function activeTemplateField() {
  return activeTemplate()?.fields.find((field) => field.id === activeFieldId);
}

function templateText(template) {
  return template.fields.map((field) => field.value.trim()).filter(Boolean).join(state.separator);
}


function selectTemplateField(fieldId) {
  const field = activeTemplate()?.fields.find((item) => item.id === fieldId);
  if (!field || field.fixed) return false;
  activeFieldId = fieldId;
  activeTemplate().fillFieldId = fieldId;
  saveState();
  for (const row of templateRoot?.querySelectorAll(".pwb-template-field") || []) {
    row.classList.toggle("active", row.dataset.fieldId === fieldId);
  }
  for (const fillButton of templateRoot?.querySelectorAll("[data-fill-field]") || []) {
    fillButton.textContent = fillButton.dataset.fillField === fieldId ? t("Current fill target") : t("Use as fill target");
  }
  return true;
}

function moveTemplateField(fromIndex, toIndex) {
  const fields = activeTemplate().fields;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= fields.length || toIndex >= fields.length || fromIndex === toIndex) return;
  const [moved] = fields.splice(fromIndex, 1);
  fields.splice(toIndex, 0, moved);
  saveState();
  renderTemplates();
}

function importTemplatesFromJson() {
  const raw = prompt(t("Paste template JSON exported from another browser"), "");
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw);
    const incoming = Array.isArray(parsed) ? parsed : parsed?.templates;
    if (!Array.isArray(incoming) || !incoming.length) throw new Error(t("No template array found"));
    const normalized = incoming.map((template, index) => {
      if (!template || typeof template !== "object") throw new Error(format("Template {0} has an invalid format", [index + 1]));
      const name = String(template.name || "").trim();
      const fields = Array.isArray(template.fields) ? template.fields.filter((field) => field && typeof field === "object") : [];
      if (!name || !fields.length) throw new Error(format("Template {0} is missing a name or fields", [index + 1]));
      return {
        ...clone(template),
        id: String(template.id || uid()),
        name,
        fields: fields.map((field) => ({ ...clone(field), id: String(field.id || uid()) })),
      };
    });
    const merged = [...state.templates];
    for (const template of normalized) {
      const existingIndex = merged.findIndex((candidate) => candidate.id === template.id || candidate.name === template.name);
      if (existingIndex >= 0) merged[existingIndex] = template; else merged.push(template);
    }
    state.templates = merged;
    activeTemplateId = normalized[0].id;
    activeFieldId = templateFillField(normalized[0])?.id || normalized[0].fields[0]?.id;
    clearTimeout(saveStateTimer);
    saveStateTimer = undefined;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderTemplates();
    renderBatchPanel();
    toast(t("Templates imported"), format("Imported {0}; {1} templates total", [normalized.length, state.templates.length]), "success");
  } catch (error) {
    toast(t("Template import failed"), error.message || String(error), "error");
  }
}

async function exportTemplatesToClipboard() {
  const text = JSON.stringify({ format: "prompt-workbench-templates-v1", templates: state.templates }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast(t("Templates copied"), format("Copied {0} templates to clipboard", [state.templates.length]), "success");
  } catch {
    prompt(t("Copy the template JSON below"), text);
  }
}

function renderTemplates() {
  if (!templateRoot) return;
  templateRoot.innerHTML = "";
  const toolbar = el("div", "pwb-template-toolbar");
  const select = el("select", "pwb-input");
  for (const template of state.templates) {
    const option = el("option", "", template.name);
    option.value = template.id;
    option.selected = template.id === activeTemplateId;
    select.append(option);
  }
  select.addEventListener("change", () => {
    activeTemplateId = select.value;
    activeFieldId = templateFillField(activeTemplate())?.id || activeTemplate()?.fields[0]?.id;
    renderTemplates();
  });
  toolbar.append(
    select,
    button(t("New"), () => {
      const name = prompt(t("New template name"), t("My template"));
      if (!name?.trim()) return;
      const template = { id: uid(), name: name.trim(), fields: [{ id: uid(), name: t("Variable content"), value: "", fixed: false }] };
      state.templates.push(template);
      activeTemplateId = template.id;
      activeFieldId = template.fields[0].id;
      saveState();
      renderTemplates();
    }, "subtle"),
    button(t("Rename"), () => {
      const template = activeTemplate();
      const name = prompt(t("Template name"), template.name);
      if (name?.trim()) {
        template.name = name.trim();
        saveState();
        renderTemplates();
      }
    }, "subtle"),
    button(t("Import templates"), importTemplatesFromJson, "subtle"),
    button(t("Copy export"), exportTemplatesToClipboard, "subtle"),
    button(t("Delete"), () => {
      if (state.templates.length <= 1) return toast(t("Cannot delete"), t("Keep at least one template."), "warn");
      if (!confirm(format("Delete template '{0}'?", [activeTemplate().name]))) return;
      state.templates = state.templates.filter((template) => template.id !== activeTemplateId);
      state.batchTemplateIds = state.batchTemplateIds.filter((id) => id !== activeTemplateId);
      activeTemplateId = state.templates[0].id;
      activeFieldId = state.templates[0].fields[0]?.id;
      saveState();
      renderTemplates();
      renderBatchPanel();
    }, "subtle danger"),
  );
  templateRoot.append(toolbar);

  const hint = el("div", "pwb-hint", t("Select a variable field, then fill it from the LoRA library. Clearing variables preserves fixed fields. All fields can be edited."));
  templateRoot.append(hint);
  const fixedLoras = el("div", "pwb-template-fixed-loras");
  fixedLoras.append(el("div", "pwb-label", t("Fixed LoRAs for this template (ordered to match loader nodes)")));
  const fixedLoraChips = el("div", "pwb-batch-selected");
  for (const file of activeTemplate().fixedLoraFiles || []) {
    fixedLoraChips.append(button(`${translatedLoraName(file, displayAliases())} ×`, () => {
      activeTemplate().fixedLoraFiles = (activeTemplate().fixedLoraFiles || []).filter((value) => normalizeLoraKey(value) !== normalizeLoraKey(file));
      saveState();
      renderTemplates();
      renderLoraLibrary();
    }, "library-chip lora"));
  }
  if (!(activeTemplate().fixedLoraFiles || []).length) fixedLoraChips.append(el("span", "pwb-muted", t("None yet. Add fixed LoRAs to this template from the library.")));
  fixedLoras.append(fixedLoraChips);
  templateRoot.append(fixedLoras);
  const fields = el("div", "pwb-template-fields advanced");
  for (const [fieldIndex, field] of activeTemplate().fields.entries()) {
    const row = el("div", `pwb-template-field ${field.id === activeFieldId ? "active" : ""}`);
    row.dataset.fieldId = field.id;
    row.addEventListener("click", (event) => {
      if (event.target.closest("button,input,textarea,label")) return;
      if (!selectTemplateField(field.id)) toast(t("This field is fixed"), t("Unfix the field before using it as a LoRA fill target."), "warn");
    });
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer.getData("application/x-pwb-template-field");
      const fromIndex = activeTemplate().fields.findIndex((item) => item.id === fromId);
      moveTemplateField(fromIndex, fieldIndex);
    });
    const head = el("div", "pwb-template-field-head");
    const grip = el("span", "pwb-field-grip", "⠿");
    grip.title = t("Drag to reorder fields");
    grip.draggable = true;
    grip.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-pwb-template-field", field.id);
      event.dataTransfer.effectAllowed = "move";
    });
    const name = el("input", "pwb-input");
    name.value = field.name;
    name.placeholder = t("Field name");
    name.addEventListener("input", () => { field.name = name.value; saveState(); });
    const fixedLabel = el("label", "pwb-fixed-label");
    const fixed = el("input", "");
    fixed.type = "checkbox";
    fixed.checked = !!field.fixed;
    fixed.addEventListener("change", () => {
      field.fixed = fixed.checked;
      saveState();
    });
    fixedLabel.append(fixed, document.createTextNode(t("Fixed")));
    head.append(grip, name, fixedLabel);
    const controls = el("div", "pwb-template-field-controls");
    const fillButton = button(field.id === activeFieldId ? t("Current fill target") : t("Use as fill target"), () => {
      if (field.fixed) return toast(t("This field is fixed"), t("Unfix this field before allowing automatic LoRA replacement."), "warn");
      selectTemplateField(field.id);
    }, "subtle fill-field");
    fillButton.dataset.fillField = field.id;
    controls.append(
      button("↑", () => moveTemplateField(fieldIndex, fieldIndex - 1), "icon move-field"),
      button("↓", () => moveTemplateField(fieldIndex, fieldIndex + 1), "icon move-field"),
      fillButton,
      button("×", () => {
      activeTemplate().fields = activeTemplate().fields.filter((item) => item.id !== field.id);
      if (activeFieldId === field.id) activeFieldId = activeTemplate().fields.find((item) => !item.fixed)?.id;
      if (activeTemplate().fillFieldId === field.id) activeTemplate().fillFieldId = activeFieldId;
      saveState();
      renderTemplates();
      }, "icon danger"),
    );
    const value = el("textarea", "pwb-input pwb-field-value");
    value.value = field.value;
    value.placeholder = t("Type here or fill from a LoRA");
    value.addEventListener("input", () => {
      field.value = value.value;
      field.loraFile = undefined;
      saveState();
    });
    row.append(head, controls, value);
    if (field.loraFile) row.append(el("div", "pwb-field-source", format("From LoRA: {0}", [bilingualLoraName(field.loraFile, displayAliases())])));
    fields.append(row);
  }
  templateRoot.append(fields);
  const actions = el("div", "pwb-actions wrap");
  actions.append(
    button(t("+ Add field"), () => {
      const field = { id: uid(), name: t("New field"), value: "", fixed: false };
      activeTemplate().fields.push(field);
      activeFieldId = field.id;
      saveState();
      renderTemplates();
    }, "subtle"),
    button(t("Clear variable fields"), () => {
      activeTemplate().fields.forEach((field) => { if (!field.fixed) { field.value = ""; field.loraFile = undefined; } });
      saveState();
      renderTemplates();
    }, "subtle"),
    button(t("Build prompt"), () => addSelection("prompt", format("Template: {0}", [activeTemplate().name]), templateText(activeTemplate())), "primary"),
  );
  templateRoot.append(actions);
}

function extractWorkflowLoras() {
  const found = new Set();
  for (const node of app.graph?._nodes || []) {
    for (const widget of node.widgets || []) {
      const name = String(widget.name || "").toLowerCase();
      const value = widget.value;
      if (typeof value === "string") {
        if (name.includes("lora") && looksLikeLora(value)) found.add(normalizeLoraKey(value));
        for (const match of value.matchAll(/<lora:([^:>]+)(?::[^>]+)?>/gi)) found.add(normalizeLoraKey(match[1]));
      }
      if (name.includes("lora") && Array.isArray(value)) {
        for (const entry of value) {
          const candidate = typeof entry === "string" ? entry : entry?.name || entry?.lora || entry?.lora_name;
          if (candidate) found.add(normalizeLoraKey(candidate));
        }
      }
    }
  }
  return found;
}

function relativeLoraPath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  const marker = "/models/loras/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : "";
}

function loraBaseModel(item) {
  const candidates = [item?.baseModel, item?.base_model, item?.civitai?.baseModel, item?.civitai?.base_model];
  return candidates
    .map((value) => String(value || "").trim())
    .find((value) => value && !/^(unknown|none|null|n\/a)$/i.test(value)) || t("Unknown model");
}

async function loadLoras() {
  if (loraLoaded) return;
  if (loraLoadPromise) return loraLoadPromise;
  loraLoadPromise = loadLorasOnce().finally(() => { loraLoadPromise = undefined; });
  return loraLoadPromise;
}

async function loadLorasOnce() {
  const byKey = new Map();
  try {
    const response = await api.fetchApi("/lora-trigger-helper/loras", { cache: "no-store" });
    if (response.ok) {
      const items = ((await response.json()).items || []).filter((item) => !item.missing);
      for (const item of items) {
        const file = item.file || item.key;
        byKey.set(normalizeLoraKey(file), { ...item, file, triggers: [...(item.triggers || []), ...(item.recommendedPrompts || [])] });
      }
    }
  } catch {}
  if (!byKey.size) {
    for (const key of extractWorkflowLoras()) {
      if (!byKey.has(key)) byKey.set(key, { file: key, name: key, triggers: [] });
    }
  }
  metadataAliases = {};
  for (const item of byKey.values()) {
    if (item.displayName) {
      metadataAliases[normalizeLoraKey(item.file)] = String(item.displayName).trim();
      continue;
    }
    const translatedFile = currentLocale() === 'zh-CN' ? automaticChineseName(item.file) : item.file;
    if (!/[\u3400-\u9fff]/.test(translatedFile) && item.name && normalizeLoraKey(item.name) !== normalizeLoraKey(item.file)) {
      metadataAliases[normalizeLoraKey(item.file)] = currentLocale() === 'zh-CN' ? automaticChineseName(item.name) : item.name;
    }
  }
  for (const item of byKey.values()) if (looksLikeLora(item.file)) knownLoraFiles.add(item.file);
  loraItems = [...byKey.values()].sort((a, b) => translatedLoraName(a.file, displayAliases()).localeCompare(translatedLoraName(b.file, displayAliases()), currentLocale()));
  loraLoaded = byKey.size > 0;
  renderBatchPanel();
}


function wordsForLora(item) {
  const override = state.loraTriggers[normalizeLoraKey(item.file)];
  const words = Array.isArray(override) ? override : item.triggers || [];
  return [...new Set(words.map((word) => normalizeText(word)).filter(Boolean))];
}

function wordsInGroup(group) {
  return [...new Set((group?.words || []).flatMap((value) => String(value).replaceAll("|", ",").split(",")).map((word) => normalizeText(word)).filter(Boolean))];
}

const GROUP_CATEGORIES = [
  { name: t("Character appearance"), test: /\b(1girl|1boy|woman|man|female|male|hair|eyes?|breasts?|skin|face|girl|boy)\b/i, note: t("Identity, hair, eyes and physical traits") },
  { name: t("Outfit"), test: /\b(dress|shirt|uniform|jacket|coat|skirt|bikini|swimsuit|kimono|apron|clothes|outfit|sleeves?|necktie|bowtie|leotard)\b/i, note: t("Clothes, accessories and outfit details") },
  { name: t("Action"), test: /\b(pose|sex|fuck|blowjob|titfuck|doggy|missionary|cowgirl|dance|grabbing|motion|movement|swaying|bouncing)\b/i, note: t("Actions, poses and movement") },
  { name: t("Video motion"), test: /\b(video|animation|animate|temporal|camera|i2v|t2v|frames?|relight|lighting)\b/i, note: t("Temporal consistency, movement and camera") },
  { name: t("Art style"), test: /\b(style|lineart|anime|comic|illustration|pixel|realistic|photorealistic|shading)\b/i, note: t("Art style, linework and rendering") },
  { name: t("Quality enhancement"), test: /\b(quality|detailed|details?|masterpiece|aesthetic|sharp|focus|texture|refined|clean)\b/i, note: t("Detail, sharpness and overall quality") },
];

const TRIGGER_LABELS = {
  "nakiri erina": t("Erina Nakiri"),
  "yukihira souma": t("Soma Yukihira"),
  "arato hisako": t("Hisako Arato"),
  tootsukischool: t("Totsuki school uniform"),
  tootsukisummer: t("Totsuki summer uniform"),
  "main thighhighs": t("Main outfit (thigh-highs)"),
  "cooking-uniform": t("Chef uniform"),
  d0ubl3_bj: t("Double oral mode"),
  d0gg1e: t("Rear-entry mode"),
  m15510n4ry: t("Missionary mode"),
  c0wg1rl: t("Cowgirl mode"),
  bl0wj0b: t("Oral mode"),
  sbevedef: t("EVE default outfit"),
  sbevealt: t("EVE alternate outfit"),
};

const TRIGGER_NOTES = {
  d0ubl3_bj: t("Double oral action mode"),
  d0gg1e: t("Rear-entry action mode"),
  m15510n4ry: t("Missionary action mode"),
  c0wg1rl: t("Cowgirl action mode"),
  bl0wj0b: t("Oral action mode"),
  sbevedef: t("EVE default outfit and appearance"),
  sbevealt: t("EVE alternate outfit and appearance"),
};

function groupCategories(words) {
  const text = words.join(" ");
  return GROUP_CATEGORIES.filter((category) => category.test.test(text))
    .map(category => ({ ...category, name: t(category.name), note: t(category.note) }));
}

const VISUAL_TRAITS = [
  ["parted bangs", t("parted bangs")], ["blunt bangs", t("blunt bangs")], ["hair between eyes", t("hair between eyes")],
  ["twin braids", t("twin braids")], ["side ponytail", t("side ponytail")], ["ponytail", t("ponytail")], ["braid", t("braid")],
  ["long hair", t("long hair")], ["short hair", t("short hair")], ["medium hair", t("medium hair")],
  ["black hair", t("black hair")], ["brown hair", t("brown hair")], ["blonde hair", t("blonde hair")], ["white hair", t("white hair")],
  ["red hair", t("red hair")], ["blue hair", t("blue hair")], ["green hair", t("green hair")], ["pink hair", t("pink hair")],
  ["purple hair", t("purple hair")], ["orange hair", t("orange hair")], ["grey hair", t("grey hair")], ["aqua hair", t("aqua hair")],
  ["black eyes", t("black eyes")], ["brown eyes", t("brown eyes")], ["blue eyes", t("blue eyes")], ["green eyes", t("green eyes")],
  ["red eyes", t("red eyes")], ["pink eyes", t("pink eyes")], ["purple eyes", t("purple eyes")], ["yellow eyes", t("yellow eyes")],
  ["dark-skinned female", t("dark-skinned female")], ["dark-skinned male", t("dark-skinned female")], ["large breasts", t("large breasts")],
  ["cropped shirt", t("cropped shirt")], ["ribbed shirt", t("ribbed shirt")], ["white shirt", t("white shirt")],
  ["cleavage cutout", t("cleavage cutout")], ["puffy long sleeves", t("puffy long sleeves")], ["puffy sleeves", t("puffy sleeves")],
  ["white skirt", t("white skirt")], ["long skirt", t("long skirt")], ["pleated skirt", t("pleated skirt")], ["plaid skirt", t("plaid skirt")],
  ["school uniform", t("school uniform")], ["military uniform", t("military uniform")], ["cooking-uniform", t("Chef uniform")], ["lab coat", t("lab coat")],
  ["black dress", t("black dress")], ["white dress", t("white dress")], ["purple dress", t("purple dress")],
  ["swimsuit", t("swimsuit")], ["bikini", t("bikini")], ["kimono", t("kimono")], ["breastplate", t("breastplate")],
  ["detached sleeves", t("detached sleeves")], ["boots", t("boots")], ["thighhighs", t("thighhighs")], ["navel", t("navel")],
  ["hairpin", t("hairpin")], ["hairclip", t("hairclip")], ["necklace", t("necklace")], ["choker", t("choker")], ["jewelry", t("jewelry")],
];

function visualDescription(words) {
  const text = ` ${words.join(" ").toLowerCase()} `;
  const found = [];
  for (const [term, label] of VISUAL_TRAITS) {
    if (text.includes(` ${term} `) && !found.includes(t(label))) found.push(t(label));
  }
  return found.length ? format("Visual traits: {0}", [found.slice(0, 12).join("\u3001")]) : "";
}

function isAppearanceBaseLine(words) {
  const text = words.join(" ");
  const hasAppearance = GROUP_CATEGORIES[0].test.test(text);
  const hasOtherMode = GROUP_CATEGORIES.slice(1).some((category) => category.test.test(text));
  return hasAppearance && !hasOtherMode;
}

function hasNonBaseMode(words) {
  const text = words.join(" ");
  return GROUP_CATEGORIES.slice(1).some((category) => category.test.test(text));
}

function isOutfitLine(words) {
  return GROUP_CATEGORIES[1].test.test(words.join(" "));
}

function groupNote(words, standalone = false) {
  const mapped = TRIGGER_NOTES[String(words[0] || "").toLowerCase()];
  if (mapped) return format("Standalone trigger mode; {0}; {1} triggers", [t(mapped), words.length]);
  const visual = visualDescription(words);
  if (visual) return format("{0}; {1} triggers", [visual, words.length]);
  const categories = groupCategories(words);
  const purpose = categories.length ? categories.slice(0, 3).map((category) => category.note).join("\uff1b") : (standalone ? t("Switch between characters, outfits or action modes") : t("Enable the main features of this LoRA"));
  return format("{0}{1}; {2} triggers", [standalone ? t("Standalone trigger mode; ") : "", purpose, words.length]);
}

function triggerGroupName(words, index, standalone = false) {
  const first = String(words[0] || "").trim();
  const mapped = TRIGGER_LABELS[first.toLowerCase()];
  if (mapped) return t(mapped);
  if (standalone && first) return first.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (first && !/^(1girl|1boy|girl|boy|woman|man)$/i.test(first) && first.length <= 36) return first;
  const categories = groupCategories(words);
  return format("{0} group {1}", [categories[0]?.name || t("Default triggers"), index > 0 ? ` ${index + 1}` : ""]);
}

function shouldSplitStandaloneTriggers(triggers) {
  return triggers.length > 1 && triggers.every((trigger) => Boolean(TRIGGER_LABELS[String(trigger).trim().toLowerCase()]));
}

function groupsForLora(item) {
  if (Array.isArray(item.groups) && item.groups.length) {
    return item.groups.map((group, index) => {
      const words = wordsInGroup(group);
      return {
        id: String(group.id || `group-${index + 1}`),
        name: String(group.name || triggerGroupName(words, index)),
        note: String(group.note || groupNote(words)),
        archiveCharacter: String(group.archiveCharacter || item.archiveCharacter || ""),
        sourceLabel: String(group.sourceLabel || item.sourceLabel || ""),
        words,
      };
    }).filter((group) => group.words.length);
  }
  const triggers = wordsForLora(item);
  if (!triggers.length) return [{
    id: "missing",
    name: t("Triggers needed"),
    note: t("No triggers found in local metadata; use Edit to create groups"),
    words: [],
  }];
  const structuredLines = triggers.filter((trigger) => trigger.includes(",") || trigger.includes("|"));
  if (structuredLines.length >= 2 && structuredLines.length >= Math.ceil(triggers.length / 2)) {
    const parsedLines = triggers.map((trigger) => wordsInGroup({ words: [trigger] }));
    if (isAppearanceBaseLine(parsedLines[0]) && parsedLines.length > 1) {
      let firstModeIndex = 1;
      while (firstModeIndex < parsedLines.length && !hasNonBaseMode(parsedLines[firstModeIndex])) firstModeIndex++;
      const baseWords = [...new Set(parsedLines.slice(0, firstModeIndex).flat())];
      if (firstModeIndex >= parsedLines.length) {
        return [{ id: "default", name: triggerGroupName(baseWords, 0), note: groupNote(baseWords), words: baseWords }];
      }
      return parsedLines.slice(firstModeIndex).map((modeWords, index) => {
        if (isOutfitLine(modeWords)) {
          const words = [...new Set([...baseWords, ...modeWords])];
          return { id: `outfit-${index + 1}`, name: format("{0} complete outfit", [triggerGroupName(modeWords, index)]), note: groupNote(words), words };
        }
        return { id: `addon-${index + 1}`, name: format("{0} additional group", [triggerGroupName(modeWords, index)]), note: groupNote(modeWords), words: modeWords };
      });
    }
    return parsedLines.map((words, index) => ({ id: `auto-${index + 1}`, name: triggerGroupName(words, index), note: groupNote(words), words }));
  }
  if (shouldSplitStandaloneTriggers(triggers)) {
    return triggers.map((trigger, index) => {
      const words = [trigger];
      return { id: `variant-${index + 1}`, name: triggerGroupName(words, index, true), note: groupNote(words, true), words };
    });
  }
  const combinedWords = wordsInGroup({ words: triggers });
  return [{ id: "default", name: triggerGroupName(combinedWords, 0), note: groupNote(combinedWords), words: combinedWords }];
}

function selectedGroupsForLora(item) {
  const key = normalizeLoraKey(item.file);
  const selected = new Set(Array.isArray(state.loraGroupSelections[key]) ? state.loraGroupSelections[key] : []);
  return groupsForLora(item).filter((group) => selected.has(group.id) && group.words.length);
}

function toggleLoraGroupSelection(item, group, anchorElement) {
  anchorElement?.blur?.();
  const key = normalizeLoraKey(item.file);
  const selected = new Set(Array.isArray(state.loraGroupSelections[key]) ? state.loraGroupSelections[key] : []);
  if (selected.has(group.id)) selected.delete(group.id); else selected.add(group.id);
  state.loraGroupSelections[key] = [...selected];
  saveState();
  const groupCard = anchorElement?.closest?.(".pwb-lora-group");
  const groupList = groupCard?.closest?.(".pwb-lora-groups");
  if (!groupCard || !groupList) return;
  const isSelected = selected.has(group.id);
  groupCard.classList.toggle("selected", isSelected);
  anchorElement.textContent = isSelected ? t("✓ Selected") : t("Select");
  anchorElement.classList.toggle("primary", isSelected);
  anchorElement.classList.toggle("subtle", !isSelected);

  groupList.querySelector(".pwb-lora-combined-actions")?.remove();
  const visibleGroupIds = new Set([...groupList.querySelectorAll(".pwb-lora-group")].map((node) => node.dataset.groupId));
  const selectedGroups = groupsForLora(item).filter((candidate) => selected.has(candidate.id) && visibleGroupIds.has(candidate.id));
  if (!selectedGroups.length) return;
  const combinedActions = el("div", "pwb-lora-combined-actions");
  combinedActions.append(
    el("strong", "", format("Selected {0} groups: {1}", [selectedGroups.length, selectedGroups.map((candidate) => candidate.name).join(" + ")])),
    button(t("Add combination above"), () => addCombinedGroupsAbove(item, selectedGroups), "primary"),
    button(t("Fill field with combination"), () => fillTemplateFromGroups(item, selectedGroups)),
    button(t("Add combination to batch"), (event) => addBatchLoraCombination(item, selectedGroups, event.currentTarget))
  );
  groupList.insertBefore(combinedActions, groupList.lastElementChild);
}

function combinedGroupWords(groups) {
  return [...new Set(groups.flatMap((group) => group.words))];
}

function fillTemplateFromGroups(item, groups) {
  const field = activeTemplateField();
  if (!field || field.fixed) return toast(t("No fill target"), t("Select a non-fixed field."), "warn");
  field.value = combinedGroupWords(groups).join(", ");
  field.loraFile = item.file;
  saveState();
  renderTemplates();
}

function addCombinedGroupsAbove(item, groups) {
  const label = `${translatedLoraName(item.file, displayAliases())} / ${groups.map((group) => group.name).join(" + ")}`;
  addSelection("lora", label, combinedGroupWords(groups).join(", "), { loraFile: item.file });
}

async function saveLoraGroups(item, groups, notes = item.notes || "") {
  const response = await api.fetchApi("/lora-trigger-helper/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: item.file, name: item.name, triggers: item.triggers || [], groups, notes, archiveCharacter: item.archiveCharacter || "", sourceLabel: item.sourceLabel || "" }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  item.groups = groups;
  item.notes = notes;
}

async function editLoraGroup(item, group) {
  const groups = groupsForLora(item);
  const index = groups.findIndex((candidate) => candidate.id === group.id);
  if (index < 0) return;
  const name = prompt(t("Group name"), group.name);
  if (name === null) return;
  const note = prompt(t("Purpose / appearance notes"), group.note || "");
  if (note === null) return;
  const words = prompt(t("Triggers (comma or newline separated)"), group.words.join(", "));
  if (words === null) return;
  groups[index] = { ...group, name: name.trim() || group.name, note: note.trim(), words: wordsInGroup({ words: [words.replaceAll("\n", ",")] }) };
  try {
    await saveLoraGroups(item, groups);
    renderLoraLibrary();
    toast(t("Trigger group saved"), groups[index].name, "success");
  } catch (error) {
    toast(t("Could not save group"), error.message || String(error), "error");
  }
}

async function addLoraGroup(item) {
  const name = prompt(t("New group name"), "");
  if (!name?.trim()) return;
  const note = prompt(t("Purpose / appearance notes"), "") ?? "";
  const words = prompt(t("Triggers (comma or newline separated)"), "");
  if (!words?.trim()) return;
  const groups = [...groupsForLora(item), { id: uid(), name: name.trim(), note: note.trim(), words: wordsInGroup({ words: [words.replaceAll("\n", ",")] }) }];
  try {
    await saveLoraGroups(item, groups);
    renderLoraLibrary();
  } catch (error) {
    toast(t("Could not save group"), error.message || String(error), "error");
  }
}

async function deleteLoraGroup(item, group) {
  if (!confirm(format("Delete trigger group '{0}'?", [group.name]))) return;
  const groups = groupsForLora(item).filter((candidate) => candidate.id !== group.id);
  try {
    await saveLoraGroups(item, groups);
    state.batchLoraEntries = state.batchLoraEntries.filter((entry) => !(
      normalizeLoraKey(entry.key) === normalizeLoraKey(item.file)
      && (entry.groupId === group.id || (entry.groupIds || []).includes(group.id))
    ));
    const key = normalizeLoraKey(item.file);
    state.loraGroupSelections[key] = (state.loraGroupSelections[key] || []).filter((id) => id !== group.id);
    saveState();
    renderLoraLibrary();
    renderBatchPanel();
  } catch (error) {
    toast(t("Could not delete group"), error.message || String(error), "error");
  }
}

function setScrollTopImmediately(container, value) {
  if (!container) return;
  const previousBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  container.scrollTop = value;
  container.style.scrollBehavior = previousBehavior;
}

async function refreshBatchSelectionWithoutJump(anchorElement) {
  const anchorGroup = anchorElement?.closest?.(".pwb-lora-group");
  const anchorKey = anchorGroup?.dataset.loraKey;
  const anchorGroupId = anchorGroup?.dataset.groupId;
  const outerScrollTop = promptRoot?.scrollTop || 0;
  const loraScrollTop = loraRoot?.scrollTop || 0;
  const outerRect = promptRoot?.getBoundingClientRect();
  const anchorOffset = anchorGroup && outerRect
    ? anchorGroup.getBoundingClientRect().top - outerRect.top
    : undefined;

  renderBatchPanel();
  await renderLoraLibrary();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  setScrollTopImmediately(loraRoot, loraScrollTop);

  const restoredAnchor = anchorKey && anchorGroupId
    ? [...(loraRoot?.querySelectorAll(".pwb-lora-group") || [])].find((node) => (
      node.dataset.loraKey === anchorKey && node.dataset.groupId === anchorGroupId
    ))
    : undefined;
  if (restoredAnchor && outerRect && anchorOffset !== undefined) {
    const restoredOffset = restoredAnchor.getBoundingClientRect().top - outerRect.top;
    setScrollTopImmediately(promptRoot, promptRoot.scrollTop + restoredOffset - anchorOffset);
  } else {
    setScrollTopImmediately(promptRoot, outerScrollTop);
  }
}

function refreshBatchPanelWithoutJump(anchorElement) {
  const anchorGroup = anchorElement?.closest?.(".pwb-lora-group");
  const outerRect = promptRoot?.getBoundingClientRect();
  const anchorOffset = anchorGroup && outerRect
    ? anchorGroup.getBoundingClientRect().top - outerRect.top
    : undefined;
  const outerScrollTop = promptRoot?.scrollTop || 0;
  const loraScrollTop = loraRoot?.scrollTop || 0;
  renderBatchPanel();
  setScrollTopImmediately(loraRoot, loraScrollTop);
  if (anchorGroup?.isConnected && outerRect && anchorOffset !== undefined) {
    const restoredOffset = anchorGroup.getBoundingClientRect().top - outerRect.top;
    setScrollTopImmediately(promptRoot, promptRoot.scrollTop + restoredOffset - anchorOffset);
  } else {
    setScrollTopImmediately(promptRoot, outerScrollTop);
  }
}

function syncBatchGroupInPlace(item, group, actionButton) {
  const groupCard = actionButton?.closest?.(".pwb-lora-group");
  if (!groupCard) return;
  const entries = batchEntriesForGroup(item, group);
  const isInBatch = entries.length > 0;
  groupCard.classList.toggle("batch-included", isInBatch);
  const groupText = groupCard.querySelector(".pwb-lora-group-text");
  let badge = groupText?.querySelector(".pwb-group-batch-state");
  if (isInBatch) {
    if (!badge) {
      badge = el("span", "pwb-group-batch-state");
      groupText?.querySelector(".pwb-lora-group-name")?.after(badge);
    }
    badge.textContent = format("In batch {0}", [entries.length > 1 ? ` ×${entries.length}` : ""]);
  } else {
    badge?.remove();
  }
  const key = normalizeLoraKey(item.file);
  const card = groupCard.closest(".pwb-lora-card");
  card?.classList.toggle("batch-selected", state.batchLoraEntries.some((entry) => normalizeLoraKey(entry.key) === key));
  const replacement = isInBatch
    ? button(t("Remove from batch"), (event) => removeBatchLoraGroup(item, group, event.currentTarget), "danger")
    : button(t("Add to batch"), (event) => addBatchLoraGroup(item, group, event.currentTarget));
  actionButton.replaceWith(replacement);
}

function addBatchLoraGroup(item, group, anchorElement) {
  state.batchLoraEntries.push({ id: uid(), key: normalizeLoraKey(item.file), groupId: group.id, groupIds: [group.id], label: group.name });
  saveState();
  refreshBatchPanelWithoutJump(anchorElement);
  syncBatchGroupInPlace(item, group, anchorElement);
  toast(t("Added to batch workflow"), `${translatedLoraName(item.file, displayAliases())} / ${group.name}`, "success");
}

function batchEntriesForGroup(item, group) {
  const key = normalizeLoraKey(item.file);
  return state.batchLoraEntries.filter((entry) => {
    if (normalizeLoraKey(entry.key) !== key) return false;
    const ids = entry.groupIds?.length ? entry.groupIds : [entry.groupId].filter(Boolean);
    return ids.includes(group.id);
  });
}

function removeBatchLoraGroup(item, group, anchorElement) {
  const selectedIds = new Set(batchEntriesForGroup(item, group).map((entry) => entry.id));
  state.batchLoraEntries = state.batchLoraEntries.filter((entry) => !selectedIds.has(entry.id));
  saveState();
  refreshBatchPanelWithoutJump(anchorElement);
  syncBatchGroupInPlace(item, group, anchorElement);
}

function addBatchLoraCombination(item, groups, anchorElement) {
  state.batchLoraEntries.push({
    id: uid(),
    key: normalizeLoraKey(item.file),
    groupIds: groups.map((group) => group.id),
    label: groups.map((group) => group.name).join(" + "),
  });
  saveState();
  refreshBatchSelectionWithoutJump(anchorElement);
}

function selectedWordsForLora(item) {
  const key = normalizeLoraKey(item.file);
  const words = wordsForLora(item);
  const saved = state.loraTriggerSelections[key];
  if (!Array.isArray(saved)) return words;
  const selected = new Set(saved);
  return words.filter((word) => selected.has(word));
}

function setSelectedLoraWords(item, words) {
  state.loraTriggerSelections[normalizeLoraKey(item.file)] = [...new Set(words)];
  saveState();
  renderLoraLibrary();
  renderBatchPanel();
}

function toggleLoraWord(item, word) {
  const selected = new Set(selectedWordsForLora(item));
  if (selected.has(word)) selected.delete(word); else selected.add(word);
  setSelectedLoraWords(item, [...selected]);
}

function deleteLoraWord(item, word) {
  const key = normalizeLoraKey(item.file);
  const remaining = wordsForLora(item).filter((value) => value !== word);
  state.loraTriggers[key] = remaining;
  if (Array.isArray(state.loraTriggerSelections[key])) {
    state.loraTriggerSelections[key] = state.loraTriggerSelections[key].filter((value) => value !== word);
  }
  saveState();
  renderLoraLibrary();
  renderBatchPanel();
}

function addLoraWords(item) {
  const added = prompt(t("Append triggers (one per line)"), "");
  if (!added?.trim()) return;
  const key = normalizeLoraKey(item.file);
  const additions = added.split("\n").map((word) => normalizeText(word)).filter(Boolean);
  state.loraTriggers[key] = [...new Set([...wordsForLora(item), ...additions])];
  if (Array.isArray(state.loraTriggerSelections[key])) {
    state.loraTriggerSelections[key] = [...new Set([...state.loraTriggerSelections[key], ...additions])];
  }
  saveState();
  renderLoraLibrary();
  renderBatchPanel();
}

function restoreLoraWords(item) {
  const key = normalizeLoraKey(item.file);
  delete state.loraTriggers[key];
  delete state.loraTriggerSelections[key];
  saveState();
  renderLoraLibrary();
  renderBatchPanel();
}

function editLora(item) {
  const key = normalizeLoraKey(item.file);
  const alias = prompt(t("Display alias (leave empty to restore the automatic name)"), state.loraAliases[key] || translatedLoraName(item.file, displayAliases()));
  if (alias === null) return;
  if (alias.trim()) state.loraAliases[key] = alias.trim(); else delete state.loraAliases[key];
  const triggers = prompt(t("Trigger groups (one per line; saved in this browser only)"), wordsForLora(item).join("\n"));
  if (triggers !== null) {
    state.loraTriggers[key] = triggers.split("\n").map((word) => word.trim()).filter(Boolean);
    if (Array.isArray(state.loraTriggerSelections[key])) {
      const available = new Set(state.loraTriggers[key]);
      state.loraTriggerSelections[key] = state.loraTriggerSelections[key].filter((word) => available.has(word));
    }
  }
  saveState();
  decorateAllLoraWidgets();
  renderLoraLibrary();
}

function fillTemplateFromLora(item) {
  const field = activeTemplateField();
  if (!field) return toast(t("No variable fill target"), t("Add or select a non-fixed template field."), "warn");
  if (field.fixed) return toast(t("The current field is fixed"), t("Select a non-fixed field."), "warn");
  const words = selectedWordsForLora(item);
  if (!words.length) return toast(t("No triggers"), t("Use Alias / triggers to add them manually."), "warn");
  field.value = words.join(", ");
  field.loraFile = item.file;
  saveState();
  renderTemplates();
  toast(t("Template filled"), `${activeTemplate().name} / ${field.name}`, "success");
}

function toggleTemplateFixedLora(item) {
  const template = activeTemplate();
  const key = normalizeLoraKey(item.file);
  const files = template.fixedLoraFiles || [];
  if (files.some((file) => normalizeLoraKey(file) === key)) {
    template.fixedLoraFiles = files.filter((file) => normalizeLoraKey(file) !== key);
  } else {
    template.fixedLoraFiles = [...files, item.file];
  }
  saveState();
  renderTemplates();
  renderLoraLibrary();
}

function renderLoraLibrary() {
  loraRenderDirty = true;
  if (loraRenderPromise) return loraRenderPromise;
  loraRenderPromise = new Promise((resolve) => requestAnimationFrame(resolve))
    .then(async () => {
      while (loraRenderDirty) {
        loraRenderDirty = false;
        await renderLoraLibraryNow();
      }
    })
    .finally(() => { loraRenderPromise = undefined; });
  return loraRenderPromise;
}

function captureLoraViewport() {
  if (!loraRoot) return undefined;
  const rootRect = loraRoot.getBoundingClientRect();
  const anchor = [...loraRoot.querySelectorAll("[data-lora-entry-key]")]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
    })
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
  return {
    innerScrollTop: loraRoot.scrollTop,
    outerScrollTop: promptRoot?.scrollTop || 0,
    anchorKey: anchor?.dataset.loraEntryKey,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - rootRect.top : undefined,
  };
}

async function restoreLoraViewport(snapshot) {
  if (!snapshot || !loraRoot) return;
  const targetRoot = loraRoot;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (targetRoot !== loraRoot || !targetRoot.isConnected) return;
  setScrollTopImmediately(promptRoot, snapshot.outerScrollTop);
  setScrollTopImmediately(loraRoot, snapshot.innerScrollTop);
  if (!snapshot.anchorKey || snapshot.anchorOffset === undefined) return;
  const anchor = [...loraRoot.querySelectorAll("[data-lora-entry-key]")]
    .find((node) => node.dataset.loraEntryKey === snapshot.anchorKey && node.getBoundingClientRect().height > 0);
  if (!anchor) return;
  const rootRect = loraRoot.getBoundingClientRect();
  const currentOffset = anchor.getBoundingClientRect().top - rootRect.top;
  setScrollTopImmediately(loraRoot, loraRoot.scrollTop + currentOffset - snapshot.anchorOffset);
}

async function renderLoraLibraryNow() {
  if (!loraRoot) return;
  const targetRoot = loraRoot;
  await loadLoras();
  if (targetRoot !== loraRoot || !targetRoot.isConnected) return;
  const viewport = captureLoraViewport();
  loraRoot.replaceChildren(el("div", "pwb-empty-inline", format("LoRA data ready; building {0} catalog entries…", [loraItems.length])));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (targetRoot !== loraRoot || !targetRoot.isConnected) return;
  if (loraModelSelect) {
    const models = [...new Set(loraItems.map((item) => loraBaseModel(item)))].sort((a, b) => a.localeCompare(b));
    const signature = models.join("\n");
    if (loraModelSelect.dataset.signature !== signature) {
      const selected = loraModelSelect.value;
      loraModelSelect.innerHTML = "";
      loraModelSelect.append(new Option(t("All models"), ""));
      for (const model of models) {
        const count = loraItems.filter((item) => loraBaseModel(item) === model).length;
        loraModelSelect.append(new Option(`${model} (${count})`, model));
      }
      loraModelSelect.value = models.includes(selected) ? selected : "";
      loraModelSelect.dataset.signature = signature;
    }
  }
  const needle = (loraSearch?.value || "").trim().toLowerCase();
  const modelFilter = loraModelSelect?.value || "";
  const used = extractWorkflowLoras();
  const recordsMatchingAllGroups = new Set();
  const matches = loraItems.filter((item) => {
    const key = normalizeLoraKey(item.file);
    if (workflowOnly && !used.has(key) && ![...used].some((usedKey) => usedKey.endsWith(key) || key.endsWith(usedKey))) return false;
    if (modelFilter && loraBaseModel(item) !== modelFilter) return false;
    const words = wordsForLora(item).join(" ");
    const itemGroups = groupsForLora(item);
    const groupText = itemGroups.map((group) => `${group.name} ${group.note} ${group.sourceLabel || ""} ${group.words.join(" ")}`).join(" ");
    const recordWords = itemGroups.length ? "" : words;
    const recordText = `${item.file} ${item.name || ""} ${item.notes || ""} ${item.archiveCharacter || ""} ${item.sourceLabel || ""} ${bilingualLoraName(item.file, displayAliases())} ${loraBaseModel(item)} ${recordWords}`.toLowerCase();
    if (!needle || recordText.includes(needle)) recordsMatchingAllGroups.add(key);
    return !needle || recordText.includes(needle) || groupText.toLowerCase().includes(needle);
  });
  if (!matches.length) {
    loraRoot.replaceChildren(el("div", "pwb-empty-inline", loraItems.length ? t("No matching LoRAs.") : t("No LoRA data available.")));
    return;
  }
  const libraryEntries = [];
  for (const item of matches) {
    const itemKey = normalizeLoraKey(item.file);
    const allItemGroups = groupsForLora(item);
    const itemGroups = !needle || recordsMatchingAllGroups.has(itemKey)
      ? allItemGroups
      : allItemGroups.filter((group) => `${group.name} ${group.note} ${group.sourceLabel || ""} ${group.words.join(" ")}`.toLowerCase().includes(needle));
    const recordCharacter = String(item.archiveCharacter || "").trim();
    const groupsByCharacter = new Map();
    const unassignedGroups = [];
    for (const group of itemGroups) {
      const groupCharacter = String(group.archiveCharacter || "").trim();
      if (!groupCharacter) {
        unassignedGroups.push(group);
        continue;
      }
      if (!groupsByCharacter.has(groupCharacter)) groupsByCharacter.set(groupCharacter, []);
      groupsByCharacter.get(groupCharacter).push(group);
    }
    const splitByGroupCharacter = groupsByCharacter.size > 1
      || (groupsByCharacter.size === 1 && !groupsByCharacter.has(recordCharacter));
    if (splitByGroupCharacter) {
      for (const [archiveCharacter, groups] of groupsByCharacter) {
        libraryEntries.push({ item, archiveCharacter, groups, splitFromMultiCharacterLora: true });
      }
      if (unassignedGroups.length) {
        libraryEntries.push({ item, archiveCharacter: recordCharacter, groups: unassignedGroups, splitFromMultiCharacterLora: false });
      }
    } else {
      libraryEntries.push({
        item,
        archiveCharacter: recordCharacter || [...groupsByCharacter.keys()][0] || "",
        groups: itemGroups,
        splitFromMultiCharacterLora: false,
      });
    }
  }
  const orderedEntries = [];
  const emittedCharacters = new Set();
  for (const entry of libraryEntries) {
    const groupedCharacter = Boolean(entry.archiveCharacter);
    if (!groupedCharacter) {
      orderedEntries.push(entry);
      continue;
    }
    if (emittedCharacters.has(entry.archiveCharacter)) continue;
    emittedCharacters.add(entry.archiveCharacter);
    orderedEntries.push(...libraryEntries.filter((candidate) => candidate.archiveCharacter === entry.archiveCharacter));
  }
  const visibleEntries = orderedEntries;
  const renderTarget = document.createDocumentFragment();
  renderTarget.append(el("div", "pwb-hint", format("Loaded {0} characters or LoRAs; details are generated when expanded.", [orderedEntries.length])));
  const characterRoots = new Map();
  for (const entry of visibleEntries) {
    const item = entry.item;
    const key = normalizeLoraKey(item.file);
    const batchSelected = state.batchLoraEntries.some((entry) => normalizeLoraKey(entry.key) === key);
    const baseModel = loraBaseModel(item);
    const archiveCharacter = entry.archiveCharacter;
    const mergedCharacter = Boolean(archiveCharacter);
    let cardRoot = renderTarget;
    if (mergedCharacter) {
      if (!characterRoots.has(archiveCharacter)) {
        const merged = el("article", "pwb-character-merged");
        const mergedHead = el("div", "pwb-character-merged-head");
        const characterEntries = libraryEntries.filter((candidate) => candidate.archiveCharacter === archiveCharacter);
        const characterCount = characterEntries.length;
        const splitFromMultiCharacterLora = characterEntries.some((candidate) => candidate.splitFromMultiCharacterLora);
        mergedHead.append(
          el("strong", "", archiveCharacter),
          el("span", "pwb-muted", characterCount > 1
            ? format("{0} LoRAs grouped as one character", [characterCount])
            : splitFromMultiCharacterLora
              ? t("Split by character from a multi-character LoRA")
              : t("1 LoRA grouped as a character card"))
        );
        const variants = [...new Set(characterEntries.map((candidate) => candidate.item.sourceLabel || translatedLoraName(candidate.item.file, displayAliases())))];
        const mergedBody = el("div", "pwb-character-merged-body");
        merged.append(mergedHead);
        if (variants.length) {
          const variantList = el("div", "pwb-character-merged-variants");
          variantList.append(el("span", "pwb-muted", t("Version")));
          for (const variant of variants) variantList.append(el("span", "pwb-character-version-chip", variant));
          merged.append(variantList);
        }
        merged.append(mergedBody);
        renderTarget.append(merged);
        characterRoots.set(archiveCharacter, mergedBody);
      }
      cardRoot = characterRoots.get(archiveCharacter);
    }
    const entryKey = `${key}::${archiveCharacter || ""}`;
    const makeVariantSummary = () => {
      const summary = el("summary", "pwb-character-variant-summary");
      const savedSelection = new Set(state.loraGroupSelections[key] || []);
      const selectedGroupCount = entry.groups.filter((candidate) => savedSelection.has(candidate.id)).length;
      summary.append(
        el("strong", "", item.sourceLabel || translatedLoraName(item.file, displayAliases())),
        el("span", "pwb-lora-model", baseModel),
        el("span", "pwb-muted", format("{0} groups{1}", [entry.groups.length, selectedGroupCount ? format(" · Selected {0}", [selectedGroupCount]) : ""]))
      );
      if (batchSelected) summary.append(el("span", "pwb-group-batch-state", t("Added to batch")));
      return summary;
    };
    if (!expandedLoraEntries.has(entryKey)) {
      const lazyVariant = el("details", `pwb-character-variant pwb-lora-lazy${used.has(key) ? " in-workflow" : ""}${batchSelected ? " batch-selected" : ""}`);
      lazyVariant.dataset.loraEntryKey = entryKey;
      lazyVariant.append(makeVariantSummary());
      lazyVariant.addEventListener("toggle", () => {
        if (!lazyVariant.open) return;
        expandedLoraEntries.clear();
        expandedLoraEntries.add(entryKey);
        renderLoraLibrary();
      }, { once: true });
      cardRoot.append(lazyVariant);
      continue;
    }
    const words = wordsForLora(item);
    const selectedWords = selectedWordsForLora(item);
    const selectedSet = new Set(selectedWords);
    const templateFixed = (activeTemplate()?.fixedLoraFiles || []).some((file) => normalizeLoraKey(file) === key);
    const card = el("article", `pwb-lora-card ${used.has(key) ? "in-workflow" : ""} ${batchSelected ? "batch-selected" : ""}`);
    card.dataset.loraEntryKey = entryKey;
    const head = el("div", "pwb-lora-card-head");
    const names = el("div", "pwb-lora-titles");
    names.append(
      el("strong", "pwb-lora-cn", translatedLoraName(item.file, displayAliases())),
      el("span", "pwb-lora-original", item.name || item.file),
      el("span", `pwb-lora-model${baseModel === t("Unknown model") ? " unknown" : ""}`, format("Base model: {0}", [baseModel]))
    );
    if (item.notes) names.append(el("span", "pwb-lora-note", item.notes));
    head.append(names, button(t("Alias / triggers"), () => editLora(item), "subtle"));
    card.append(head);
    const groups = entry.groups;
    if (groups.length) {
      const groupList = el("div", "pwb-lora-groups");
      const entryGroupIds = new Set(groups.map((group) => group.id));
      const selectedGroups = selectedGroupsForLora(item).filter((group) => entryGroupIds.has(group.id));
      const selectedGroupIds = new Set(selectedGroups.map((group) => group.id));
      for (const group of groups) {
        const isGroupSelected = selectedGroupIds.has(group.id);
        const batchEntries = batchEntriesForGroup(item, group);
        const isInBatch = batchEntries.length > 0;
        const groupCard = el("div", `pwb-lora-group${isGroupSelected ? " selected" : ""}${isInBatch ? " batch-included" : ""}`);
        groupCard.dataset.loraKey = key;
        groupCard.dataset.groupId = group.id;
        const groupHead = el("div", "pwb-lora-group-head");
        const groupText = el("div", "pwb-lora-group-text");
        groupText.append(el("strong", "pwb-lora-group-name", group.name));
        if (isInBatch) groupText.append(el("span", "pwb-group-batch-state", format("In batch {0}", [batchEntries.length > 1 ? ` ×${batchEntries.length}` : ""])));
        const sourceLabel = group.sourceLabel || item.sourceLabel || translatedLoraName(item.file, displayAliases());
        const sourceNote = mergedCharacter && !String(group.note || "").includes(sourceLabel) ? format("Version source: {0}", [sourceLabel]) : "";
        if (group.note || sourceNote) groupText.append(el("span", "pwb-lora-group-note", [group.note, sourceNote].filter(Boolean).join("；")));
        const groupEditActions = el("div", "pwb-actions compact");
        if (group.words.length) groupEditActions.append(button(isGroupSelected ? t("✓ Selected") : t("Select"), (event) => toggleLoraGroupSelection(item, group, event.currentTarget), isGroupSelected ? "primary" : "subtle"));
        groupEditActions.append(button(t("Edit"), () => editLoraGroup(item, group), "subtle"));
        if (group.id !== "missing") groupEditActions.append(button(t("Delete group"), () => deleteLoraGroup(item, group), "subtle danger"));
        groupHead.append(groupText, groupEditActions);
        const preview = el("div", "pwb-lora-group-preview", group.words.length ? group.words.join(", ") : t("No triggers yet"));
        preview.title = group.words.join(", ");
        const groupActions = el("div", "pwb-actions compact");
        if (group.words.length) {
          groupActions.append(
            button(t("Add above"), () => addSelection("lora", `${translatedLoraName(item.file, displayAliases())} / ${group.name}`, group.words.join(", "), { loraFile: item.file }), "primary"),
            button(t("Fill current field"), () => {
              const field = activeTemplateField();
              if (!field || field.fixed) return toast(t("No fill target"), t("Select a non-fixed field."), "warn");
              field.value = group.words.join(", ");
              field.loraFile = item.file;
              saveState();
              renderTemplates();
            }),
            isInBatch
              ? button(t("Remove from batch"), (event) => removeBatchLoraGroup(item, group, event.currentTarget), "danger")
              : button(t("Add to batch"), (event) => addBatchLoraGroup(item, group, event.currentTarget))
          );
        }
        groupCard.append(groupHead, preview, groupActions);
        groupList.append(groupCard);
      }
      if (selectedGroups.length) {
        const combinedActions = el("div", "pwb-lora-combined-actions");
        combinedActions.append(
          el("strong", "", format("Selected {0} groups: {1}", [selectedGroups.length, selectedGroups.map((group) => group.name).join(" + ")])),
          button(t("Add combination above"), () => addCombinedGroupsAbove(item, selectedGroups), "primary"),
          button(t("Fill field with combination"), () => fillTemplateFromGroups(item, selectedGroups)),
          button(t("Add combination to batch"), (event) => addBatchLoraCombination(item, selectedGroups, event.currentTarget))
        );
        groupList.append(combinedActions);
      }
      groupList.append(button(t("+ New trigger group"), () => addLoraGroup(item), "subtle"));
      card.append(groupList);
    } else {
    const chips = el("div", "pwb-library-chips");
    if (words.length) words.forEach((word) => {
      const chip = el("span", `pwb-word-chip ${selectedSet.has(word) ? "selected" : "unselected"}`);
      const choose = button(`${selectedSet.has(word) ? "✓ " : ""}${word}`, () => toggleLoraWord(item, word), "word-toggle");
      choose.title = selectedSet.has(word) ? t("Selected; click to deselect") : t("Not selected; click to add");
      const remove = button("×", () => deleteLoraWord(item, word), "word-delete danger");
      remove.title = t("Remove this trigger");
      chip.append(choose, remove);
      chips.append(chip);
    });
    else chips.append(el("span", "pwb-muted", t("No triggers yet; add them manually")));
    card.append(chips);
    const wordActions = el("div", "pwb-actions compact pwb-word-actions");
    wordActions.append(
      button(t("Select all"), () => setSelectedLoraWords(item, words), "subtle"),
      button(t("Clear selection"), () => setSelectedLoraWords(item, []), "subtle"),
      button(t("+ Append"), () => addLoraWords(item), "subtle"),
    );
    if (Object.hasOwn(state.loraTriggers, key)) wordActions.append(button(t("Restore original"), () => restoreLoraWords(item), "subtle"));
    card.append(wordActions);
    }
    const actions = el("div", "pwb-actions wrap");
    if (!groups.length) actions.append(
      button(t("Add selected words above"), () => addSelection("lora", translatedLoraName(item.file, displayAliases()), selectedWords.join(", "), { loraFile: item.file }), "primary"),
      button(t("Fill current template field"), () => fillTemplateFromLora(item))
    );
    actions.append(button(templateFixed ? t("Remove from fixed template LoRAs") : t("Add to fixed template LoRAs"), () => toggleTemplateFixedLora(item), templateFixed ? "fixed-selected" : ""));
    card.append(actions);
    const variant = el("details", "pwb-character-variant");
    variant.dataset.loraEntryKey = entryKey;
    variant.open = true;
    variant.append(makeVariantSummary(), card);
    variant.addEventListener("toggle", () => {
      if (variant.open) return;
      expandedLoraEntries.delete(entryKey);
      renderLoraLibrary();
    });
    cardRoot.append(variant);
  }
  if (targetRoot !== loraRoot || !targetRoot.isConnected) return;
  loraRoot.replaceChildren(renderTarget);
  await restoreLoraViewport(viewport);
}

function decorateLoraWidgets(node) {
  for (const widget of node?.widgets || []) {
    const values = widget.options?.values;
    const isLoraWidget = String(widget.name || "").toLowerCase().includes("lora") || (Array.isArray(values) && values.some(looksLikeLora));
    if (!isLoraWidget || !widget.options) continue;
    if (Array.isArray(values)) values.filter(looksLikeLora).forEach((value) => knownLoraFiles.add(value));
    widget.options.getOptionLabel = (value) => looksLikeLora(value) ? bilingualLoraName(value, displayAliases()) : String(value);
  }
  exposeLoraTranslation();
}

function translateVisibleLoraUi(root = document) {
  for (const nameEl of root.querySelectorAll?.(".lm-lora-name") || []) {
    const original = nameEl.closest("[data-lora-name]")?.dataset.loraName;
    if (!original) continue;
    const translated = bilingualLoraName(original, displayAliases());
    if (nameEl.textContent !== translated) nameEl.textContent = translated;
    nameEl.title = original;
  }
  for (const item of root.querySelectorAll?.(".litecontextmenu .litemenu-entry[data-value]") || []) {
    const original = item.dataset.value;
    if (!looksLikeLora(original)) continue;
    const translated = bilingualLoraName(original, displayAliases());
    if (item.textContent !== translated) item.textContent = translated;
    item.title = original;
  }
}

function decorateAllLoraWidgets() {
  for (const node of app.graph?._nodes || []) decorateLoraWidgets(node);
  translateVisibleLoraUi();
  app.canvas?.setDirty?.(true, true);
}

function startTranslationObserver() {
  if (translationObserver) return;
  translationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        if (!added.matches(".lm-lora-name,.litecontextmenu") && !added.querySelector(".lm-lora-name,.litecontextmenu")) continue;
        translateVisibleLoraUi(added.matches(".lm-lora-name,.litecontextmenu") ? added.parentElement || added : added);
      }
    }
  });
  translationObserver.observe(document.body, { childList: true, subtree: true });
}

function batchEntries() {
  const entries = [];
  for (const selected of state.batchLoraEntries) {
    const key = normalizeLoraKey(selected.key);
    const item = loraItems.find((candidate) => normalizeLoraKey(candidate.file) === key);
    if (!item) continue;
    const availableGroups = groupsForLora(item);
    const wantedIds = selected.groupIds?.length ? selected.groupIds : [selected.groupId].filter(Boolean);
    const groups = wantedIds.map((id) => availableGroups.find((candidate) => candidate.id === id)).filter(Boolean);
    if (!groups.length && availableGroups[0]) groups.push(availableGroups[0]);
    const text = groups.length ? combinedGroupWords(groups).join(", ") : selectedWordsForLora(item).join(", ");
    const characters = [...new Set(groups.map((group) => String(group.archiveCharacter || "").trim()).filter(Boolean))];
    const character = characters.join(" + ") || String(item.archiveCharacter || "").trim() || selected.label || translatedLoraName(item.file, displayAliases());
    entries.push({ label: `${translatedLoraName(item.file, displayAliases())} / ${groups.map((group) => group.name).join(" + ") || selected.label || ""}`, character, text, loraFile: item.file });
  }
  for (const [index, text] of state.batchManualText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).entries()) {
    entries.push({ label: format("Manual character {0}", [index + 1]), character: format("Manual character {0}", [index + 1]), text });
  }
  return entries;
}

function batchTemplates() {
  const selected = new Set(state.batchTemplateIds);
  return state.templates.filter((template) => selected.has(template.id));
}

function currentBatchPresetData() {
  return {
    templateIds: clone(state.batchTemplateIds),
    loraEntries: clone(state.batchLoraEntries),
    manualText: state.batchManualText,
    changeLora: state.batchChangeLora,
    templates: clone(batchTemplates()),
    separator: state.separator,
  };
}

function saveCurrentBatchPreset() {
  const suggested = format("Batch preset {0}", [state.batchPresets.length + 1]);
  const name = prompt(t("Batch preset name"), suggested)?.trim();
  if (!name) return;
  const existing = state.batchPresets.find((preset) => preset.name === name);
  if (existing && !confirm(format("'{0}' already exists. Replace it with the current selection?", [name]))) return;
  const payload = { ...(existing || { id: uid(), createdAt: Date.now() }), ...currentBatchPresetData(), name, updatedAt: Date.now() };
  if (existing) state.batchPresets[state.batchPresets.indexOf(existing)] = payload;
  else state.batchPresets.push(payload);
  saveState();
  renderBatchPanel();
  toast(t("Batch preset saved"), format("{0} · {1} LoRA selections", [name, payload.loraEntries.length]), "success");
}

function loadBatchPreset(presetId) {
  const preset = state.batchPresets.find((candidate) => candidate.id === presetId);
  if (!preset) return toast(t("Batch preset not found"), t("This preset may have been deleted."), "warn");
  if (Array.isArray(preset.templates)) {
    for (const template of clone(preset.templates)) {
      const index = state.templates.findIndex((entry) => entry.id === template.id);
      if (index < 0) state.templates.push(template);
      else state.templates[index] = template;
    }
  }
  if (typeof preset.separator === 'string') state.separator = preset.separator;
  state.batchTemplateIds = clone(preset.templateIds || []);
  state.batchLoraEntries = clone(preset.loraEntries || []).map((entry) => ({ ...entry, id: entry.id || uid() }));
  state.batchManualText = String(preset.manualText || "");
  state.batchChangeLora = preset.changeLora !== false;
  saveState();
  renderBatchPanel();
  renderTemplates();
  renderLoraLibrary();
  toast(t("Batch preset loaded"), format("{0} · {1} LoRA selections", [preset.name, state.batchLoraEntries.length]), "success");
}

function deleteBatchPreset(presetId) {
  const preset = state.batchPresets.find((candidate) => candidate.id === presetId);
  if (!preset || !confirm(format("Delete saved batch workflow '{0}'?", [preset.name]))) return;
  state.batchPresets = state.batchPresets.filter((candidate) => candidate.id !== presetId);
  saveState();
  renderBatchPanel();
}

function clearCurrentBatchSelection() {
  if ((state.batchLoraEntries.length || state.batchManualText.trim()) && !confirm(t("Clear the current batch selection? Saved presets will be kept."))) return;
  state.batchLoraEntries = [];
  state.batchManualText = "";
  saveState();
  renderBatchPanel();
  renderLoraLibrary();
}


function runWidgetQueueCallbacks(name) {
  const graph = app.rootGraph || app.graph;
  for (const outerNode of graph?.computeExecutionOrder?.(false) || graph?._nodes || []) {
    for (const node of outerNode.getInnerNodes?.(new Map()) || [outerNode]) {
      for (const widget of node.widgets || []) widget[name]?.({ isPartialExecution: false });
    }
  }
}

function matchingLoraValue(widget, file) {
  const wanted = normalizeLoraKey(file);
  const values = Array.isArray(widget.options?.values) ? widget.options.values : [];
  if (!values.length) return file;
  return values.find((value) => {
    if (typeof value !== "string") return false;
    const candidate = normalizeLoraKey(value);
    return candidate === wanted || candidate.endsWith(`/${wanted}`) || wanted.endsWith(`/${candidate}`);
  });
}

function collectLoraTargets(nodes, loraEntries, explicit) {
  const targets = [];
  for (const node of nodes) {
    for (const widget of node.widgets || []) {
      if (typeof widget.value !== "string" || !String(widget.name || "").toLowerCase().includes("lora")) continue;
      const values = Array.isArray(widget.options?.values) ? widget.options.values : [];
      if (!explicit && !values.length) continue;
      const resolved = new Map();
      let compatible = true;
      for (const entry of loraEntries) {
        const value = matchingLoraValue(widget, entry.loraFile);
        if (value === undefined) {
          compatible = false;
          break;
        }
        resolved.set(normalizeLoraKey(entry.loraFile), value);
      }
      if (compatible) targets.push({ node, widget, resolved, original: widget.value, originalMode: node.mode });
    }
  }
  return targets;
}

function batchLoraTargets(entries, changeLora = state.batchChangeLora) {
  const loraEntries = entries.filter((entry) => entry.loraFile);
  if (!changeLora || !loraEntries.length) return [];
  const selectedNodes = Object.values(app.canvas?.selected_nodes || {});
  const selectedTargets = collectLoraTargets(selectedNodes, loraEntries, true);
  if (selectedTargets.length) {
    const named = selectedTargets.find((target) => /人物|角色|character|subject/i.test(`${target.node.title || ""} ${target.node.type || ""}`));
    const carryingCharacter = selectedTargets.find((target) => loraEntries.some((entry) => normalizeLoraKey(target.widget.value) === normalizeLoraKey(entry.loraFile)));
    return [named || carryingCharacter || selectedTargets[0]];
  }
  const automaticTargets = collectLoraTargets(app.graph?._nodes || [], loraEntries, false);
  return automaticTargets.length === 1 ? automaticTargets : [];
}

function batchFixedLoraTargets(templates, characterTargets) {
  const maximum = Math.max(0, ...templates.map((template) => (template.fixedLoraFiles || []).length));
  const selectedNodes = Object.values(app.canvas?.selected_nodes || {});
  const candidates = collectLoraTargets(selectedNodes, [], true)
    .filter((candidate) => !characterTargets.some((target) => target.node === candidate.node && target.widget === candidate.widget))
    .sort((a, b) => Number(a.node.id) - Number(b.node.id));
  const remaining = [...candidates];
  const assigned = [];
  for (let index = 0; index < maximum; index++) {
    const files = [...new Set(templates.map((template) => template.fixedLoraFiles?.[index]).filter(Boolean).map(normalizeLoraKey))];
    const candidateIndex = remaining.findIndex((target) => files.every((file) => matchingLoraValue(target.widget, file) !== undefined));
    if (candidateIndex < 0) break;
    assigned.push(remaining.splice(candidateIndex, 1)[0]);
  }
  return { targets: [...assigned, ...remaining], assignedCount: assigned.length };
}

function setBatchLora(targets, entry) {
  for (const target of targets) {
    const value = entry.loraFile ? target.resolved.get(normalizeLoraKey(entry.loraFile)) : target.original;
    target.node.mode = entry.loraFile ? 0 : target.originalMode;
    target.widget.value = value;
    target.widget.callback?.(value, app.canvas, target.node, target.widget);
  }
}

function setTemplateFixedLoras(targets, template) {
  const files = template.fixedLoraFiles || [];
  for (const [index, target] of targets.entries()) {
    const file = files[index];
    if (!file) {
      target.node.mode = 4;
      continue;
    }
    const value = matchingLoraValue(target.widget, file);
    target.node.mode = 0;
    target.widget.value = value;
    target.widget.callback?.(value, app.canvas, target.node, target.widget);
  }
}

function restoreLoraTargets(targets) {
  for (const target of targets) {
    target.node.mode = target.originalMode;
    target.widget.value = target.original;
    target.widget.callback?.(target.original, app.canvas, target.node, target.widget);
  }
}

function batchRunJobCount(plan = batchRunPlan) { return jobCount(plan); }

function batchRunJobAt(plan, index) { return jobAt(plan, index, plan.separator ?? state.separator); }

function batchJobSignature(job) {
  return `${job.template.name || ""}\u001f${job.entry.character || job.entry.label || ""}`;
}

function prepareBatchExecution(plan) {
  const target = selectedTextWidget();
  if (!target) throw new Error(t("Select the CLIP / prompt node to update on the canvas."));
  const templates = plan.templates;
  const entries = plan.entries;
  const loraEntries = entries.filter((entry) => entry.loraFile);
  const loraTargets = batchLoraTargets(entries, plan.changeLora);
  if (plan.changeLora && loraEntries.length && !loraTargets.length) throw new Error(t("Select both the prompt node and the LoRA loader to switch automatically."));
  const fixedLoraCount = Math.max(0, ...templates.map((template) => (template.fixedLoraFiles || []).length));
  const fixedLoraPlan = batchFixedLoraTargets(templates, loraTargets);
  const fixedLoraTargets = fixedLoraPlan.targets;
  if (fixedLoraPlan.assignedCount < fixedLoraCount) throw new Error(format("Not enough fixed LoRA loaders: select {0} more compatible nodes.", [fixedLoraCount - fixedLoraPlan.assignedCount]));
  return { target, loraTargets, fixedLoraTargets };
}

async function lightweightQueueRemaining() {
  const response = await api.fetchApi("/prompt", { cache: "no-store" });
  if (!response.ok) throw new Error(format("Could not read queue capacity (HTTP {0})", [response.status]));
  const payload = await response.json();
  return Math.max(0, Number(payload?.exec_info?.queue_remaining || 0));
}

async function waitForBatchQueueSlot(control, queued, total) {
  for (;;) {
    if (batchPauseRequested) return false;
    const remaining = await lightweightQueueRemaining();
    if (batchPauseRequested) return false;
    if (remaining < BATCH_QUEUE_HIGH_WATER) return true;
    batchRunProgress.status = "feeding";
    if (control?.isConnected) {
      control.textContent = format("Submitting {0} / {1} · Queue {2}", [queued, total, remaining]);
    }
    await new Promise((resolve) => setTimeout(resolve, BATCH_QUEUE_POLL_MS));
  }
}

function pauseBatchSubmission() {
  if (!batchQueueRunning) return toast(t("No batch is currently submitting"), t("Start a batch workflow to pause it here."), "warn");
  batchPauseRequested = true;
  batchRunProgress.paused = true;
  persistBatchRunProgress();
  const control = document.querySelector(".pwb-batch-pause");
  if (control) {
    control.disabled = true;
    control.textContent = t("Pausing…");
  }
  toast(t("Pausing batch"), t("New submissions will stop. Tasks already queued will finish."), "success");
}

async function submitBatchJobIndexes(plan, indexes, { firstAtFront = false } = {}) {
  if (batchQueueRunning) return toast(t("Batch is submitting"), t("Wait for the current submission to finish."), "warn");
  let execution;
  try {
    execution = prepareBatchExecution(plan);
  } catch (error) {
    return toast(t("Cannot resume batch"), error.message, "warn");
  }
  const { target, loraTargets, fixedLoraTargets } = execution;
  const original = target.widget.value;
  const control = document.querySelector(".pwb-batch-run");
  const pauseControl = document.querySelector(".pwb-batch-pause");
  const oldControlLabel = control?.textContent;
  let queued = 0;
  let paused = false;
  batchQueueRunning = true;
  batchPauseRequested = false;
  batchRunProgress.paused = false;
  batchRunProgress.status = "submitting";
  batchRunProgress.lastError = "";
  persistBatchRunProgress();
  if (control) control.disabled = true;
  if (pauseControl) pauseControl.disabled = false;
  try {
    for (const [position, jobIndex] of indexes.entries()) {
      if (!await waitForBatchQueueSlot(control, queued, indexes.length)) {
        paused = true;
        break;
      }
      const job = batchRunJobAt(plan, jobIndex);
      if (control) control.textContent = format("Submitting {0} / {1}", [queued + 1, indexes.length]);
      target.widget.value = job.text;
      target.widget.callback?.(job.text, app.canvas, target.node, target.widget);
      setBatchLora(loraTargets, job.entry);
      setTemplateFixedLoras(fixedLoraTargets, job.template);
      runWidgetQueueCallbacks("beforeQueued");
      const prompt = await app.graphToPrompt();
      if (batchPauseRequested) { paused = true; break; }
      if (prompt?.workflow) {
        if (!prompt.workflow.extra || typeof prompt.workflow.extra !== "object") prompt.workflow.extra = {};
        prompt.workflow.extra.prompt_workbench_template_task = {
          template: job.template.name,
          character: job.entry.character || job.entry.label,
          batchRunId: plan.id,
          batchJobIndex: jobIndex,
        };
      }
      const result = await api.queuePrompt(firstAtFront && position === 0 ? -1 : 0, prompt);
      runWidgetQueueCallbacks("afterQueued");
      const previous = batchRunProgress.jobs?.[String(jobIndex)] || {};
      if (!batchRunProgress.jobs || typeof batchRunProgress.jobs !== "object") batchRunProgress.jobs = {};
      batchRunProgress.jobs[String(jobIndex)] = {
        promptId: String(result?.prompt_id || ""),
        attempts: Number(previous.attempts || 0) + 1,
        submittedAt: Date.now(),
      };
      batchRunProgress.nextIndex = Math.max(Number(batchRunProgress.nextIndex || 0), jobIndex + 1);
      persistBatchRunProgress();
      queued++;
      // Give Chromium a rendering/GC opportunity between complete workflow
      // snapshots instead of monopolising the renderer for a burst of jobs.
      await new Promise((resolve) => setTimeout(resolve, BATCH_SUBMIT_YIELD_MS));
    }
    batchRunProgress.status = paused ? "paused" : "queued";
    batchRunProgress.paused = paused;
    batchRunProgress.lastError = "";
    persistBatchRunProgress();
    if (paused) toast(t("Batch paused"), format("Submitted {0} tasks; the plan and resume point are saved for later.", [queued]), "success");
    else toast(firstAtFront ? t("Batch resumed") : t("Batch queued"), format("Submitted {0} missing tasks without duplicating running or queued tasks.", [queued]), "success");
    if (activeTab === "queue") renderQueue();
  } catch (error) {
    batchRunProgress.status = "interrupted";
    batchRunProgress.lastError = error.message;
    persistBatchRunProgress();
    toast(t("Batch submission interrupted"), format("Added {0} tasks; {1}", [queued, error.message]), "error");
  } finally {
    batchQueueRunning = false;
    batchPauseRequested = false;
    if (control?.isConnected) {
      control.disabled = false;
      control.textContent = oldControlLabel;
    }
    if (pauseControl?.isConnected) {
      pauseControl.disabled = true;
      pauseControl.textContent = t("Pause submission");
    }
    target.widget.value = original;
    target.widget.callback?.(original, app.canvas, target.node, target.widget);
    restoreLoraTargets([...loraTargets, ...fixedLoraTargets]);
    target.node.graph?.change?.();
    app.canvas?.setDirty?.(true, true);
    renderBatchPanel();
  }
}

async function queueBatch() {
  if (batchQueueRunning) return toast(t("Batch is submitting"), t("Wait for the current submission to finish."), "warn");
  const templates = batchTemplates();
  const entries = batchEntries();
  if (!templates.length) return toast(t("No templates selected"), t("Select at least one template."), "warn");
  if (!entries.length) return toast(t("No character prompts"), t("Add a character from the LoRA library or enter one prompt per line."), "warn");
  const plan = {
    id: uid(),
    createdAt: Date.now(),
    templates: clone(templates),
    entries: clone(entries),
    changeLora: state.batchChangeLora,
    separator: state.separator,
  };
  try {
    prepareBatchExecution(plan);
  } catch (error) {
    return toast(t("Cannot start batch"), error.message, "warn");
  }
  const total = batchRunJobCount(plan);
  if (total > 200 && !confirm(format("Submit {0} tasks? They will be added gradually. Continue?", [total]))) return;
  if (validBatchRun() && batchRunProgress.status !== "completed" && !confirm(t("A previous batch can still be resumed. Starting a new batch replaces its resume record. Continue?"))) return;
  batchRunPlan = plan;
  batchRunProgress = { runId: plan.id, status: "ready", nextIndex: 0, resumeIndex: 0, completedThrough: 0, jobs: {}, lastError: "" };
  persistBatchRunPlan();
  persistBatchRunProgress();
  await submitBatchJobIndexes(plan, Array.from({ length: total }, (_, index) => index));
}

async function batchRunServerStatus() {
  const promptIds = Object.values(batchRunProgress.jobs || {}).map((job) => job?.promptId).filter(Boolean);
  const signatures = [...new Set(Array.from({ length: batchRunJobCount() }, (_, index) => batchJobSignature(batchRunJobAt(batchRunPlan, index))))];
  const response = await api.fetchApi("/prompt-workbench/batch-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: batchRunPlan.id, prompt_ids: promptIds, signatures }),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404 || response.status === 405) return batchRunQueueOnlyStatus(signatures);
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function batchRunQueueOnlyStatus(signatures) {
  const response = await api.fetchApi("/queue", { cache: "no-store" });
  if (!response.ok) throw new Error(format("Could not read queue (HTTP {0})", [response.status]));
  const queue = await response.json();
  const result = { statuses: {}, by_job: {}, by_signature: {}, queueOnly: true };
  const wanted = new Set(signatures);
  const record = (item, status) => {
    const promptId = String(item?.[1] || "");
    const extraData = item?.[3] || {};
    const metadata = extraData?.extra_pnginfo?.workflow?.extra?.prompt_workbench_template_task || extraData.prompt_workbench_template_task || {};
    const signature = `${metadata.template || ""}\u001f${metadata.character || ""}`;
    const entry = { promptId, status };
    if (promptId) result.statuses[promptId] = entry;
    if (metadata.batchRunId === batchRunPlan.id && Number.isInteger(Number(metadata.batchJobIndex))) result.by_job[String(Number(metadata.batchJobIndex))] = entry;
    if (wanted.has(signature)) {
      if (!result.by_signature[signature]) result.by_signature[signature] = [];
      result.by_signature[signature].push(entry);
    }
  };
  for (const item of queue.queue_running || []) record(item, "running");
  for (const item of queue.queue_pending || []) record(item, "pending");
  return result;
}

async function resumeBatchRun() {
  if (!validBatchRun()) return toast(t("No batch to resume"), t("Start a batch workflow first."), "warn");
  if (batchQueueRunning) return toast(t("Batch is submitting"), t("Wait for the current submission to finish."), "warn");
  const control = document.querySelector(".pwb-batch-resume");
  const oldLabel = control?.textContent;
  if (control) {
    control.disabled = true;
    control.textContent = t("Checking queue…");
  }
  try {
    const server = await batchRunServerStatus();
    let missing = [];
    let active = 0;
    let completed = 0;
    const activeIndexes = [];
    const signatureOffsets = {};
    const remoteCount = Object.keys(server.statuses || {}).length
      + Object.keys(server.by_job || {}).length
      + Object.values(server.by_signature || {}).reduce((count, entries) => count + (entries?.length || 0), 0);
    if (!batchRunProgress.jobs || typeof batchRunProgress.jobs !== "object") batchRunProgress.jobs = {};
    for (let index = 0; index < batchRunJobCount(); index++) {
      const key = String(index);
      const local = batchRunProgress.jobs[key] || {};
      let remote = server.by_job?.[key] || server.statuses?.[local.promptId];
      if (!remote) {
        const signature = batchJobSignature(batchRunJobAt(batchRunPlan, index));
        const offset = signatureOffsets[signature] || 0;
        remote = server.by_signature?.[signature]?.[offset];
        signatureOffsets[signature] = offset + 1;
      }
      if (remote?.promptId && remote.promptId !== local.promptId) {
        batchRunProgress.jobs[key] = { ...local, promptId: remote.promptId };
      }
      if (remote?.status === "completed" || (!remote && local.completed)) completed++;
      else if (remote?.status === "running" || remote?.status === "pending") {
        active++;
        activeIndexes.push(index);
      }
      else missing.push(index);
    }
    if (!remoteCount) {
      const resumeIndex = Math.max(0, Math.min(batchRunJobCount(), Number(batchRunProgress.resumeIndex ?? batchRunProgress.executionIndex ?? batchRunProgress.completedThrough ?? 0)));
      missing = Array.from({ length: batchRunJobCount() - resumeIndex }, (_, offset) => resumeIndex + offset);
      completed = resumeIndex;
    } else if (server.queueOnly) {
      // Local success markers allow paused batches to resume on older backends.
      missing = missing.filter((index) => !batchRunProgress.jobs[String(index)]?.completed);
    }
    persistBatchRunProgress();
    if (!missing.length) {
      batchRunProgress.status = completed === batchRunJobCount() ? "completed" : "queued";
      persistBatchRunProgress();
      renderBatchPanel();
      return toast(completed === batchRunJobCount() ? t("Batch completed") : t("Batch is still running"), completed === batchRunJobCount() ? t("No tasks are missing.") : format("{0} tasks are still running or queued; no resubmission is needed.", [active]), "success");
    }
    const firstJob = batchRunJobAt(batchRunPlan, missing[0]);
    const firstName = firstJob.entry.character || firstJob.entry.label;
    const message = format("Detected: {0} completed, {1} running/queued, {2} missing/interrupted.\n\nResume from '{3} / {4}'? The first task goes to the front; only missing tasks are added.", [completed, active, missing.length, firstName, firstJob.template.name]);
    if (!confirm(message)) return;
    await submitBatchJobIndexes(batchRunPlan, missing, { firstAtFront: true });
  } catch (error) {
    toast(t("Could not check previous batch"), error.message, "error");
  } finally {
    if (control?.isConnected) {
      control.disabled = false;
      control.textContent = oldLabel;
    }
  }
}

function createCurrentBatchRun(resumeIndex = 0) {
  const templates = batchTemplates();
  const entries = batchEntries();
  if (!templates.length || !entries.length) throw new Error(t("Keep the templates and characters used for the previous batch."));
  const plan = {
    id: uid(),
    createdAt: Date.now(),
    templates: clone(templates),
    entries: clone(entries),
    changeLora: state.batchChangeLora,
    separator: state.separator,
  };
  prepareBatchExecution(plan);
  const boundedResumeIndex = Math.max(0, Math.min(batchRunJobCount(plan), Number(resumeIndex) || 0));
  batchRunPlan = plan;
  batchRunProgress = { runId: plan.id, status: "ready", nextIndex: 0, resumeIndex: boundedResumeIndex, completedThrough: boundedResumeIndex, jobs: {}, lastError: "" };
  persistBatchRunPlan();
  persistBatchRunProgress();
  renderBatchPanel();
  return plan;
}

async function adoptCurrentBatchRun() {
  try {
    createCurrentBatchRun();
    await resumeBatchRun();
  } catch (error) {
    toast(t("Cannot create resume record"), error.message, "warn");
  }
}

async function resumeCurrentBatchFromPosition(position) {
  try {
    const requested = Number(position);
    if (!Number.isInteger(requested) || requested < 1) throw new Error(t("Enter a valid task number, for example 190."));
    const total = batchTemplates().length * batchEntries().length;
    if (!total) throw new Error(t("Keep the templates and characters used for the previous batch."));
    if (requested > total) throw new Error(format("The current combination has only {0} tasks.", [total]));
    const plan = createCurrentBatchRun(requested - 1);
    if (!confirm(format("Skip {0} tasks and submit from task {1} / {2} through the end?", [requested - 1, requested, total]))) return;
    const indexes = Array.from({ length: total - requested + 1 }, (_, offset) => requested - 1 + offset);
    await submitBatchJobIndexes(plan, indexes, { firstAtFront: true });
  } catch (error) {
    toast(t("Cannot resume from that task"), error.message, "warn");
  }
}

function renderBatchPanel() {
  if (!batchRoot) return;
  batchRoot.innerHTML = "";
  const presetBox = el("div", "pwb-batch-preset-box");
  const presetSelect = el("select", "pwb-select pwb-batch-preset-select");
  if (state.batchPresets.length) {
    for (const preset of state.batchPresets) {
      const option = el("option", "", format("{0} ({1} tasks)", [preset.name, (preset.loraEntries || []).length]));
      option.value = preset.id;
      presetSelect.append(option);
    }
  } else {
    const option = el("option", "", t("No saved presets"));
    option.value = "";
    presetSelect.append(option);
  }
  const loadPreset = button(t("Load"), () => loadBatchPreset(presetSelect.value), "primary");
  const deletePreset = button(t("Delete"), () => deleteBatchPreset(presetSelect.value), "subtle danger");
  loadPreset.disabled = deletePreset.disabled = !state.batchPresets.length;
  const presetActions = el("div", "pwb-batch-preset-actions");
  presetActions.append(loadPreset, button(t("Save current"), saveCurrentBatchPreset), button(t("Clear current"), clearCurrentBatchSelection, "subtle"), deletePreset);
  presetBox.append(el("div", "pwb-batch-resume-title", t("Saved batch presets")), presetSelect, presetActions, el("div", "pwb-hint", t("Save templates, character/outfit selections, manual prompts and automatic LoRA switching. Save 1/2/3, clear the selection to work on 4, then load the saved preset.")));
  const templateList = el("div", "pwb-batch-grid");
  for (const template of state.templates) {
    const label = el("label", "pwb-batch-choice");
    const checkbox = el("input", "");
    checkbox.type = "checkbox";
    checkbox.checked = state.batchTemplateIds.includes(template.id);
    checkbox.addEventListener("change", () => {
      const selected = new Set(state.batchTemplateIds);
      if (checkbox.checked) selected.add(template.id); else selected.delete(template.id);
      state.batchTemplateIds = [...selected];
      saveState();
      renderBatchPanel();
    });
    const fillField = templateFillField(template);
    label.append(checkbox, el("span", "", `${template.name} → ${fillField?.name || t("No variable field")}`));
    templateList.append(label);
  }
  const manual = el("textarea", "pwb-output pwb-batch-manual");
  manual.value = state.batchManualText;
  manual.placeholder = t("One character or replacement prompt per line:\ncharacter A\ncharacter B");
  manual.addEventListener("input", () => {
    state.batchManualText = manual.value;
    saveState();
    updateSummary();
  });
  const selectedLoras = el("div", "pwb-batch-selected");
  const renderSelected = () => {
    selectedLoras.innerHTML = "";
    const hiddenCount = Math.max(0, state.batchLoraEntries.length - BATCH_SELECTION_PREVIEW_LIMIT);
    if (hiddenCount) selectedLoras.append(el("div", "pwb-hint", format("The first {0} entries are collapsed; the latest {1} are shown. All entries remain part of the batch.", [hiddenCount, BATCH_SELECTION_PREVIEW_LIMIT])));
    for (const selected of state.batchLoraEntries.slice(-BATCH_SELECTION_PREVIEW_LIMIT)) {
      const key = normalizeLoraKey(selected.key);
      const item = loraItems.find((candidate) => normalizeLoraKey(candidate.file) === key);
      const availableGroups = item ? groupsForLora(item) : [];
      const wantedIds = selected.groupIds?.length ? selected.groupIds : [selected.groupId].filter(Boolean);
      const groups = wantedIds.map((id) => availableGroups.find((candidate) => candidate.id === id)).filter(Boolean);
      const label = item ? `${translatedLoraName(item.file, displayAliases())} / ${groups.map((group) => group.name).join(" + ") || selected.label || t("Default group")}` : key;
      const chip = el("div", "pwb-batch-entry");
      const remove = button(t("Remove"), () => {
        state.batchLoraEntries = state.batchLoraEntries.filter((entry) => entry.id !== selected.id);
        saveState();
        renderBatchPanel();
        renderLoraLibrary();
      }, "subtle danger");
      chip.append(el("span", "pwb-batch-entry-label", label), remove);
      selectedLoras.append(chip);
    }
    if (!state.batchLoraEntries.length) selectedLoras.append(el("span", "pwb-muted", t("No characters selected from the LoRA library.")));
  };
  const summary = el("div", "pwb-batch-summary");
  const switchLabel = el("label", "pwb-batch-choice pwb-batch-switch");
  const switchLora = el("input", "");
  switchLora.type = "checkbox";
  switchLora.checked = state.batchChangeLora;
  switchLora.addEventListener("change", () => {
    state.batchChangeLora = switchLora.checked;
    saveState();
  });
  switchLabel.append(switchLora, el("span", "", t("Automatically switch the LoRA for each character")));
  let resumeBox;
  if (validBatchRun()) {
    const total = batchRunJobCount();
    const submitted = Object.values(batchRunProgress.jobs || {}).filter((job) => job?.promptId).length;
    const statusLabels = {
      ready: t("Ready"),
      submitting: t("Submission disconnected"),
      feeding: t("Feeding queue"),
      interrupted: t("Submission interrupted"),
      paused: t("Submission paused"),
      queued: t("Queued"),
      executing: t("Running"),
      completed: t("Completed"),
    };
    resumeBox = el("div", "pwb-batch-resume-box");
    const created = batchRunPlan.createdAt ? new Date(batchRunPlan.createdAt).toLocaleString() : t("Unknown time");
    const resumeIndex = Math.max(0, Math.min(total, Number(batchRunProgress.resumeIndex || 0)));
    const position = batchRunProgress.status === "completed" ? total : Math.min(total, resumeIndex + 1);
    resumeBox.append(
      el("div", "pwb-batch-resume-title", t("Previous batch")),
      el("div", "pwb-hint", format("{0} · {1} {2} / {3} · {4} task IDs recorded", [created, statusLabels[batchRunProgress.status] || t("Ready to check"), position, total, submitted])),
    );
    if (batchRunProgress.lastError) resumeBox.append(el("div", "pwb-batch-resume-error", batchRunProgress.lastError));
    const actions = el("div", "pwb-batch-resume-actions");
    actions.append(
      button(batchRunProgress.status === "completed" ? t("Check previous batch") : format("Resume previous batch (from {0})", [position]), resumeBatchRun, "primary pwb-batch-resume"),
      button(t("Clear record"), () => {
        if (confirm(t("Clear the resume record only? Running and queued ComfyUI tasks will not be cancelled."))) clearBatchRun();
      }, "subtle danger"),
    );
    resumeBox.append(actions);
  } else {
    resumeBox = el("div", "pwb-batch-resume-box");
    const positionInput = el("input", "pwb-input pwb-batch-position-input");
    positionInput.type = "number";
    positionInput.min = "1";
    positionInput.step = "1";
    positionInput.placeholder = t("Resume position, e.g. 190");
    const specifiedActions = el("div", "pwb-batch-resume-actions");
    specifiedActions.append(positionInput, button(t("Resume from position"), () => resumeCurrentBatchFromPosition(positionInput.value), "primary"));
    resumeBox.append(
      el("div", "pwb-batch-resume-title", t("Resume interrupted batch")),
      el("div", "pwb-hint", t("Keep your original templates, characters and canvas node selection. Existing queue entries can be detected; after a restart, enter a resume position manually.")),
      button(t("Resume from current queue"), adoptCurrentBatchRun, "primary pwb-batch-resume"),
      specifiedActions,
    );
  }
  function updateSummary() {
    const templates = batchTemplates().length;
    const entries = batchEntries().length;
    summary.textContent = currentLocale() === 'en'
      ? `${templates} templates × ${entries} characters = ${templates * entries} tasks`
      : format("{0} templates × {1} characters = {2} queued tasks", [templates, entries, templates * entries]);
  }
  batchRoot.append(presetBox, el("div", "pwb-label", t("Templates (arrow shows the replacement field)")), templateList, el("div", "pwb-label", t("Selected LoRA characters")), selectedLoras, manual, switchLabel, el("div", "pwb-hint", t("Select the prompt, character LoRA and fixed LoRA nodes. Character nodes are identified by title; fixed nodes follow ascending node ID. Unused fixed loaders are bypassed and restored when needed.")));
  if (resumeBox) batchRoot.append(resumeBox);
  const runActions = el("div", "pwb-batch-run-actions");
  const pauseButton = button(batchPauseRequested ? t("Pausing…") : t("Pause submission"), pauseBatchSubmission, "pwb-batch-pause");
  pauseButton.disabled = !batchQueueRunning || batchPauseRequested;
  const startButton = button(t("Start batch"), queueBatch, "primary pwb-batch-run");
  startButton.disabled = batchQueueRunning;
  runActions.append(startButton, pauseButton);
  batchRoot.append(summary, runActions);
  renderSelected();
  updateSummary();
}

function rawClipTexts() {
  const results = [];
  for (const node of loadedWorkflowNodes) {
    const type = String(node.type || node.title || "");
    if (!/clip.*(text|encode|prompt)|(text|encode|prompt).*clip/i.test(type)) continue;
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    values.forEach((value, index) => {
      if (typeof value === "string" && normalizeText(value) && !MODEL_FILE.test(value)) {
        results.push({ id: node.id, type, index, text: value });
      }
    });
  }
  return results;
}

function renderClipTextViewer() {
  if (!clipTextRoot) return;
  clipTextRoot.innerHTML = "";
  const texts = rawClipTexts();
  for (const entry of texts) {
    const block = el("div", "pwb-prompt-block");
    block.append(el("div", "pwb-prompt-label", format("{0} · Node {1} · Input {2}", [entry.type, entry.id, entry.index + 1])));
    const content = el("div", "pwb-prompt-text", entry.text);
    content.title = t("Click to copy");
    content.addEventListener("click", async () => navigator.clipboard.writeText(entry.text));
    block.append(content);
    clipTextRoot.append(block);
  }
  if (!texts.length) clipTextRoot.append(el("div", "pwb-empty-inline", t("No readable CLIP text. Original text from missing CLIP nodes will appear here after loading a workflow.")));
}

function exposeMissingClipText(node) {
  const raw = loadedWorkflowNodes.find((item) => String(item.id) === String(node?.id));
  if (!raw || node.__pwbMissingClipText || !/clip.*(text|encode|prompt)|(text|encode|prompt).*clip/i.test(String(raw.type || "")) || (node.widgets || []).some((widget) => typeof widget.value === "string" && normalizeText(widget.value) && TEXT_INPUT.test(widget.name || ""))) return;
  const texts = (raw.widgets_values || []).filter((value) => typeof value === "string" && normalizeText(value) && !MODEL_FILE.test(value));
  if (!texts.length || typeof node.addDOMWidget !== "function") return;
  node.__pwbMissingClipText = true;
  for (const [index, text] of texts.entries()) {
    const area = el("textarea", "pwb-missing-clip-widget");
    area.value = text;
    area.readOnly = true;
    node.addDOMWidget(format("Original text {0}", [index + 1]), "pwb-missing-clip-text", area, { serialize: false });
  }
  node.setSize?.([Math.max(node.size?.[0] || 260, 300), Math.max(node.size?.[1] || 120, 220)]);
}

function buildPromptWorkbench(root, { renderLoras = true } = {}) {
  root.innerHTML = "";
  const archiveSection = el("section", "pwb-section pwb-character-archive");
  const archiveHeading = el("div", "pwb-section-heading");
  archiveHeading.append(el("h3", "pwb-section-title", t("Output character folders")));
  const archiveToggle = el("label", "pwb-fixed-label");
  const archiveCheckbox = el("input", "");
  archiveCheckbox.type = "checkbox";
  archiveCheckbox.checked = state.autoCharacterFolders;
  archiveCheckbox.addEventListener("change", () => {
    state.autoCharacterFolders = archiveCheckbox.checked;
    saveState();
  });
  archiveToggle.append(archiveCheckbox, document.createTextNode(t("Automatically organize future output")));
  archiveHeading.append(archiveToggle);
  archiveSection.append(
    archiveHeading,
    el("div", "pwb-hint", t("Save future output in character folders. Different LoRAs and outfits for the same character share a folder; multi-character LoRAs use the selected character triggers. Unrecognized assets use the existing unknown-character folder.")),
    el("div", "pwb-hint", t("Manage existing files with your operating system file manager."))
  );
  root.append(archiveSection);

  const selectedSection = el("section", "pwb-section");
  const selectedHeading = el("div", "pwb-section-heading");
  selectedHeading.append(el("h3", "pwb-section-title", t("Selected content")), button(t("Clear"), () => {
    state.selections = [];
    saveState();
    renderSelections();
  }, "subtle danger"));
  selectionsRoot = el("div", "pwb-selections");
  outputArea = el("textarea", "pwb-output");
  outputArea.readOnly = true;
  const separatorRow = el("div", "pwb-row");
  const separator = el("input", "pwb-input pwb-separator");
  separator.value = state.separator;
  separator.addEventListener("input", () => { state.separator = separator.value; saveState(); renderSelections(); });
  separatorRow.append(el("span", "pwb-muted", t("Separator between blocks")), separator);
  const actions = el("div", "pwb-actions wrap");
  actions.append(button(t("Copy"), async () => { await navigator.clipboard.writeText(assembledText()); toast(t("Copied"), t("The complete prompt was copied."), "success"); }), button(t("Write to selected node"), writeToSelectedNode, "primary"));
  selectedSection.append(selectedHeading, selectionsRoot, el("label", "pwb-label", t("Final output")), outputArea, separatorRow, actions);
  root.append(selectedSection);

  const manualSection = el("section", "pwb-section");
  manualSection.append(el("h3", "pwb-section-title", t("Manual complete prompt")));
  const manual = el("textarea", "pwb-output pwb-manual");
  manual.placeholder = t("Enter a complete prompt. It will appear above as a single selection.");
  manualSection.append(manual, button(t("Add as complete prompt"), () => {
    addSelection("prompt", t("Manual prompt"), manual.value);
    if (manual.value.trim()) manual.value = "";
  }, "primary"));
  root.append(manualSection);

  const templateSection = el("section", "pwb-section");
  templateSection.append(el("h3", "pwb-section-title", t("Named templates")));
  templateRoot = el("div", "pwb-template-editor");
  templateSection.append(templateRoot);
  root.append(templateSection);

  const batchSection = el("section", "pwb-section");
  batchSection.append(el("h3", "pwb-section-title", t("Batch workflow")), el("div", "pwb-hint", t("Select the prompt node, character LoRA node and enough fixed LoRA nodes on the canvas. Every selected character is combined with every selected template.")));
  batchRoot = el("div", "pwb-batch");
  batchSection.append(batchRoot);
  root.append(batchSection);

  const clipSection = el("section", "pwb-section");
  clipSection.append(el("h3", "pwb-section-title", t("Original CLIP node text")), el("div", "pwb-hint", t("View text stored in the workflow even when its CLIP node is missing. Missing nodes still cannot execute.")));
  clipTextRoot = el("div", "pwb-clip-texts");
  clipSection.append(clipTextRoot);
  root.append(clipSection);

  const loraSection = el("section", "pwb-section");
  const loraHeading = el("div", "pwb-section-heading");
  loraHeading.append(el("h3", "pwb-section-title", t("LoRA library")));
  const refreshLoras = button(t("Refresh LoRAs"), async () => {
    refreshLoras.disabled = true;
    try {
      await api.fetchApi("/lora-trigger-helper/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ online: false }),
      });
      loraLoaded = false;
      loraItems = [];
      await renderLoraLibrary();
      toast(t("LoRAs refreshed"), format("{0} files available", [loraItems.length]), "success");
    } finally {
      refreshLoras.disabled = false;
    }
  }, "subtle");
  const currentOnly = el("label", "pwb-fixed-label");
  const checkbox = el("input", "");
  checkbox.type = "checkbox";
  checkbox.checked = workflowOnly;
  checkbox.addEventListener("change", () => { workflowOnly = checkbox.checked; renderLoraLibrary(); });
  currentOnly.append(checkbox, document.createTextNode(t("Current workflow only")));
  loraHeading.append(refreshLoras, currentOnly);
  loraSearch = el("input", "pwb-input");
  loraSearch.placeholder = t("Search aliases, filenames or trigger words…");
  loraSearch.addEventListener("input", () => {
    clearTimeout(loraSearchTimer);
    loraSearchTimer = setTimeout(renderLoraLibrary, 180);
  });
  loraModelSelect = el("select", "pwb-input pwb-model-filter");
  loraModelSelect.title = t("Filter by the LoRA base model");
  loraModelSelect.append(new Option(t("All models"), ""));
  loraModelSelect.addEventListener("change", renderLoraLibrary);
  const loraFilters = el("div", "pwb-lora-filters");
  loraFilters.append(loraSearch, loraModelSelect);
  loraRoot = el("div", "pwb-lora-list merged");
  loraSection.append(loraHeading, loraFilters, el("div", "pwb-hint", t("Aliases are used for display and search. Workflows retain original filenames. Filter by base model or customize an alias.")), loraRoot);
  root.append(loraSection);

  const sectionLinks = [
    [archiveSection, t("Archive"), t("Organize output")],
    [selectedSection, t("Compose"), t("Compose final prompt")],
    [manualSection, t("Manual"), t("Add complete prompt")],
    [templateSection, t("Templates"), t("Manage variable fields")],
    [batchSection, t("Batch"), t("Generate combinations")],
    [clipSection, "CLIP", t("Read original node text")],
    [loraSection, "LoRA", t("Browse characters and outfits")],
  ];
  const hero = el("header", "pwb-workbench-hero");
  const heroText = el("div", "pwb-workbench-hero-text");
  heroText.append(
    el("span", "pwb-eyebrow", "PROMPT CONTROL CENTER"),
    el("h2", "pwb-workbench-title", t("Prompt Workbench")),
    el("p", "pwb-workbench-subtitle", t("Compose prompts, manage character LoRAs and run templates in batches."))
  );
  hero.append(heroText, el("span", "pwb-workbench-status", t("Connected")));
  const nav = el("nav", "pwb-section-nav");
  nav.setAttribute("aria-label", t("Workbench sections"));
  for (const [section, label, description] of sectionLinks) {
    const anchor = button(label, () => section.scrollIntoView({ behavior: "smooth", block: "start" }), "section-link");
    anchor.title = description;
    nav.append(anchor);
  }
  root.prepend(hero, nav);

  renderSelections();
  renderTemplates();
  renderBatchPanel();
  renderClipTextViewer();
  loraRoot.replaceChildren(el("div", "pwb-hint", currentLocale() === 'en' ? 'Loading LoRA library…' : t("Loading LoRA library…")));
  if (renderLoras) renderLoraLibrary();
}

function buildSidebar(root) {
  startTranslationObserver();
  startAssetRedoObserver();
  root.className = "pwb-root";
  root.innerHTML = "";
  const tabs = el("div", "pwb-tabs");
  const shellHeader = el("header", "pwb-shell-header");
  const brand = el("div", "pwb-brand");
  const brandText = el("div", "pwb-brand-text");
  brandText.append(el("strong", "", "Prompt Workbench"), el("span", "", t("Tasks and prompt tools")));
  brand.append(el("span", "pwb-brand-mark", "P"), brandText, el("span", "pwb-live-dot", "LOCAL"));
  const body = el("div", "pwb-body");
  queueRoot = el("div", "pwb-view");
  promptRoot = el("div", "pwb-view");
  body.append(queueRoot, promptRoot);
  const switchTab = (tab) => {
    activeTab = tab;
    queueRoot.hidden = tab !== "queue";
    promptRoot.hidden = tab !== "prompt";
    [...tabs.children].forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
    if (tab === "queue") renderQueue();
    if (tab === "prompt" && !promptRoot.childNodes.length) buildPromptWorkbench(promptRoot);
  };
  const queueTab = button(t("Task queue"), () => switchTab("queue"), "tab");
  queueTab.dataset.tab = "queue";
  const promptTab = button(t("Prompts / LoRA"), () => switchTab("prompt"), "tab");
  promptTab.dataset.tab = "prompt";
  tabs.append(queueTab, promptTab);
  shellHeader.append(brand, tabs);
  const settings = el('div', 'pwb-settings');
  const language = el('select', 'pwb-input');
  language.setAttribute('aria-label', t("Language"));
  for (const [value, name] of [['auto', t('Follow ComfyUI')], ['en', 'English'], ['zh-CN', '简体中文']]) language.append(new Option(name, value));
  language.value = storage.getItem(LOCALE_KEY) || 'auto';
  language.addEventListener('change', () => {
    if (batchQueueRunning) {
      language.value = currentLocale();
      return toast(t("Batch is submitting"), t("Wait for the current submission to finish."), 'warn');
    }
    storage.setItem(LOCALE_KEY, language.value);
    loraLoaded = false;
    buildSidebar(root);
  });
  const importFile = el('input', '');
  importFile.type = 'file';
  importFile.accept = '.json,application/json';
  importFile.hidden = true;
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file || batchQueueRunning) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Backup exceeds 10 MB.');
      const incoming = validateBackup(JSON.parse(await file.text()));
      if (!confirm(t("Import replaces current templates and selections. Continue? A backup of your current state will be downloaded."))) return;
      downloadBackup(state);
      if (!storage.setItem(STORAGE_KEY, JSON.stringify(incoming))) throw new Error('Browser storage is unavailable.');
      state = loadState();
      activeTemplateId = state.templates[0]?.id;
      activeFieldId = templateFillField(state.templates[0])?.id;
      buildSidebar(root);
    } catch (error) { toast(t("Import failed"), error.message, 'error'); }
    importFile.value = '';
  });
  settings.append(language, button(t("Export backup"), () => downloadBackup(state)), button(t("Import backup"), () => {
    if (batchQueueRunning) return toast(t("Batch is submitting"), t("Wait for the current submission to finish."), 'warn');
    importFile.click();
  }), importFile);
  shellHeader.append(settings);
  root.append(shellHeader, body);
  switchTab(activeTab);
  installSidebarResizer(root);
}

function installSidebarResizer(root) {
  const sidebar = root.closest("aside, [role='complementary'], .sidebar, .side-bar-panel") || root.parentElement;
  if (!sidebar || root.querySelector(".pwb-resize-handle")) return;
  const applyWidth = (value) => {
    const width = Math.max(340, Math.min(900, Number(value) || 420));
    sidebar.style.setProperty("flex-basis", `${width}px`, "important");
    sidebar.style.setProperty("flex-grow", "0", "important");
    sidebar.style.setProperty("flex-shrink", "0", "important");
    return width;
  };
  const savedWidth = Number(storage.getItem(SIDEBAR_WIDTH_KEY));
  applyWidth(savedWidth >= 340 ? savedWidth : 420);

  const handle = el("div", "pwb-resize-handle");
  handle.title = t("Drag to resize the workbench; double-click to reset");
  const updateEdge = () => handle.classList.toggle("left-edge", sidebar.getBoundingClientRect().left > window.innerWidth / 2);
  updateEdge();
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    updateEdge();
    handle.classList.add("dragging");
    const move = (pointer) => {
      const rect = sidebar.getBoundingClientRect();
      const width = rect.left > window.innerWidth / 2 ? rect.right - pointer.clientX : pointer.clientX - rect.left;
      storage.setItem(SIDEBAR_WIDTH_KEY, String(applyWidth(width)));
    };
    const stop = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  });
  handle.addEventListener("dblclick", () => {
    storage.setItem(SIDEBAR_WIDTH_KEY, "420");
    applyWidth(420);
  });
  root.append(handle);
}

app.registerExtension({
  name: "PromptWorkbench.Sidebar",
  async init() {
    await initializeI18n(api.fetchApi.bind(api), () => app.ui.settings.getSettingValue('Comfy.Locale', 'en'));
    app.ui.settings.addEventListener?.('Comfy.Locale.change', () => {
      const root = queueRoot?.closest('.pwb-root');
      if (root && !batchQueueRunning && (!storage.getItem(LOCALE_KEY) || storage.getItem(LOCALE_KEY) === 'auto')) {
        loraLoaded = false;
        buildSidebar(root);
      }
    });
    ensureStyles();
    installCharacterArchiveQueueHook();
    installBatchProgressTracking();
    exposeLoraTranslation();
    if (!app.extensionManager?.registerSidebarTab) {
      console.warn('Prompt Workbench requires a ComfyUI frontend with registerSidebarTab. Update the frontend and reload.');
      return;
    }
    app.extensionManager.registerSidebarTab({
      id: "prompt-workbench",
      icon: "pi pi-th-large",
      title: t("Prompt Workbench"),
      tooltip: t("Inspect queues, edit templates, browse LoRAs and compose prompts"),
      type: "custom",
      render(root) {
        buildSidebar(root);
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => { if (activeTab === "queue" && !document.hidden) renderQueue(); }, 3000);
      },
      destroy() {
        clearInterval(refreshTimer);
        clearTimeout(queueRenderTimer);
        queueRenderTimer = undefined;
        refreshTimer = undefined;
        translationObserver?.disconnect();
        translationObserver = undefined;
        assetRedoObserver?.disconnect();
        assetRedoObserver = undefined;
        queueRoot = promptRoot = undefined;
        loraRoot = loraSearch = loraModelSelect = undefined;
        templateRoot = batchRoot = selectionsRoot = outputArea = clipTextRoot = undefined;
      },
    });
    api.addEventListener("status", () => {
      if (activeTab === "queue" && queueRoot) scheduleQueueRender();
    });
  },
  nodeCreated(node) {
    decorateLoraWidgets(node);
  },
  loadedGraphNode(node) {
    decorateLoraWidgets(node);
    exposeMissingClipText(node);
  },
  beforeConfigureGraph(graphData) {
    loadedWorkflowNodes = clone(graphData?.nodes || []);
  },
  afterConfigureGraph() {
    for (const node of app.graph?._nodes || []) exposeMissingClipText(node);
    renderClipTextViewer();
  },
});
