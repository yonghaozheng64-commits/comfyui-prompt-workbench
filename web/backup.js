export function validateBackup(value) {
  if (value?.format !== 'prompt-workbench' || value.version !== 1 || !value.state || !Array.isArray(value.state.templates)) {
    throw new Error('Invalid Prompt Workbench backup (expected version 1).');
  }
  const templates = value.state.templates;
  if (!templates.length || templates.some((template) => !template.id || typeof template.name !== 'string' || !Array.isArray(template.fields)
    || template.fields.some((field) => !field.id || typeof field.value !== 'string'))) {
    throw new Error('Invalid templates in backup.');
  }
  return value.state;
}

export function downloadBackup(state) {
  const payload = { format: 'prompt-workbench', version: 1, exportedAt: new Date().toISOString(), state };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `prompt-workbench-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
