export function templateFillField(template) {
  return template.fields.find((field) => field.id === template.fillFieldId && !field.fixed)
    || template.fields.find((field) => !field.fixed);
}
export function batchPrompt(template, replacement, separator = ', ') {
  const fillField = templateFillField(template);
  return template.fields.map((field) => field.id === fillField?.id ? replacement : field.value.trim())
    .filter(Boolean).join(separator);
}
export function jobCount(plan) {
  return (plan?.templates?.length || 0) * (plan?.entries?.length || 0);
}
export function jobAt(plan, index, separator) {
  const template = plan.templates[Math.floor(index / plan.entries.length)];
  const entry = plan.entries[index % plan.entries.length];
  return { template, entry, text: batchPrompt(template, entry.text, separator) };
}
