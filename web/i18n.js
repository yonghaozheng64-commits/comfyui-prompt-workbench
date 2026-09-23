import { storage } from './storage.js';

export const LOCALE_KEY = 'prompt-workbench-locale';
let getComfyLocale = () => 'en';
let catalogs = {};

export function resolveLocale(value, comfyLocale = 'en') {
  const chosen = value === 'auto' || !value ? comfyLocale : value;
  return /^zh\b/i.test(chosen || '') ? 'zh-CN' : 'en';
}

export function currentLocale() {
  return resolveLocale(storage.getItem(LOCALE_KEY), getComfyLocale());
}

export async function initializeI18n(fetchApi, localeProvider) {
  getComfyLocale = localeProvider;
  try {
    const response = await fetchApi('/i18n');
    if (!response.ok) return;
    const data = await response.json();
    catalogs = {
      en: data.en?.promptWorkbench?.messages || {},
      'zh-CN': data.zh?.promptWorkbench?.messages || data['zh-CN']?.promptWorkbench?.messages || {},
    };
  } catch (error) {
    console.warn('Prompt Workbench: translations unavailable; using English.', error);
  }
}

export function t(text, locale = currentLocale()) {
  return typeof text === 'string' ? catalogs[locale]?.[text] ?? text : text;
}

// Substitute after translation so user prompts and filenames are never translated.
export function format(text, values, locale = currentLocale()) {
  return t(text, locale).replace(/\{(\d+)\}/g, (match, index) =>
    index < values.length ? String(values[index]) : match);
}

export const prompt = (message, value = '') => globalThis.prompt(t(message), value);
export const confirm = (message) => globalThis.confirm(t(message));
