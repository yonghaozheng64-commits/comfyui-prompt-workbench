import { loadState, clone, uid } from './state.js';
import { storage } from './storage.js';
import { t, prompt, confirm, LOCALE_KEY, currentLocale } from './i18n.js';
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
window.addEventListener('pwb-storage-error', () => toast('保存失败', '浏览器存储不可用，请导出备份后再关闭页面。', 'error'));

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

async function organizeExistingOutput() {
  const buttonNode = document.querySelector(".pwb-organize-output");
  if (buttonNode) buttonNode.disabled = true;
  try {
    const previewResponse = await api.fetchApi("/lora-trigger-helper/character-archive/preview", { cache: "no-store" });
    const preview = await previewResponse.json().catch(() => ({}));
    if (!previewResponse.ok) throw new Error(preview.error || `HTTP ${previewResponse.status}`);
    const top = Object.entries(preview.characters || {}).slice(0, 8).map(([name, count]) => `${name} ${count}`).join("、");
    const message = `将移动 ${preview.total} 个图片/视频：已识别 ${preview.recognized} 个，未识别 ${preview.unknown} 个。\n\n主要目录：${top || "无"}\n\n未识别文件会进入“人物归档/_未识别人物”，确定继续吗？`;
    if (!preview.total || !confirm(message)) return;
    const response = await api.fetchApi("/lora-trigger-helper/character-archive/organize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    toast("output 已按人物整理", `已移动 ${result.moved} 个资产；${Object.keys(result.characters || {}).length} 个人物目录`, "success");
  } catch (error) {
    toast("整理 output 失败", error.message || String(error), "error");
  } finally {
    if (buttonNode) buttonNode.disabled = false;
  }
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
      results.push({ node: workflowNode?.title || workflowNode?.type || node.class_type || `节点 ${nodeId}`, input: name, text });
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
    template: template || "未命名模板",
    character: character || "手工人物",
  };
}

function taskTime(item) {
  const timestamp = item?.[3]?.create_time;
  return timestamp ? new Date(timestamp).toLocaleString() : "时间未知";
}

async function cancelPending(promptId) {
  if (!confirm("确定取消这个排队任务吗？")) return;
  const response = await api.fetchApi("/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!response.ok) return toast("取消失败", await response.text(), "error");
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
    throw new Error((await modern.text()) || `取消原任务失败（HTTP ${modern.status}）`);
  }
  const endpoint = status === "running" ? "/interrupt" : "/queue";
  const body = status === "running" ? { prompt_id: promptId } : { delete: [promptId] };
  const fallback = await api.fetchApi(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!fallback.ok) throw new Error((await fallback.text()) || `取消原任务失败（HTTP ${fallback.status}）`);
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
  if (!promptId || !Object.keys(prompt).length) return toast("无法重做", "任务缺少原始 prompt 数据。", "error");
  const changedSeeds = randomizePromptSeeds(prompt);
  const message = status === "running"
    ? `这会中断当前任务，保留其他节点参数、随机更换 ${changedSeeds} 个种子并从头执行，且插到所有等待任务之前。确定重做吗？`
    : `这会移除原排队任务，保留其他节点参数、随机更换 ${changedSeeds} 个种子并插到队首。确定重做吗？`;
  if (!confirm(message)) return;
  control.disabled = true;
  const oldLabel = control.textContent;
  control.textContent = "正在插队…";
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
    const seedDetail = changedSeeds ? `已更换 ${changedSeeds} 个种子` : "未发现可修改的种子输入";
    toast("已插队重做", `新任务 ${submittedPromptId.slice(0, 12)} 已排到队首；${seedDetail}。`, "success");
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
    toast("插队重做失败", error.message, "error");
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
  control.textContent = "读取中…";
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
    if (!historyResponse.ok) throw new Error((await historyResponse.text()) || `读取历史任务失败（HTTP ${historyResponse.status}）`);
    const history = await historyResponse.json();
    if (sourcePromptId) {
      task = historyTaskFromResponse(history, sourcePromptId);
    } else {
      const matched = historyTaskForAsset(history, reference);
      sourcePromptId = String(matched.promptId || "");
      task = matched.task;
    }
    if (!sourcePromptId) throw new Error("找不到这项资产对应的历史任务，历史记录可能已被清理。");
    const prompt = clone(task?.[2] || {});
    const extraData = clone(task?.[3] || {});
    if (!Object.keys(prompt).length) throw new Error("历史记录中缺少原始 prompt，可能已被清理。");

    const changedSeeds = randomizePromptSeeds(prompt);
    delete extraData.create_time;
    extraData.prompt_workbench_redo_of = sourcePromptId;
    extraData.prompt_workbench_redo_asset = assetId || `${reference.type}/${reference.subfolder}/${reference.filename}`;
    const payload = { prompt, extra_data: extraData, front: true };
    if (api.clientId) payload.client_id = api.clientId;
    control.textContent = "插队中…";
    const submitResponse = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await submitResponse.text();
    let result = {};
    try { result = text ? JSON.parse(text) : {}; } catch {}
    if (!submitResponse.ok || result.error) {
      throw new Error(result.error?.message || result.error?.details || text || `提交失败（HTTP ${submitResponse.status}）`);
    }
    const seedDetail = changedSeeds ? `已随机更换 ${changedSeeds} 个种子` : "未发现数字种子输入";
    toast("资产已插队重做", `新任务 ${String(result.prompt_id || "").slice(0, 12)} 已排到队首；${seedDetail}。`, "success");
    control.textContent = "已提交";
    setTimeout(() => {
      if (control.isConnected) {
        control.disabled = false;
        control.textContent = oldLabel;
      }
    }, 1800);
  } catch (error) {
    toast("资产重做失败", error.message, "error");
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
    const redo = el("button", "pwb-asset-redo", "↻ 重做");
    redo.type = "button";
    redo.title = "恢复这张资产的原始工作流，随机更换种子并插到队首";
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
  const title = el("div", "pwb-task-title", status === "running" ? "运行中" : `排队 #${index + 1}`);
  title.prepend(el("span", `pwb-badge ${status}`, status === "running" ? "RUNNING" : "PENDING"));
  head.append(title, el("time", "pwb-time", taskTime(item)));
  card.append(head);
  const templateTask = templateTaskSummary(item);
  if (templateTask) {
    const summary = el("div", "pwb-task-template-summary");
    summary.append(
      el("div", "pwb-task-template-row", "模板工作流"),
      el("strong", "pwb-task-template-name", templateTask.template),
      el("span", "pwb-task-template-character", `LoRA 人物：${templateTask.character}`)
    );
    card.append(summary);
  } else {
    const texts = extractPromptText(item);
    for (const entry of texts) {
      const block = el("div", "pwb-prompt-block");
      block.append(el("div", "pwb-prompt-label", `${entry.node} · ${entry.input}`));
      const content = el("div", "pwb-prompt-text", entry.text);
      content.title = "点击复制";
      content.addEventListener("click", async () => {
        await navigator.clipboard.writeText(entry.text);
        toast("已复制", entry.node);
      });
      block.append(content);
      card.append(block);
    }
    if (!texts.length) card.append(el("div", "pwb-empty-inline", "没有识别到文本提示词；该任务可能只修改了参数。"));
  }
  const foot = el("div", "pwb-task-foot");
  foot.append(el("code", "pwb-task-id", String(item?.[1] || "").slice(0, 12)));
  const redo = button("插队重做", () => redoTaskAtFront(item, status, redo), "primary subtle");
  foot.append(redo);
  if (status === "pending") foot.append(button("取消任务", () => cancelPending(item[1]), "danger subtle"));
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
    summary.append(el("span", "", `运行中 ${running.length}`), el("span", "", `等待中 ${pending.length}`), button("刷新", renderQueue, "subtle"));
    queueRoot.append(summary);
    running.forEach((item, index) => queueRoot.append(renderTask(item, "running", index)));
    pending.slice(0, queueVisibleLimit).forEach((item, index) => queueRoot.append(renderTask(item, "pending", index)));
    if (pending.length > queueVisibleLimit) {
      const more = el("div", "pwb-queue-more");
      more.append(
        el("span", "pwb-muted", `已显示 ${queueVisibleLimit} / ${pending.length} 个等待任务`),
        button(`继续显示 ${Math.min(QUEUE_PAGE_SIZE, pending.length - queueVisibleLimit)} 个`, () => {
          queueVisibleLimit += QUEUE_PAGE_SIZE;
          renderQueue();
        }, "primary subtle")
      );
      queueRoot.append(more);
    }
    if (!running.length && !pending.length) queueRoot.append(el("div", "pwb-empty", "队列是空的。提交任务后，可在这里查看每项任务的提示词。"));
  } catch (error) {
    if (targetRoot !== queueRoot || !targetRoot?.isConnected) return;
    queueRoot.innerHTML = "";
    queueRoot.append(el("div", "pwb-empty", `读取队列失败：${error.message}`));
  }
}

