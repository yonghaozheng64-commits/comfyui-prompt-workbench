import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeI18n, currentLocale, resolveLocale, t, format, LOCALE_KEY } from '../web/i18n.js';
import { storage } from '../web/storage.js';
import { translatedLoraName } from '../web/lora_i18n.js';

const en = JSON.parse(fs.readFileSync(new URL('../locales/en/main.json', import.meta.url)));
const zh = JSON.parse(fs.readFileSync(new URL('../locales/zh/main.json', import.meta.url)));

test('standard locale catalogs have matching keys and placeholder sets', () => {
  const english = en.promptWorkbench.messages;
  const chinese = zh.promptWorkbench.messages;
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const [key, value] of Object.entries(english)) {
    assert.equal(value, key);
    assert.doesNotMatch(value, /[\u3400-\u9fff]/);
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(x => x[0]).sort();
    assert.deepEqual(placeholders(chinese[key]), placeholders(value), key);
  }
});

test('ComfyUI locale, explicit overrides, fallback and user data preservation', async () => {
  storage.removeItem(LOCALE_KEY);
  let locale = 'en';
  await initializeI18n(async path => {
    assert.equal(path, '/i18n');
    return { ok: true, json: async () => ({ en, zh }) };
  }, () => locale);
  assert.equal(currentLocale(), 'en');
  assert.equal(t('Task queue'), 'Task queue');
  locale = 'zh';
  assert.equal(currentLocale(), 'zh-CN');
  assert.equal(t('Task queue'), '任务队列');
  const privateText = '我的角色, raw_trigger, {1}';
  assert.equal(format('Template: {0}', [privateText]), '模板：' + privateText);
  assert.equal(t(privateText), privateText);
  storage.setItem(LOCALE_KEY, 'en');
  assert.equal(currentLocale(), 'en');
  assert.equal(translatedLoraName('long_hair.safetensors'), 'long_hair.safetensors');
  assert.equal(translatedLoraName('test.safetensors', { test: privateText }), privateText);
  storage.setItem(LOCALE_KEY, 'auto');
  locale = 'fr';
  assert.equal(currentLocale(), 'en');
  assert.equal(resolveLocale(undefined), 'en');
  storage.removeItem(LOCALE_KEY);
});

test('English source remains usable when the host lacks the i18n endpoint', async () => {
  await initializeI18n(async () => ({ ok: false }), () => 'en');
  assert.equal(t('Task queue'), 'Task queue');
  assert.equal(format('Node {0}', ['user text']), 'Node user text');
});

test('workbench no longer calls destructive helper routes', () => {
  const source = fs.readFileSync(new URL('../web/prompt_workbench.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /lora-trigger-helper\/(?:delete|remove|character-archive\/(?:organize|preview))/);
});
