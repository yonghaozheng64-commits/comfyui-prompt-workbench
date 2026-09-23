import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../web/storage.js';
import { resolveLocale, t } from '../web/i18n.js';
import { jobAt, jobCount } from '../web/batch.js';
import { validateBackup } from '../web/backup.js';

test('disabled storage keeps the newest state instead of returning stale data', () => {
  let errors = 0;
  const disk = { getItem: () => 'old', setItem() { throw Error('quota'); }, removeItem() { throw Error('disabled'); } };
  const store = createStorage(() => disk, () => errors++);
  assert.equal(store.setItem('state', 'new'), false);
  assert.equal(store.getItem('state'), 'new');
  store.removeItem('state');
  assert.equal(store.getItem('state'), null);
  assert.equal(errors, 2);
});

test('locale matching and unknown content preserve original prompts', () => {
  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'fr-FR'), 'en');
  assert.equal(t('Save current', 'en'), 'Save current');
  assert.equal(t('my exact trigger, character X', 'en'), 'my exact trigger, character X');
});

test('batch jobs cover each pair and preserve fixed fields and separators', () => {
  const plan = { templates: [{ name: 'A', fields: [{ id: 'f', fixed: true, value: 'quality' }, { id: 'c', value: 'old' }] },
    { name: 'B', fields: [{ id: 'c', value: 'old' }] }], entries: [{ text: 'one' }, { text: 'two' }] };
  assert.equal(jobCount(plan), 4);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => jobAt(plan, i, ' | ').text), ['quality | one', 'quality | two', 'one', 'two']);
  assert.equal(plan.templates[0].fields[1].value, 'old');
});

test('invalid backups are rejected before state replacement', () => {
  assert.throws(() => validateBackup({ version: 9 }));
  assert.throws(() => validateBackup({ format: 'prompt-workbench', version: 1, state: { templates: [{ id: 'a', name: 'broken', fields: [{}] }] } }));
  const state = { templates: [{ id: 'a', name: 'A', fields: [{ id: 'f', value: 'test' }] }] };
  assert.equal(validateBackup({ format: 'prompt-workbench', version: 1, state }), state);
});