function assembledText() {
  return state.selections.map((item) => item.text.trim()).filter(Boolean).join(state.separator);
}

function addSelection(type, label, text, extra = {}) {
  const value = normalizeText(text);
  if (!value) return toast("内容为空", "没有可加入的提示词。", "warn");
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
    head.append(el("strong", "", item.type === "lora" ? `LoRA：${item.label}` : item.label || "完整提示词"));
    const actions = el("div", "pwb-actions compact");
    actions.append(
      button("编辑", () => {
        const next = prompt("编辑完整内容", item.text);
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
    body.title = "双击编辑";
    body.addEventListener("dblclick", () => actions.firstChild.click());
    card.append(head, body);
    selectionsRoot.append(card);
  }
  if (!state.selections.length) selectionsRoot.append(el("div", "pwb-empty-inline", "这里只显示已选择的 LoRA 整组触发词，或你加入的完整提示词。"));
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
  if (!target) return toast("没有可写入的节点", "请先选中一个含文本或提示词输入框的节点。", "warn");
  const text = assembledText();
  if (!text) return toast("上方内容为空", "请先选择 LoRA 词组或加入完整提示词。", "warn");
  target.widget.value = text;
  target.widget.callback?.(text, app.canvas, target.node, target.widget);
  target.node.graph?.change?.();
  app.canvas?.setDirty?.(true, true);
  toast("已写入提示词", target.node.title || target.node.type, "success");
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
    fillButton.textContent = fillButton.dataset.fillField === fieldId ? "当前填充位" : "选作填充位";
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
  const raw = prompt("粘贴从其他浏览器导出的模板 JSON", "");
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw);
    const incoming = Array.isArray(parsed) ? parsed : parsed?.templates;
    if (!Array.isArray(incoming) || !incoming.length) throw new Error("没有读取到模板数组");
    const normalized = incoming.map((template, index) => {
      if (!template || typeof template !== "object") throw new Error(`第 ${index + 1} 个模板格式无效`);
      const name = String(template.name || "").trim();
      const fields = Array.isArray(template.fields) ? template.fields.filter((field) => field && typeof field === "object") : [];
      if (!name || !fields.length) throw new Error(`第 ${index + 1} 个模板缺少名称或字段`);
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
    toast("模板导入完成", `导入 ${normalized.length} 个，当前共 ${state.templates.length} 个模板`, "success");
  } catch (error) {
    toast("模板导入失败", error.message || String(error), "error");
  }
}

async function exportTemplatesToClipboard() {
  const text = JSON.stringify({ format: "prompt-workbench-templates-v1", templates: state.templates }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast("模板已复制", `${state.templates.length} 个模板已复制到剪贴板`, "success");
  } catch {
    prompt("复制下面的模板 JSON", text);
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
    button("新建", () => {
      const name = prompt("新模板名称", "我的模板");
      if (!name?.trim()) return;
      const template = { id: uid(), name: name.trim(), fields: [{ id: uid(), name: "可变内容", value: "", fixed: false }] };
      state.templates.push(template);
      activeTemplateId = template.id;
      activeFieldId = template.fields[0].id;
      saveState();
      renderTemplates();
    }, "subtle"),
    button("重命名", () => {
      const template = activeTemplate();
      const name = prompt("模板名称", template.name);
      if (name?.trim()) {
        template.name = name.trim();
        saveState();
        renderTemplates();
      }
    }, "subtle"),
    button("导入模板", importTemplatesFromJson, "subtle"),
    button("复制导出", exportTemplatesToClipboard, "subtle"),
    button("删除", () => {
      if (state.templates.length <= 1) return toast("不能删除", "至少保留一个模板。", "warn");
      if (!confirm(`删除模板“${activeTemplate().name}”？`)) return;
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

  const hint = el("div", "pwb-hint", "点选一个可变字段后，可在下方 LoRA 库点击“填入模板”。固定字段在清空变量时会保留。所有内容都可直接修改。");
  templateRoot.append(hint);
  const fixedLoras = el("div", "pwb-template-fixed-loras");
  fixedLoras.append(el("div", "pwb-label", "这个模板固定使用的 LoRA（按顺序对应固定 LoRA 加载节点）"));
  const fixedLoraChips = el("div", "pwb-batch-selected");
  for (const file of activeTemplate().fixedLoraFiles || []) {
    fixedLoraChips.append(button(`${translatedLoraName(file, displayAliases())} ×`, () => {
      activeTemplate().fixedLoraFiles = (activeTemplate().fixedLoraFiles || []).filter((value) => normalizeLoraKey(value) !== normalizeLoraKey(file));
      saveState();
      renderTemplates();
      renderLoraLibrary();
    }, "library-chip lora"));
  }
  if (!(activeTemplate().fixedLoraFiles || []).length) fixedLoraChips.append(el("span", "pwb-muted", "暂无；可从下方 LoRA 库加入当前模板。"));
  fixedLoras.append(fixedLoraChips);
  templateRoot.append(fixedLoras);
  const fields = el("div", "pwb-template-fields advanced");
  for (const [fieldIndex, field] of activeTemplate().fields.entries()) {
    const row = el("div", `pwb-template-field ${field.id === activeFieldId ? "active" : ""}`);
    row.dataset.fieldId = field.id;
    row.addEventListener("click", (event) => {
      if (event.target.closest("button,input,textarea,label")) return;
      if (!selectTemplateField(field.id)) toast("这是固定字段", "取消固定后才能设为 LoRA 填充位。", "warn");
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
    grip.title = "拖拽调整字段顺序";
    grip.draggable = true;
    grip.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("application/x-pwb-template-field", field.id);
      event.dataTransfer.effectAllowed = "move";
    });
    const name = el("input", "pwb-input");
    name.value = field.name;
    name.placeholder = t("字段名称");
    name.addEventListener("input", () => { field.name = name.value; saveState(); });
    const fixedLabel = el("label", "pwb-fixed-label");
    const fixed = el("input", "");
    fixed.type = "checkbox";
    fixed.checked = !!field.fixed;
    fixed.addEventListener("change", () => {
      field.fixed = fixed.checked;
      saveState();
    });
    fixedLabel.append(fixed, document.createTextNode("固定"));
    head.append(grip, name, fixedLabel);
    const controls = el("div", "pwb-template-field-controls");
    const fillButton = button(field.id === activeFieldId ? "当前填充位" : "选作填充位", () => {
      if (field.fixed) return toast("这是固定字段", "先取消“固定”，再让 LoRA 自动替换。", "warn");
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
    value.placeholder = t("手工输入，或从 LoRA 自动填充");
    value.addEventListener("input", () => {
      field.value = value.value;
      field.loraFile = undefined;
      saveState();
    });
    row.append(head, controls, value);
    if (field.loraFile) row.append(el("div", "pwb-field-source", `来自 LoRA：${bilingualLoraName(field.loraFile, displayAliases())}`));
    fields.append(row);
  }
  templateRoot.append(fields);
  const actions = el("div", "pwb-actions wrap");
  actions.append(
    button("＋ 添加字段", () => {
      const field = { id: uid(), name: "新字段", value: "", fixed: false };
      activeTemplate().fields.push(field);
      activeFieldId = field.id;
      saveState();
      renderTemplates();
    }, "subtle"),
    button("清空可变项", () => {
      activeTemplate().fields.forEach((field) => { if (!field.fixed) { field.value = ""; field.loraFile = undefined; } });
      saveState();
      renderTemplates();
    }, "subtle"),
    button("生成完整提示词", () => addSelection("prompt", `模板：${activeTemplate().name}`, templateText(activeTemplate())), "primary"),
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
    .find((value) => value && !/^(unknown|none|null|n\/a)$/i.test(value)) || "未知模型";
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
    const translatedFile = automaticChineseName(item.file);
    if (!/[\u3400-\u9fff]/.test(translatedFile) && item.name && normalizeLoraKey(item.name) !== normalizeLoraKey(item.file)) {
      metadataAliases[normalizeLoraKey(item.file)] = automaticChineseName(item.name);
    }
  }
  for (const item of byKey.values()) if (looksLikeLora(item.file)) knownLoraFiles.add(item.file);
  loraItems = [...byKey.values()].sort((a, b) => translatedLoraName(a.file, displayAliases()).localeCompare(translatedLoraName(b.file, displayAliases()), "zh-CN"));
  loraLoaded = byKey.size > 0;
  renderBatchPanel();
}

async function deleteLoraFile(item) {
  const file = item.file;
  if (!confirm(`\u786e\u5b9a\u5c06 LoRA\u201c${file}\u201d\u79fb\u81f3\u56de\u6536\u7ad9\u5417\uff1f`)) return;
  try {
    let response = await api.fetchApi("/lora-trigger-helper/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });
    if (response.status === 404 || response.status === 405) {
      response = await api.fetchApi("/lora-trigger-helper/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = response.status === 405 ? "\u5220\u9664\u540e\u7aef\u5c1a\u672a\u52a0\u8f7d\uff0c\u8bf7\u5b8c\u6574\u91cd\u542f ComfyUI" : (result.error || `HTTP ${response.status}`);
      throw new Error(detail);
    }

    const key = normalizeLoraKey(file);
    delete state.loraAliases[key];
    delete state.loraTriggers[key];
    delete state.loraTriggerSelections[key];
    delete state.loraGroupSelections[key];
    state.batchLoraKeys = state.batchLoraKeys.filter((value) => normalizeLoraKey(value) !== key);
    state.batchLoraEntries = state.batchLoraEntries.filter((entry) => normalizeLoraKey(entry.key) !== key);
    for (const template of state.templates) {
      template.fixedLoraFiles = (template.fixedLoraFiles || []).filter((value) => normalizeLoraKey(value) !== key);
    }
    for (const value of [...knownLoraFiles]) {
      if (normalizeLoraKey(value) === key) knownLoraFiles.delete(value);
    }
    saveState();
    loraLoaded = false;
    loraItems = [];
    await renderLoraLibrary();
    renderTemplates();
    toast("\u5df2\u79fb\u81f3\u56de\u6536\u7ad9", file, "success");
  } catch (error) {
    toast("\u5220\u9664 LoRA \u5931\u8d25", error.message || String(error), "error");
  }
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
  { name: "\u89d2\u8272\u5916\u89c2", test: /\b(1girl|1boy|woman|man|female|male|hair|eyes?|breasts?|skin|face|girl|boy)\b/i, note: "\u89d2\u8272\u8eab\u4efd\u3001\u53d1\u8272\u3001\u77b3\u8272\u4e0e\u8eab\u4f53\u7279\u5f81" },
  { name: "\u670d\u88c5\u9020\u578b", test: /\b(dress|shirt|uniform|jacket|coat|skirt|bikini|swimsuit|kimono|apron|clothes|outfit|sleeves?|necktie|bowtie|leotard)\b/i, note: "\u670d\u88c5\u3001\u914d\u9970\u4e0e\u7279\u5b9a\u9020\u578b" },
  { name: "\u52a8\u4f5c\u8868\u73b0", test: /\b(pose|sex|fuck|blowjob|titfuck|doggy|missionary|cowgirl|dance|grabbing|motion|movement|swaying|bouncing)\b/i, note: "\u52a8\u4f5c\u3001\u59ff\u52bf\u4e0e\u8eab\u4f53\u8868\u73b0" },
  { name: "\u89c6\u9891\u8fd0\u52a8", test: /\b(video|animation|animate|temporal|camera|i2v|t2v|frames?|relight|lighting)\b/i, note: "\u89c6\u9891\u65f6\u5e8f\u3001\u8fd0\u52a8\u7a33\u5b9a\u6027\u4e0e\u955c\u5934\u8868\u73b0" },
  { name: "\u753b\u98ce\u6837\u5f0f", test: /\b(style|lineart|anime|comic|illustration|pixel|realistic|photorealistic|shading)\b/i, note: "\u542f\u7528\u7279\u5b9a\u753b\u98ce\u3001\u7ebf\u7a3f\u6216\u6e32\u67d3\u7279\u5f81" },
  { name: "\u753b\u8d28\u589e\u5f3a", test: /\b(quality|detailed|details?|masterpiece|aesthetic|sharp|focus|texture|refined|clean)\b/i, note: "\u63d0\u5347\u7ec6\u8282\u3001\u6e05\u6670\u5ea6\u4e0e\u6574\u4f53\u753b\u8d28" },
];

const TRIGGER_LABELS = {
  "nakiri erina": "\u8599\u5207\u7ed8\u91cc\u5948 / Erina",
  "yukihira souma": "\u5e78\u5e73\u521b\u771f / Soma",
  "arato hisako": "\u65b0\u6237\u7eef\u6c99\u5b50 / Hisako",
  tootsukischool: "\u8fdc\u6708\u5b66\u56ed\u6821\u670d",
  tootsukisummer: "\u8fdc\u6708\u590f\u5b63\u6821\u670d",
  "main thighhighs": "\u4e3b\u9020\u578b\uff08\u8fc7\u819d\u889c\uff09",
  "cooking-uniform": "\u53a8\u5e08\u670d",
  d0ubl3_bj: "\u53cc\u4eba\u53e3\u4ea4",
  d0gg1e: "\u540e\u5165\u4f53\u4f4d",
  m15510n4ry: "\u4f20\u6559\u58eb\u4f53\u4f4d",
  c0wg1rl: "\u5973\u4e0a\u4f4d",
  bl0wj0b: "\u53e3\u4ea4",
  sbevedef: "EVE \u9ed8\u8ba4\u9020\u578b",
  sbevealt: "EVE \u66ff\u6362\u9020\u578b",
};

const TRIGGER_NOTES = {
  d0ubl3_bj: "\u53cc\u5bf9\u4e00\u53e3\u4ea4\u52a8\u4f5c\u6a21\u5f0f",
  d0gg1e: "\u540e\u5165\u4f53\u4f4d\u52a8\u4f5c\u6a21\u5f0f",
  m15510n4ry: "\u4f20\u6559\u58eb\u4f53\u4f4d\u52a8\u4f5c\u6a21\u5f0f",
  c0wg1rl: "\u5973\u4e0a\u4f4d\u52a8\u4f5c\u6a21\u5f0f",
  bl0wj0b: "\u53e3\u4ea4\u52a8\u4f5c\u6a21\u5f0f",
  sbevedef: "EVE \u9ed8\u8ba4\u670d\u88c5\u4e0e\u5916\u89c2",
  sbevealt: "EVE \u66ff\u6362\u670d\u88c5\u4e0e\u5916\u89c2",
};

function groupCategories(words) {
  const text = words.join(" ");
  return GROUP_CATEGORIES.filter((category) => category.test.test(text));
}

const VISUAL_TRAITS = [
  ["parted bangs", "\u4e2d\u5206\u5218\u6d77"], ["blunt bangs", "\u9f50\u5218\u6d77"], ["hair between eyes", "\u773c\u95f4\u53d1"],
  ["twin braids", "\u53cc\u8fab\u5b50"], ["side ponytail", "\u4fa7\u9a6c\u5c3e"], ["ponytail", "\u9a6c\u5c3e"], ["braid", "\u7f16\u53d1"],
  ["long hair", "\u957f\u53d1"], ["short hair", "\u77ed\u53d1"], ["medium hair", "\u4e2d\u957f\u53d1"],
  ["black hair", "\u9ed1\u53d1"], ["brown hair", "\u68d5\u53d1"], ["blonde hair", "\u91d1\u53d1"], ["white hair", "\u767d\u53d1"],
  ["red hair", "\u7ea2\u53d1"], ["blue hair", "\u84dd\u53d1"], ["green hair", "\u7eff\u53d1"], ["pink hair", "\u7c89\u53d1"],
  ["purple hair", "\u7d2b\u53d1"], ["orange hair", "\u6a59\u53d1"], ["grey hair", "\u7070\u53d1"], ["aqua hair", "\u6c34\u8272\u5934\u53d1"],
  ["black eyes", "\u9ed1\u773c"], ["brown eyes", "\u68d5\u773c"], ["blue eyes", "\u84dd\u773c"], ["green eyes", "\u7eff\u773c"],
  ["red eyes", "\u7ea2\u773c"], ["pink eyes", "\u7c89\u773c"], ["purple eyes", "\u7d2b\u773c"], ["yellow eyes", "\u9ec4\u773c"],
  ["dark-skinned female", "\u6df1\u8272\u76ae\u80a4"], ["dark-skinned male", "\u6df1\u8272\u76ae\u80a4"], ["large breasts", "\u4e30\u6ee1\u80f8\u90e8"],
  ["cropped shirt", "\u77ed\u6b3e\u4e0a\u8863"], ["ribbed shirt", "\u7f57\u7eb9\u4e0a\u8863"], ["white shirt", "\u767d\u8272\u4e0a\u8863"],
  ["cleavage cutout", "\u80f8\u53e3\u9542\u7a7a"], ["puffy long sleeves", "\u6ce1\u6ce1\u957f\u8896"], ["puffy sleeves", "\u6ce1\u6ce1\u8896"],
  ["white skirt", "\u767d\u8272\u88d9\u5b50"], ["long skirt", "\u957f\u88d9"], ["pleated skirt", "\u767e\u8936\u88d9"], ["plaid skirt", "\u683c\u7eb9\u88d9"],
  ["school uniform", "\u6821\u670d"], ["military uniform", "\u519b\u88c5"], ["cooking-uniform", "\u53a8\u5e08\u670d"], ["lab coat", "\u5b9e\u9a8c\u670d"],
  ["black dress", "\u9ed1\u8272\u8fde\u8863\u88d9"], ["white dress", "\u767d\u8272\u8fde\u8863\u88d9"], ["purple dress", "\u7d2b\u8272\u793c\u670d"],
  ["swimsuit", "\u6cf3\u88c5"], ["bikini", "\u6bd4\u57fa\u5c3c"], ["kimono", "\u548c\u670d"], ["breastplate", "\u80f8\u7532"],
  ["detached sleeves", "\u5206\u79bb\u8896"], ["boots", "\u957f\u9774"], ["thighhighs", "\u8fc7\u819d\u889c"], ["navel", "\u9732\u8110"],
  ["hairpin", "\u53d1\u5939"], ["hairclip", "\u53d1\u9970"], ["necklace", "\u9879\u94fe"], ["choker", "\u9888\u5708"], ["jewelry", "\u73e0\u5b9d\u914d\u9970"],
];

function visualDescription(words) {
  const text = ` ${words.join(" ").toLowerCase()} `;
  const found = [];
  for (const [term, label] of VISUAL_TRAITS) {
    if (text.includes(` ${term} `) && !found.includes(label)) found.push(label);
  }
  return found.length ? `\u89c6\u89c9\u7279\u5f81\uff1a${found.slice(0, 12).join("\u3001")}` : "";
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
  if (mapped) return `\u72ec\u7acb\u89e6\u53d1\u6a21\u5f0f\uff1b${mapped}\uff1b\u5171 ${words.length} \u4e2a\u89e6\u53d1\u8bcd`;
  const visual = visualDescription(words);
  if (visual) return `${visual}\uff1b\u5171 ${words.length} \u4e2a\u89e6\u53d1\u8bcd`;
  const categories = groupCategories(words);
  const purpose = categories.length ? categories.slice(0, 3).map((category) => category.note).join("\uff1b") : (standalone ? "\u7528\u4e8e\u5207\u6362\u72ec\u7acb\u89d2\u8272\u3001\u670d\u88c5\u6216\u52a8\u4f5c\u6a21\u5f0f" : "\u542f\u7528\u8be5 LoRA \u7684\u4e3b\u8981\u7279\u5f81");
  return `${standalone ? "\u72ec\u7acb\u89e6\u53d1\u6a21\u5f0f\uff1b" : ""}${purpose}\uff1b\u5171 ${words.length} \u4e2a\u89e6\u53d1\u8bcd`;
}

function triggerGroupName(words, index, standalone = false) {
  const first = String(words[0] || "").trim();
  const mapped = TRIGGER_LABELS[first.toLowerCase()];
  if (mapped) return mapped;
  if (standalone && first) return first.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (first && !/^(1girl|1boy|girl|boy|woman|man)$/i.test(first) && first.length <= 36) return first;
  const categories = groupCategories(words);
  return `${categories[0]?.name || "\u9ed8\u8ba4\u89e6\u53d1"}\u7ec4${index > 0 ? ` ${index + 1}` : ""}`;
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
    name: "\u5f85\u8865\u5145\u89e6\u53d1\u8bcd",
    note: "\u672a\u4ece\u672c\u5730\u6216\u5143\u6570\u636e\u68c0\u6d4b\u5230\u89e6\u53d1\u8bcd\uff1b\u53ef\u70b9\u51fb\u7f16\u8f91\u624b\u5de5\u5efa\u7ec4",
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
          return { id: `outfit-${index + 1}`, name: `${triggerGroupName(modeWords, index)} \u5b8c\u6574\u9020\u578b`, note: groupNote(words), words };
        }
        return { id: `addon-${index + 1}`, name: `${triggerGroupName(modeWords, index)} \u9644\u52a0\u7ec4`, note: groupNote(modeWords), words: modeWords };
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
  anchorElement.textContent = isSelected ? "✓ 已选" : "选择";
  anchorElement.classList.toggle("primary", isSelected);
  anchorElement.classList.toggle("subtle", !isSelected);

  groupList.querySelector(".pwb-lora-combined-actions")?.remove();
  const visibleGroupIds = new Set([...groupList.querySelectorAll(".pwb-lora-group")].map((node) => node.dataset.groupId));
  const selectedGroups = groupsForLora(item).filter((candidate) => selected.has(candidate.id) && visibleGroupIds.has(candidate.id));
  if (!selectedGroups.length) return;
  const combinedActions = el("div", "pwb-lora-combined-actions");
  combinedActions.append(
    el("strong", "", `已选 ${selectedGroups.length} 组：${selectedGroups.map((candidate) => candidate.name).join(" + ")}`),
    button("组合加入上方", () => addCombinedGroupsAbove(item, selectedGroups), "primary"),
    button("组合填入当前字段", () => fillTemplateFromGroups(item, selectedGroups)),
    button("组合加入群体", (event) => addBatchLoraCombination(item, selectedGroups, event.currentTarget))
  );
  groupList.insertBefore(combinedActions, groupList.lastElementChild);
}

function combinedGroupWords(groups) {
  return [...new Set(groups.flatMap((group) => group.words))];
}

function fillTemplateFromGroups(item, groups) {
  const field = activeTemplateField();
  if (!field || field.fixed) return toast("\u6ca1\u6709\u53ef\u586b\u5145\u5b57\u6bb5", "\u8bf7\u9009\u62e9\u4e00\u4e2a\u975e\u56fa\u5b9a\u5b57\u6bb5\u3002", "warn");
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
  const name = prompt("\u5206\u7ec4\u540d\u79f0", group.name);
  if (name === null) return;
  const note = prompt("\u7528\u9014 / \u8868\u73b0\u5907\u6ce8", group.note || "");
  if (note === null) return;
  const words = prompt("\u89e6\u53d1\u8bcd\uff08\u9017\u53f7\u6216\u6362\u884c\u5206\u9694\uff09", group.words.join(", "));
  if (words === null) return;
  groups[index] = { ...group, name: name.trim() || group.name, note: note.trim(), words: wordsInGroup({ words: [words.replaceAll("\n", ",")] }) };
  try {
    await saveLoraGroups(item, groups);
    renderLoraLibrary();
    toast("\u89e6\u53d1\u8bcd\u5206\u7ec4\u5df2\u4fdd\u5b58", groups[index].name, "success");
  } catch (error) {
    toast("\u4fdd\u5b58\u5206\u7ec4\u5931\u8d25", error.message || String(error), "error");
  }
}

async function addLoraGroup(item) {
  const name = prompt("\u65b0\u5206\u7ec4\u540d\u79f0", "");
  if (!name?.trim()) return;
  const note = prompt("\u7528\u9014 / \u8868\u73b0\u5907\u6ce8", "") ?? "";
  const words = prompt("\u89e6\u53d1\u8bcd\uff08\u9017\u53f7\u6216\u6362\u884c\u5206\u9694\uff09", "");
  if (!words?.trim()) return;
  const groups = [...groupsForLora(item), { id: uid(), name: name.trim(), note: note.trim(), words: wordsInGroup({ words: [words.replaceAll("\n", ",")] }) }];
  try {
    await saveLoraGroups(item, groups);
    renderLoraLibrary();
  } catch (error) {
    toast("\u4fdd\u5b58\u5206\u7ec4\u5931\u8d25", error.message || String(error), "error");
  }
}

async function deleteLoraGroup(item, group) {
  if (!confirm(`\u5220\u9664\u89e6\u53d1\u8bcd\u5206\u7ec4\u201c${group.name}\u201d\uff1f`)) return;
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
    toast("\u5220\u9664\u5206\u7ec4\u5931\u8d25", error.message || String(error), "error");
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
    badge.textContent = `群体中${entries.length > 1 ? ` ×${entries.length}` : ""}`;
  } else {
    badge?.remove();
  }
  const key = normalizeLoraKey(item.file);
  const card = groupCard.closest(".pwb-lora-card");
  card?.classList.toggle("batch-selected", state.batchLoraEntries.some((entry) => normalizeLoraKey(entry.key) === key));
  const replacement = isInBatch
    ? button("从群体取消", (event) => removeBatchLoraGroup(item, group, event.currentTarget), "danger")
    : button("加入群体", (event) => addBatchLoraGroup(item, group, event.currentTarget));
  actionButton.replaceWith(replacement);
}

function addBatchLoraGroup(item, group, anchorElement) {
  state.batchLoraEntries.push({ id: uid(), key: normalizeLoraKey(item.file), groupId: group.id, groupIds: [group.id], label: group.name });
  saveState();
  refreshBatchPanelWithoutJump(anchorElement);
  syncBatchGroupInPlace(item, group, anchorElement);
  toast("\u5df2\u52a0\u5165\u7fa4\u4f53\u5de5\u4f5c\u6d41", `${translatedLoraName(item.file, displayAliases())} / ${group.name}`, "success");
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
  const added = prompt("追加触发词（可以每行一个）", "");
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
  const alias = prompt("中文显示名称（留空恢复自动翻译）", state.loraAliases[key] || translatedLoraName(item.file, displayAliases()));
  if (alias === null) return;
  if (alias.trim()) state.loraAliases[key] = alias.trim(); else delete state.loraAliases[key];
  const triggers = prompt("触发词组（每行一个；只保存在本浏览器）", wordsForLora(item).join("\n"));
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
  if (!field) return toast("没有可变填充位", "请在模板中添加或选择一个非固定字段。", "warn");
  if (field.fixed) return toast("当前字段已固定", "请选择一个非固定字段。", "warn");
  const words = selectedWordsForLora(item);
  if (!words.length) return toast("没有触发词", "可以点“中文名 / 触发词”手工补充。", "warn");
  field.value = words.join(", ");
  field.loraFile = item.file;
  saveState();
  renderTemplates();
  toast("已填入模板", `${activeTemplate().name} / ${field.name}`, "success");
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
  loraRoot.replaceChildren(el("div", "pwb-empty-inline", `LoRA 数据已准备好，正在生成 ${loraItems.length} 条完整目录…`));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (targetRoot !== loraRoot || !targetRoot.isConnected) return;
  if (loraModelSelect) {
    const models = [...new Set(loraItems.map((item) => loraBaseModel(item)))].sort((a, b) => a.localeCompare(b));
    const signature = models.join("\n");
    if (loraModelSelect.dataset.signature !== signature) {
      const selected = loraModelSelect.value;
      loraModelSelect.innerHTML = "";
      loraModelSelect.append(new Option(t("全部模型"), ""));
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
    loraRoot.replaceChildren(el("div", "pwb-empty-inline", loraItems.length ? "没有匹配的 LoRA。" : "没有读取到 LoRA 数据。"));
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
  renderTarget.append(el("div", "pwb-hint", `已完整加载 ${orderedEntries.length} 个人物或 LoRA；详情在展开时生成。`));
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
            ? `${characterCount} 个 LoRA，已按同一人物合并`
            : splitFromMultiCharacterLora
              ? "来自多人 LoRA，已按人物拆分"
              : "1 个 LoRA，已作为人物卡归档")
        );
        const variants = [...new Set(characterEntries.map((candidate) => candidate.item.sourceLabel || translatedLoraName(candidate.item.file, displayAliases())))];
        const mergedBody = el("div", "pwb-character-merged-body");
        merged.append(mergedHead);
        if (variants.length) {
          const variantList = el("div", "pwb-character-merged-variants");
          variantList.append(el("span", "pwb-muted", "版本"));
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
        el("span", "pwb-muted", `${entry.groups.length} 个分组${selectedGroupCount ? ` · 已选 ${selectedGroupCount}` : ""}`)
      );
      if (batchSelected) summary.append(el("span", "pwb-group-batch-state", "已加入群体"));
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
      el("span", `pwb-lora-model${baseModel === "未知模型" ? " unknown" : ""}`, `对应模型：${baseModel}`)
    );
    if (item.notes) names.append(el("span", "pwb-lora-note", item.notes));
    head.append(names, button("中文名 / 触发词", () => editLora(item), "subtle"));
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
        if (isInBatch) groupText.append(el("span", "pwb-group-batch-state", `群体中${batchEntries.length > 1 ? ` ×${batchEntries.length}` : ""}`));
        const sourceLabel = group.sourceLabel || item.sourceLabel || translatedLoraName(item.file, displayAliases());
        const sourceNote = mergedCharacter && !String(group.note || "").includes(sourceLabel) ? `版本来源：${sourceLabel}` : "";
        if (group.note || sourceNote) groupText.append(el("span", "pwb-lora-group-note", [group.note, sourceNote].filter(Boolean).join("；")));
        const groupEditActions = el("div", "pwb-actions compact");
        if (group.words.length) groupEditActions.append(button(isGroupSelected ? "\u2713 \u5df2\u9009" : "\u9009\u62e9", (event) => toggleLoraGroupSelection(item, group, event.currentTarget), isGroupSelected ? "primary" : "subtle"));
        groupEditActions.append(button("\u7f16\u8f91", () => editLoraGroup(item, group), "subtle"));
        if (group.id !== "missing") groupEditActions.append(button("\u5220\u9664\u7ec4", () => deleteLoraGroup(item, group), "subtle danger"));
        groupHead.append(groupText, groupEditActions);
        const preview = el("div", "pwb-lora-group-preview", group.words.length ? group.words.join(", ") : "\u6682\u65e0\u89e6\u53d1\u8bcd");
        preview.title = group.words.join(", ");
        const groupActions = el("div", "pwb-actions compact");
        if (group.words.length) {
          groupActions.append(
            button("\u52a0\u5165\u4e0a\u65b9", () => addSelection("lora", `${translatedLoraName(item.file, displayAliases())} / ${group.name}`, group.words.join(", "), { loraFile: item.file }), "primary"),
            button("\u586b\u5165\u5f53\u524d\u5b57\u6bb5", () => {
              const field = activeTemplateField();
              if (!field || field.fixed) return toast("\u6ca1\u6709\u53ef\u586b\u5145\u5b57\u6bb5", "\u8bf7\u9009\u62e9\u4e00\u4e2a\u975e\u56fa\u5b9a\u5b57\u6bb5\u3002", "warn");
              field.value = group.words.join(", ");
              field.loraFile = item.file;
              saveState();
              renderTemplates();
            }),
            isInBatch
              ? button("从群体取消", (event) => removeBatchLoraGroup(item, group, event.currentTarget), "danger")
              : button("\u52a0\u5165\u7fa4\u4f53", (event) => addBatchLoraGroup(item, group, event.currentTarget))
          );
        }
        groupCard.append(groupHead, preview, groupActions);
        groupList.append(groupCard);
      }
      if (selectedGroups.length) {
        const combinedActions = el("div", "pwb-lora-combined-actions");
        combinedActions.append(
          el("strong", "", `\u5df2\u9009 ${selectedGroups.length} \u7ec4\uff1a${selectedGroups.map((group) => group.name).join(" + ")}`),
          button("\u7ec4\u5408\u52a0\u5165\u4e0a\u65b9", () => addCombinedGroupsAbove(item, selectedGroups), "primary"),
          button("\u7ec4\u5408\u586b\u5165\u5f53\u524d\u5b57\u6bb5", () => fillTemplateFromGroups(item, selectedGroups)),
          button("\u7ec4\u5408\u52a0\u5165\u7fa4\u4f53", (event) => addBatchLoraCombination(item, selectedGroups, event.currentTarget))
        );
        groupList.append(combinedActions);
      }
      groupList.append(button("\uff0b \u65b0\u5efa\u89e6\u53d1\u8bcd\u5206\u7ec4", () => addLoraGroup(item), "subtle"));
      card.append(groupList);
    } else {
    const chips = el("div", "pwb-library-chips");
    if (words.length) words.forEach((word) => {
      const chip = el("span", `pwb-word-chip ${selectedSet.has(word) ? "selected" : "unselected"}`);
      const choose = button(`${selectedSet.has(word) ? "✓ " : ""}${word}`, () => toggleLoraWord(item, word), "word-toggle");
      choose.title = selectedSet.has(word) ? "已选择；点击取消" : "未选择；点击加入";
      const remove = button("×", () => deleteLoraWord(item, word), "word-delete danger");
      remove.title = "直接删除这个触发词";
      chip.append(choose, remove);
      chips.append(chip);
    });
    else chips.append(el("span", "pwb-muted", "暂无触发词，可手工补充"));
    card.append(chips);
    const wordActions = el("div", "pwb-actions compact pwb-word-actions");
    wordActions.append(
      button("全选", () => setSelectedLoraWords(item, words), "subtle"),
      button("清空选择", () => setSelectedLoraWords(item, []), "subtle"),
      button("＋追加", () => addLoraWords(item), "subtle"),
    );
    if (Object.hasOwn(state.loraTriggers, key)) wordActions.append(button("恢复原始", () => restoreLoraWords(item), "subtle"));
    card.append(wordActions);
    }
    const actions = el("div", "pwb-actions wrap");
    if (!groups.length) actions.append(
      button("\u6240\u9009\u8bcd\u52a0\u5165\u4e0a\u65b9", () => addSelection("lora", translatedLoraName(item.file, displayAliases()), selectedWords.join(", "), { loraFile: item.file }), "primary"),
      button("\u586b\u5165\u6a21\u677f\u5f53\u524d\u5b57\u6bb5", () => fillTemplateFromLora(item))
    );
    actions.append(button(templateFixed ? "\u79fb\u51fa\u5f53\u524d\u6a21\u677f\u56fa\u5b9a" : "\u8bbe\u4e3a\u5f53\u524d\u6a21\u677f\u56fa\u5b9a", () => toggleTemplateFixedLora(item), templateFixed ? "fixed-selected" : ""));
    actions.append(button("\u5220\u9664 LoRA", () => deleteLoraFile(item), "danger"));
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
    entries.push({ label: `手工人物 ${index + 1}`, character: `手工人物 ${index + 1}`, text });
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
  const suggested = `群体方案 ${state.batchPresets.length + 1}`;
  const name = prompt("保存群体工作流名称", suggested)?.trim();
  if (!name) return;
  const existing = state.batchPresets.find((preset) => preset.name === name);
  if (existing && !confirm(`已存在“${name}”，要用当前选择覆盖吗？`)) return;
  const payload = { ...(existing || { id: uid(), createdAt: Date.now() }), ...currentBatchPresetData(), name, updatedAt: Date.now() };
  if (existing) state.batchPresets[state.batchPresets.indexOf(existing)] = payload;
  else state.batchPresets.push(payload);
  saveState();
  renderBatchPanel();
  toast("群体工作流已保存", `${name} · ${payload.loraEntries.length} 个 LoRA 选择`, "success");
}

function loadBatchPreset(presetId) {
  const preset = state.batchPresets.find((candidate) => candidate.id === presetId);
  if (!preset) return toast("找不到群体方案", "该方案可能已被删除。", "warn");
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
  toast("已载入群体工作流", `${preset.name} · ${state.batchLoraEntries.length} 个 LoRA 选择`, "success");
}

function deleteBatchPreset(presetId) {
  const preset = state.batchPresets.find((candidate) => candidate.id === presetId);
  if (!preset || !confirm(`删除已保存的群体工作流“${preset.name}”？`)) return;
  state.batchPresets = state.batchPresets.filter((candidate) => candidate.id !== presetId);
  saveState();
  renderBatchPanel();
}

function clearCurrentBatchSelection() {
  if ((state.batchLoraEntries.length || state.batchManualText.trim()) && !confirm("清空当前群体选择？已保存的群体工作流不会受影响。")) return;
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
  if (!target) throw new Error("先在画布上选中要替换文字的 CLIP / 提示词节点。");
  const templates = plan.templates;
  const entries = plan.entries;
  const loraEntries = entries.filter((entry) => entry.loraFile);
  const loraTargets = batchLoraTargets(entries, plan.changeLora);
  if (plan.changeLora && loraEntries.length && !loraTargets.length) throw new Error("请在画布上同时选中提示词节点和要自动切换的 LoRA 加载节点。");
  const fixedLoraCount = Math.max(0, ...templates.map((template) => (template.fixedLoraFiles || []).length));
  const fixedLoraPlan = batchFixedLoraTargets(templates, loraTargets);
  const fixedLoraTargets = fixedLoraPlan.targets;
  if (fixedLoraPlan.assignedCount < fixedLoraCount) throw new Error(`固定 LoRA 节点不足：还需选中 ${fixedLoraCount - fixedLoraPlan.assignedCount} 个兼容节点。`);
  return { target, loraTargets, fixedLoraTargets };
}

async function lightweightQueueRemaining() {
  const response = await api.fetchApi("/prompt", { cache: "no-store" });
  if (!response.ok) throw new Error(`读取队列容量失败（HTTP ${response.status}）`);
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
      control.textContent = `稳定投喂 ${queued} / ${total} · 队列 ${remaining}`;
    }
    await new Promise((resolve) => setTimeout(resolve, BATCH_QUEUE_POLL_MS));
  }
}

function pauseBatchSubmission() {
  if (!batchQueueRunning) return toast("当前没有正在投喂的群体任务", "开始群体工作流后可在这里暂停。", "warn");
  batchPauseRequested = true;
  batchRunProgress.paused = true;
  persistBatchRunProgress();
  const control = document.querySelector(".pwb-batch-pause");
  if (control) {
    control.disabled = true;
    control.textContent = "正在暂停…";
  }
  toast("正在暂停群体工作流", "将停止提交新任务；已经进入 ComfyUI 队列的任务仍会完成。", "success");
}

async function submitBatchJobIndexes(plan, indexes, { firstAtFront = false } = {}) {
  if (batchQueueRunning) return toast("群体任务正在提交", "请等待当前批次提交完成。", "warn");
  let execution;
  try {
    execution = prepareBatchExecution(plan);
  } catch (error) {
    return toast("无法继续群体任务", error.message, "warn");
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
      if (control) control.textContent = `正在提交 ${queued + 1} / ${indexes.length}`;
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
    if (paused) toast("群体工作流已暂停", `本次已提交 ${queued} 项；断点和完整方案仍保留，可稍后继续。`, "success");
    else toast(firstAtFront ? "群体工作流已续接" : "群体工作流已加入队列", `${queued} 个缺失任务已提交；已在运行或排队的任务不会重复。`, "success");
    if (activeTab === "queue") renderQueue();
  } catch (error) {
    batchRunProgress.status = "interrupted";
    batchRunProgress.lastError = error.message;
    persistBatchRunProgress();
    toast("批量入队中断", `已加入 ${queued} 项；${error.message}`, "error");
  } finally {
    batchQueueRunning = false;
    batchPauseRequested = false;
    if (control?.isConnected) {
      control.disabled = false;
      control.textContent = oldControlLabel;
    }
    if (pauseControl?.isConnected) {
      pauseControl.disabled = true;
      pauseControl.textContent = "暂停投喂";
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
  if (batchQueueRunning) return toast("群体任务正在提交", "请等待当前批次提交完成。", "warn");
  const templates = batchTemplates();
  const entries = batchEntries();
  if (!templates.length) return toast("没有选择模板", "请至少勾选一个模板。", "warn");
  if (!entries.length) return toast("没有人物提示词", "从 LoRA 库加入人物，或每行填写一个手工提示词。", "warn");
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
    return toast("无法开始群体任务", error.message, "warn");
  }
  const total = batchRunJobCount(plan);
  if (total > 200 && !confirm(`即将提交 ${total} 个任务。提交过程会分批进行，确定继续吗？`)) return;
  if (validBatchRun() && batchRunProgress.status !== "completed" && !confirm("存在尚可继续的上次群体任务。开始新批次会替换它的继续记录，确定吗？")) return;
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
  if (!response.ok) throw new Error(`读取队列失败（HTTP ${response.status}）`);
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
  if (!validBatchRun()) return toast("没有可继续的群体任务", "请先开始一次群体工作流。", "warn");
  if (batchQueueRunning) return toast("群体任务正在提交", "请等待当前批次提交完成。", "warn");
  const control = document.querySelector(".pwb-batch-resume");
  const oldLabel = control?.textContent;
  if (control) {
    control.disabled = true;
    control.textContent = "正在核对队列…";
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
      return toast(completed === batchRunJobCount() ? "群体任务已经完成" : "群体任务仍在继续", completed === batchRunJobCount() ? "没有遗漏的任务。" : `${active} 项仍在运行或排队，无需重复提交。`, "success");
    }
    const firstJob = batchRunJobAt(batchRunPlan, missing[0]);
    const firstName = firstJob.entry.character || firstJob.entry.label;
    const message = `检测到：已完成 ${completed} 项、仍在运行/排队 ${active} 项、缺失或中断 ${missing.length} 项。\n\n将从“${firstName} / ${firstJob.template.name}”续接；第一项插到队首，其余只补缺失，不重复现有队列。确定继续吗？`;
    if (!confirm(message)) return;
    await submitBatchJobIndexes(batchRunPlan, missing, { firstAtFront: true });
  } catch (error) {
    toast("检查上次群体任务失败", error.message, "error");
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
  if (!templates.length || !entries.length) throw new Error("请保留上次使用的模板和人物选择。");
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
    toast("无法建立继续记录", error.message, "warn");
  }
}

async function resumeCurrentBatchFromPosition(position) {
  try {
    const requested = Number(position);
    if (!Number.isInteger(requested) || requested < 1) throw new Error("请输入有效的任务序号，例如 190。");
    const total = batchTemplates().length * batchEntries().length;
    if (!total) throw new Error("请保留上次使用的模板和人物选择。");
    if (requested > total) throw new Error(`当前组合一共只有 ${total} 项。`);
    const plan = createCurrentBatchRun(requested - 1);
    if (!confirm(`将跳过前 ${requested - 1} 项，直接从第 ${requested} / ${total} 项开始，并依次提交到最后。确定吗？`)) return;
    const indexes = Array.from({ length: total - requested + 1 }, (_, offset) => requested - 1 + offset);
    await submitBatchJobIndexes(plan, indexes, { firstAtFront: true });
  } catch (error) {
    toast("无法从指定序号继续", error.message, "warn");
  }
}

function renderBatchPanel() {
  if (!batchRoot) return;
  batchRoot.innerHTML = "";
  const presetBox = el("div", "pwb-batch-preset-box");
  const presetSelect = el("select", "pwb-select pwb-batch-preset-select");
  if (state.batchPresets.length) {
    for (const preset of state.batchPresets) {
      const option = el("option", "", `${preset.name}（${(preset.loraEntries || []).length} 项）`);
      option.value = preset.id;
      presetSelect.append(option);
    }
  } else {
    const option = el("option", "", "尚无已保存方案");
    option.value = "";
    presetSelect.append(option);
  }
  const loadPreset = button("载入", () => loadBatchPreset(presetSelect.value), "primary");
  const deletePreset = button("删除", () => deleteBatchPreset(presetSelect.value), "subtle danger");
  loadPreset.disabled = deletePreset.disabled = !state.batchPresets.length;
  const presetActions = el("div", "pwb-batch-preset-actions");
  presetActions.append(loadPreset, button("保存当前", saveCurrentBatchPreset), button("清空当前", clearCurrentBatchSelection, "subtle"), deletePreset);
  presetBox.append(el("div", "pwb-batch-resume-title", "已保存的群体工作流"), presetSelect, presetActions, el("div", "pwb-hint", "保存会记录模板、人物/服装组合、手工提示词和 LoRA 自动切换设置。可先保存 1/2/3，再清空当前去处理 4，之后一键载回。"));
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
    label.append(checkbox, el("span", "", `${template.name} → ${fillField?.name || "无可变字段"}`));
    templateList.append(label);
  }
  const manual = el("textarea", "pwb-output pwb-batch-manual");
  manual.value = state.batchManualText;
  manual.placeholder = t("也可每行填写一个人物/替换提示词，例如：\ncharacter A\ncharacter B");
  manual.addEventListener("input", () => {
    state.batchManualText = manual.value;
    saveState();
    updateSummary();
  });
  const selectedLoras = el("div", "pwb-batch-selected");
  const renderSelected = () => {
    selectedLoras.innerHTML = "";
    const hiddenCount = Math.max(0, state.batchLoraEntries.length - BATCH_SELECTION_PREVIEW_LIMIT);
    if (hiddenCount) selectedLoras.append(el("div", "pwb-hint", `为保持页面稳定，前 ${hiddenCount} 项已折叠；下方显示最近 ${BATCH_SELECTION_PREVIEW_LIMIT} 项。完整群体数据仍会参与任务。`));
    for (const selected of state.batchLoraEntries.slice(-BATCH_SELECTION_PREVIEW_LIMIT)) {
      const key = normalizeLoraKey(selected.key);
      const item = loraItems.find((candidate) => normalizeLoraKey(candidate.file) === key);
      const availableGroups = item ? groupsForLora(item) : [];
      const wantedIds = selected.groupIds?.length ? selected.groupIds : [selected.groupId].filter(Boolean);
      const groups = wantedIds.map((id) => availableGroups.find((candidate) => candidate.id === id)).filter(Boolean);
      const label = item ? `${translatedLoraName(item.file, displayAliases())} / ${groups.map((group) => group.name).join(" + ") || selected.label || "\u9ed8\u8ba4\u7ec4"}` : key;
      const chip = el("div", "pwb-batch-entry");
      const remove = button("移除", () => {
        state.batchLoraEntries = state.batchLoraEntries.filter((entry) => entry.id !== selected.id);
        saveState();
        renderBatchPanel();
        renderLoraLibrary();
      }, "subtle danger");
      chip.append(el("span", "pwb-batch-entry-label", label), remove);
      selectedLoras.append(chip);
    }
    if (!state.batchLoraEntries.length) selectedLoras.append(el("span", "pwb-muted", "尚未从下方 LoRA 库选择人物。"));
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
  switchLabel.append(switchLora, el("span", "", "每个人物自动切换对应的 LoRA 模型"));
  let resumeBox;
  if (validBatchRun()) {
    const total = batchRunJobCount();
    const submitted = Object.values(batchRunProgress.jobs || {}).filter((job) => job?.promptId).length;
    const statusLabels = {
      ready: "等待提交",
      submitting: "提交时断开",
      feeding: "稳定投喂中",
      interrupted: "提交已中断",
      paused: "已暂停投喂",
      queued: "已提交，等待核对",
      executing: "正在执行",
      completed: "已全部完成",
    };
    resumeBox = el("div", "pwb-batch-resume-box");
    const created = batchRunPlan.createdAt ? new Date(batchRunPlan.createdAt).toLocaleString() : "时间未知";
    const resumeIndex = Math.max(0, Math.min(total, Number(batchRunProgress.resumeIndex || 0)));
    const position = batchRunProgress.status === "completed" ? total : Math.min(total, resumeIndex + 1);
    resumeBox.append(
      el("div", "pwb-batch-resume-title", "上次群体任务"),
      el("div", "pwb-hint", `${created} · ${statusLabels[batchRunProgress.status] || "可核对"} ${position} / ${total} · 已记录 ${submitted} 个任务 ID`),
    );
    if (batchRunProgress.lastError) resumeBox.append(el("div", "pwb-batch-resume-error", batchRunProgress.lastError));
    const actions = el("div", "pwb-batch-resume-actions");
    actions.append(
      button(batchRunProgress.status === "completed" ? "核对上次群体任务" : `继续上次群体任务（从 ${position}）`, resumeBatchRun, "primary pwb-batch-resume"),
      button("清除记录", () => {
        if (confirm("只清除工作台的继续记录，不会取消 ComfyUI 中正在运行或排队的任务。确定吗？")) clearBatchRun();
      }, "subtle danger"),
    );
    resumeBox.append(actions);
  } else {
    resumeBox = el("div", "pwb-batch-resume-box");
    const positionInput = el("input", "pwb-input pwb-batch-position-input");
    positionInput.type = "number";
    positionInput.min = "1";
    positionInput.step = "1";
    positionInput.placeholder = t("中断序号，例如 190");
    const specifiedActions = el("div", "pwb-batch-resume-actions");
    specifiedActions.append(positionInput, button("从该序号继续", () => resumeCurrentBatchFromPosition(positionInput.value), "primary"));
    resumeBox.append(
      el("div", "pwb-batch-resume-title", "任务中断续接"),
      el("div", "pwb-hint", "保留原来的模板、人物及画布节点选择。队列仍在时可自动识别；若已经重启导致队列消失，可直接填写中断序号。"),
      button("从当前队列继续", adoptCurrentBatchRun, "primary pwb-batch-resume"),
      specifiedActions,
    );
  }
  function updateSummary() {
    const templates = batchTemplates().length;
    const entries = batchEntries().length;
    summary.textContent = currentLocale() === 'en'
      ? `${templates} templates × ${entries} characters = ${templates * entries} tasks`
      : `${templates} 个模板 × ${entries} 个人物 = ${templates * entries} 个队列任务`;
  }
  batchRoot.append(presetBox, el("div", "pwb-label", "选择模板（箭头后是该模板的替换字段）"), templateList, el("div", "pwb-label", "已选 LoRA 人物"), selectedLoras, manual, switchLabel, el("div", "pwb-hint", "自动切换时，请同时选中提示词节点、人物 LoRA 节点和所有可用的固定 LoRA 节点。人物节点优先按标题中的“人物/角色/character”识别；固定节点按节点 ID 从小到大对应模板内顺序。每项任务只启用当前模板需要的数量，多余节点自动旁路；后续模板需要时会自动重新启用。"));
  if (resumeBox) batchRoot.append(resumeBox);
  const runActions = el("div", "pwb-batch-run-actions");
  const pauseButton = button(batchPauseRequested ? "正在暂停…" : "暂停投喂", pauseBatchSubmission, "pwb-batch-pause");
  pauseButton.disabled = !batchQueueRunning || batchPauseRequested;
  const startButton = button("一键开始群体工作流", queueBatch, "primary pwb-batch-run");
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
    block.append(el("div", "pwb-prompt-label", `${entry.type} · 节点 ${entry.id} · 内容 ${entry.index + 1}`));
    const content = el("div", "pwb-prompt-text", entry.text);
    content.title = "点击复制";
    content.addEventListener("click", async () => navigator.clipboard.writeText(entry.text));
    block.append(content);
    clipTextRoot.append(block);
  }
  if (!texts.length) clipTextRoot.append(el("div", "pwb-empty-inline", "当前工作流没有可读取的 CLIP 文字。载入含缺失 CLIP 节点的工作流后，原始文字会保留在这里。"));
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
    node.addDOMWidget(`原始文字 ${index + 1}`, "pwb-missing-clip-text", area, { serialize: false });
  }
  node.setSize?.([Math.max(node.size?.[0] || 260, 300), Math.max(node.size?.[1] || 120, 220)]);
}

