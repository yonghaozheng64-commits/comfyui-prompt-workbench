import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as batch from '../web/batch.js';

function harness() {
  const initial = { templates: [], batchPresets: [], batchLoraEntries: [], batchTemplateIds: [], batchManualText: '', batchChangeLora: true, separator: ', ' };
  const widget = { value: 'original' };
  const target = { widget, node: {} };
  const context = vm.createContext({
    ...batch, loadState: () => initial, clone: structuredClone, uid: () => 'test-id',
    storage: { getItem: () => null, setItem: () => true, removeItem() {} },
    t: x => x, prompt: () => 'saved', confirm: () => true, LOCALE_KEY: 'locale', currentLocale: () => 'en',
    window: { addEventListener() {} }, document: { querySelector: () => null },
    app: { registerExtension() {}, canvas: {}, graphToPrompt: async () => ({ workflow: {} }) },
    api: { queuePrompt: async () => ({ prompt_id: 'p1' }) },
    console, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  });
  const source = fs.readFileSync(new URL('../web/prompt_workbench.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', '"file:///test.js"');
  vm.runInContext(source + '\nglobalThis.subject = { submitBatchJobIndexes, pauseBatchSubmission, trackBatchExecution, currentBatchPresetData, saveCurrentBatchPreset, loadBatchPreset };', context);
  context.target = target;
  vm.runInContext(`
    prepareBatchExecution = () => ({ target, loraTargets: [], fixedLoraTargets: [] });
    runWidgetQueueCallbacks = () => {};
    renderBatchPanel = () => {};
    renderTemplates = () => {};
    renderLoraLibrary = () => {};
    toast = () => {};
    batchRunPlan = { id: 'run', templates: [{ name: 'T', fields: [{ id: 'c', value: '' }] }], entries: [{ text: 'A' }, { text: 'B' }] };
    batchRunProgress = { runId: 'run', jobs: {}, resumeIndex: 0 };
    globalThis.readProgress = () => batchRunProgress;
    globalThis.plan = batchRunPlan;
  `, context);
  return { context, widget, subject: context.subject };
}

test('pause during queue-capacity request stops all new submissions', async () => {
  const { context, widget, subject } = harness();
  let submissions = 0;
  context.api.queuePrompt = async () => { submissions++; return {}; };
  context.api.fetchApi = async () => {
    subject.pauseBatchSubmission();
    return { ok: true, json: async () => ({ exec_info: { queue_remaining: 0 } }) };
  };
  await subject.submitBatchJobIndexes(context.plan, [0, 1]);
  assert.equal(submissions, 0);
  assert.equal(context.readProgress().status, 'paused');
  assert.equal(widget.value, 'original');
});

test('execution success does not overwrite a paused batch', () => {
  const { context, subject } = harness();
  Object.assign(context.readProgress(), { paused: true, jobs: { '0': { promptId: 'p1' } } });
  subject.trackBatchExecution({ detail: { prompt_id: 'p1' } }, 'success');
  assert.equal(context.readProgress().status, 'paused');
  assert.equal(context.readProgress().jobs['0'].completed, true);
});

test('preset snapshots restore edited template content', () => {
  const { context, subject } = harness();
  vm.runInContext(`state.templates = [{ id: 't', name: 'T', fields: [{ id: 'c', value: 'original' }] }]; state.batchTemplateIds = ['t'];`, context);
  subject.saveCurrentBatchPreset();
  vm.runInContext(`state.templates[0].fields[0].value = 'changed';`, context);
  subject.loadBatchPreset('test-id');
  assert.equal(vm.runInContext('state.templates[0].fields[0].value', context), 'original');
});
