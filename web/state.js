import { storage } from './storage.js';
const STORAGE_KEY = 'prompt-workbench-state-v2';
const OLD_STORAGE_KEY = 'prompt-workbench-state-v1';

export const DEFAULT_TEMPLATES = [
  {
    id: "portrait",
    name: "人物肖像",
    fields: [
      { id: "quality", name: "质量", value: "masterpiece, best quality, highly detailed", fixed: true },
      { id: "character", name: "人物 / LoRA", value: "", fixed: false },
      { id: "appearance", name: "外貌与服装", value: "", fixed: false },
      { id: "action", name: "动作与表情", value: "", fixed: false },
      { id: "scene", name: "场景", value: "", fixed: false },
      { id: "lighting", name: "光线", value: "cinematic lighting", fixed: true },
    ],
  },
  {
    id: "scene",
    name: "场景概念图",
    fields: [
      { id: "quality", name: "质量", value: "highly detailed, cinematic composition", fixed: true },
      { id: "subject", name: "核心场景", value: "", fixed: false },
      { id: "environment", name: "环境细节", value: "", fixed: false },
      { id: "weather", name: "时间与天气", value: "", fixed: false },
      { id: "style", name: "风格 / LoRA", value: "", fixed: false },
    ],
  },
  {
    id: "video",
    name: "视频镜头",
    fields: [
      { id: "quality", name: "稳定性", value: "smooth motion, temporal consistency, stable details", fixed: true },
      { id: "subject", name: "主体 / LoRA", value: "", fixed: false },
      { id: "action", name: "动作过程", value: "", fixed: false },
      { id: "camera", name: "机位与运镜", value: "", fixed: false },
      { id: "atmosphere", name: "光线与氛围", value: "", fixed: false },
    ],
  },
];

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function loadState() {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      return {
        selections: Array.isArray(saved.selections) ? saved.selections : [],
        templates: Array.isArray(saved.templates) && saved.templates.length ? saved.templates : clone(DEFAULT_TEMPLATES),
        separator: typeof saved.separator === "string" ? saved.separator : ", ",
        loraAliases: saved.loraAliases && typeof saved.loraAliases === "object" ? saved.loraAliases : {},
        loraTriggers: saved.loraTriggers && typeof saved.loraTriggers === "object" ? saved.loraTriggers : {},
        loraTriggerSelections: saved.loraTriggerSelections && typeof saved.loraTriggerSelections === "object" ? saved.loraTriggerSelections : {},
        loraGroupSelections: saved.loraGroupSelections && typeof saved.loraGroupSelections === "object" ? saved.loraGroupSelections : {},
        batchTemplateIds: Array.isArray(saved.batchTemplateIds) ? saved.batchTemplateIds : [],
        batchLoraKeys: Array.isArray(saved.batchLoraKeys) ? saved.batchLoraKeys : [],
        batchLoraEntries: Array.isArray(saved.batchLoraEntries)
          ? saved.batchLoraEntries.filter((entry) => entry && entry.key).map((entry) => ({ ...entry, id: entry.id || uid() }))
          : (Array.isArray(saved.batchLoraKeys) ? saved.batchLoraKeys.map((key) => ({ id: uid(), key })) : []),
        batchManualText: typeof saved.batchManualText === "string" ? saved.batchManualText : "",
        batchChangeLora: saved.batchChangeLora !== false,
        batchPresets: Array.isArray(saved.batchPresets) ? saved.batchPresets.filter((preset) => preset?.id && preset?.name) : [],
        autoCharacterFolders: saved.autoCharacterFolders !== false,
      };
    }
  } catch {}
  let migrated = { selections: [], templates: clone(DEFAULT_TEMPLATES), separator: ", ", loraAliases: {}, loraTriggers: {}, loraTriggerSelections: {}, loraGroupSelections: {}, batchTemplateIds: [], batchLoraKeys: [], batchLoraEntries: [], batchManualText: "", batchChangeLora: true, batchPresets: [], autoCharacterFolders: true };
  try {
    const old = JSON.parse(storage.getItem(OLD_STORAGE_KEY));
    const separator = typeof old?.separator === "string" ? old.separator : ", ";
    const oldAssembly = Array.isArray(old?.assembly) ? old.assembly.map((item) => String(item.text || "").trim()).filter(Boolean) : [];
    if (oldAssembly.length) migrated.selections.push({ id: uid(), type: "prompt", label: "旧版组合提示词", text: oldAssembly.join(separator) });
    const customFields = (Array.isArray(old?.components) ? old.components : [])
      .filter((item) => item?.source === "user" && item.text)
      .map((item) => ({ id: uid(), name: item.label || "旧版自定义内容", value: item.text, fixed: false }));
    if (customFields.length) migrated.templates.push({ id: uid(), name: "旧版自定义词库", fields: customFields });
    migrated.separator = separator;
    storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  } catch {}
  return migrated;
}