function buildPromptWorkbench(root, { renderLoras = true } = {}) {
  root.innerHTML = "";
  const archiveSection = el("section", "pwb-section pwb-character-archive");
  const archiveHeading = el("div", "pwb-section-heading");
  archiveHeading.append(el("h3", "pwb-section-title", "输出资产人物归档"));
  const archiveToggle = el("label", "pwb-fixed-label");
  const archiveCheckbox = el("input", "");
  archiveCheckbox.type = "checkbox";
  archiveCheckbox.checked = state.autoCharacterFolders;
  archiveCheckbox.addEventListener("change", () => {
    state.autoCharacterFolders = archiveCheckbox.checked;
    saveState();
  });
  archiveToggle.append(archiveCheckbox, document.createTextNode(t("以后自动分类")));
  archiveHeading.append(archiveToggle);
  archiveSection.append(
    archiveHeading,
    el("div", "pwb-hint", "按人物身份建立目录，同一人物的不同 LoRA 和服装会合并；多人物 LoRA 按实际选中的人物触发组拆分。无法可靠判断的资产进入“_未识别人物”。"),
    button("整理现有 output", organizeExistingOutput, "primary pwb-organize-output")
  );
  root.append(archiveSection);

  const selectedSection = el("section", "pwb-section");
  const selectedHeading = el("div", "pwb-section-heading");
  selectedHeading.append(el("h3", "pwb-section-title", "已选择的完整内容"), button("清空", () => {
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
  separatorRow.append(el("span", "pwb-muted", "块之间分隔符"), separator);
  const actions = el("div", "pwb-actions wrap");
  actions.append(button("复制", async () => { await navigator.clipboard.writeText(assembledText()); toast("已复制", "完整提示词已复制。", "success"); }), button("写入选中节点", writeToSelectedNode, "primary"));
  selectedSection.append(selectedHeading, selectionsRoot, el("label", "pwb-label", "最终输出"), outputArea, separatorRow, actions);
  root.append(selectedSection);

  const manualSection = el("section", "pwb-section");
  manualSection.append(el("h3", "pwb-section-title", "手工完整提示词"));
  const manual = el("textarea", "pwb-output pwb-manual");
  manual.placeholder = t("在这里填写一段完整提示词；加入后会作为一个整体显示在上方。");
  manualSection.append(manual, button("作为完整提示词加入", () => {
    addSelection("prompt", "手工提示词", manual.value);
    if (manual.value.trim()) manual.value = "";
  }, "primary"));
  root.append(manualSection);

  const templateSection = el("section", "pwb-section");
  templateSection.append(el("h3", "pwb-section-title", "可命名模板"));
  templateRoot = el("div", "pwb-template-editor");
  templateSection.append(templateRoot);
  root.append(templateSection);

  const batchSection = el("section", "pwb-section");
  batchSection.append(el("h3", "pwb-section-title", "群体工作流"), el("div", "pwb-hint", "先在画布选中提示词节点、人物 LoRA 节点及所需数量的固定 LoRA 节点。支持一个人物跑多个模板、一个模板跑多个人物；两边多选时会生成全部组合。队列会逐项执行。"));
  batchRoot = el("div", "pwb-batch");
  batchSection.append(batchRoot);
  root.append(batchSection);

  const clipSection = el("section", "pwb-section");
  clipSection.append(el("h3", "pwb-section-title", "CLIP 节点原始文字"), el("div", "pwb-hint", "即使当前版本缺少对应 CLIP 节点，也从工作流原始数据中显示文字；这不代表缺失节点可以执行。"));
  clipTextRoot = el("div", "pwb-clip-texts");
  clipSection.append(clipTextRoot);
  root.append(clipSection);

  const loraSection = el("section", "pwb-section");
  const loraHeading = el("div", "pwb-section-heading");
  loraHeading.append(el("h3", "pwb-section-title", "LoRA 中文库"));
  const refreshLoras = button("\u5237\u65b0 LoRA", async () => {
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
      toast("LoRA \u5df2\u5237\u65b0", `\u5f53\u524d ${loraItems.length} \u4e2a\u6587\u4ef6`, "success");
    } finally {
      refreshLoras.disabled = false;
    }
  }, "subtle");
  const currentOnly = el("label", "pwb-fixed-label");
  const checkbox = el("input", "");
  checkbox.type = "checkbox";
  checkbox.checked = workflowOnly;
  checkbox.addEventListener("change", () => { workflowOnly = checkbox.checked; renderLoraLibrary(); });
  currentOnly.append(checkbox, document.createTextNode("只看当前工作流"));
  loraHeading.append(refreshLoras, currentOnly);
  loraSearch = el("input", "pwb-input");
  loraSearch.placeholder = t("可用中文、英文、文件名或触发词搜索…");
  loraSearch.addEventListener("input", () => {
    clearTimeout(loraSearchTimer);
    loraSearchTimer = setTimeout(renderLoraLibrary, 180);
  });
  loraModelSelect = el("select", "pwb-input pwb-model-filter");
  loraModelSelect.title = "按 LoRA 对应的基础模型筛选";
  loraModelSelect.append(new Option("全部模型", ""));
  loraModelSelect.addEventListener("change", renderLoraLibrary);
  const loraFilters = el("div", "pwb-lora-filters");
  loraFilters.append(loraSearch, loraModelSelect);
  loraRoot = el("div", "pwb-lora-list merged");
  loraSection.append(loraHeading, loraFilters, el("div", "pwb-hint", "中文仅用于显示和搜索，工作流仍保存原始 LoRA 文件名。可按底模筛选，并为任意 LoRA 自定义中文别名。"), loraRoot);
  root.append(loraSection);

  const sectionLinks = [
    [archiveSection, "归档", "自动整理输出"],
    [selectedSection, "组合", "整理最终提示词"],
    [manualSection, "手工", "加入完整提示词"],
    [templateSection, "模板", "管理可变字段"],
    [batchSection, "群体", "批量生成组合"],
    [clipSection, "CLIP", "查看节点原文"],
    [loraSection, "LoRA", "浏览人物与服装"],
  ];
  const hero = el("header", "pwb-workbench-hero");
  const heroText = el("div", "pwb-workbench-hero-text");
  heroText.append(
    el("span", "pwb-eyebrow", "PROMPT CONTROL CENTER"),
    el("h2", "pwb-workbench-title", "提示词工作台"),
    el("p", "pwb-workbench-subtitle", "组合提示词、管理人物 LoRA，并批量运行模板。")
  );
  hero.append(heroText, el("span", "pwb-workbench-status", "已连接"));
  const nav = el("nav", "pwb-section-nav");
  nav.setAttribute("aria-label", t("工作台功能区"));
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
  loraRoot.replaceChildren(el("div", "pwb-hint", currentLocale() === 'en' ? 'Loading LoRA library…' : '正在读取 LoRA 库…'));
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
  brandText.append(el("strong", "", "Prompt Workbench"), el("span", "", "任务与提示词控制台"));
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
  const queueTab = button("任务队列", () => switchTab("queue"), "tab");
  queueTab.dataset.tab = "queue";
  const promptTab = button("提示词 / LoRA", () => switchTab("prompt"), "tab");
  promptTab.dataset.tab = "prompt";
  tabs.append(queueTab, promptTab);
  shellHeader.append(brand, tabs);
  const settings = el('div', 'pwb-settings');
  const language = el('select', 'pwb-input');
  language.setAttribute('aria-label', t('语言'));
  for (const [value, name] of [['zh-CN', '简体中文'], ['en', 'English']]) language.append(new Option(name, value));
  language.value = currentLocale();
  language.addEventListener('change', () => {
    if (batchQueueRunning) {
      language.value = currentLocale();
      return toast('群体任务正在提交', '请等待当前批次提交完成。', 'warn');
    }
    storage.setItem(LOCALE_KEY, language.value);
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
      if (!confirm('导入备份将替换当前模板与选择，继续吗？')) return;
      downloadBackup(state);
      if (!storage.setItem(STORAGE_KEY, JSON.stringify(incoming))) throw new Error('Browser storage is unavailable.');
      state = loadState();
      activeTemplateId = state.templates[0]?.id;
      activeFieldId = templateFillField(state.templates[0])?.id;
      buildSidebar(root);
    } catch (error) { toast('导入失败', error.message, 'error'); }
    importFile.value = '';
  });
  settings.append(language, button('导出备份', () => downloadBackup(state)), button('导入备份', () => {
    if (batchQueueRunning) return toast('群体任务正在提交', '请等待当前批次提交完成。', 'warn');
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
  handle.title = "\u62d6\u62fd\u8c03\u6574\u5de5\u4f5c\u53f0\u5bbd\u5ea6\uff1b\u53cc\u51fb\u6062\u590d\u9ed8\u8ba4";
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
  init() {
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
      title: t("提示词工作台"),
      tooltip: "队列透视、可变模板、LoRA 中文浏览与完整提示词组合",
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
