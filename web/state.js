import { t } from './i18n.js';
import { storage } from './storage.js';
const STORAGE_KEY = 'prompt-workbench-state-v2';
const OLD_STORAGE_KEY = 'prompt-workbench-state-v1';

export const DEFAULT_TEMPLATES = [
  {
    id: "portrait",
    name: t("Character portrait"),
    fields: [
      { id: "quality", name: t("Quality"), value: "masterpiece, best quality, highly detailed", fixed: true },
      { id: "character", name: t("Character / LoRA"), value: "", fixed: false },
      { id: "appearance", name: t("Appearance and outfit"), value: "", fixed: false },
      { id: "action", name: t("Action and expression"), value: "", fixed: false },
      { id: "scene", name: t("Scene"), value: "", fixed: false },
      { id: "lighting", name: t("Lighting"), value: "cinematic lighting", fixed: true },
    ],
  },
  {
    id: "scene",
    name: t("Scene concept"),
    fields: [
      { id: "quality", name: t("Quality"), value: "highly detailed, cinematic composition", fixed: true },
      { id: "subject", name: t("Main scene"), value: "", fixed: false },
      { id: "environment", name: t("Environment details"), value: "", fixed: false },
      { id: "weather", name: t("Time and weather"), value: "", fixed: false },
      { id: "style", name: t("Style / LoRA"), value: "", fixed: false },
    ],
  },
  {
    id: "video",
    name: t("Video shot"),
    fields: [
      { id: "quality", name: t("Stability"), value: "smooth motion, temporal consistency, stable details", fixed: true },
      { id: "subject", name: t("Subject / LoRA"), value: "", fixed: false },
      { id: "action", name: t("Action sequence"), value: "", fixed: false },
      { id: "camera", name: t("Camera and movement"), value: "", fixed: false },
      { id: "atmosphere", name: t("Lighting and atmosphere"), value: "", fixed: false },
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
    if (oldAssembly.length) migrated.selections.push({ id: uid(), type: "prompt", label: t("Legacy combined prompt"), text: oldAssembly.join(separator) });
    const customFields = (Array.isArray(old?.components) ? old.components : [])
      .filter((item) => item?.source === "user" && item.text)
      .map((item) => ({ id: uid(), name: item.label || t("Legacy custom content"), value: item.text, fixed: false }));
    if (customFields.length) migrated.templates.push({ id: uid(), name: t("Legacy custom vocabulary"), fields: customFields });
    migrated.separator = separator;
    storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  } catch {}
  return migrated;
}
