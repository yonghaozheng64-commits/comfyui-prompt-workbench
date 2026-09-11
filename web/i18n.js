import { storage } from './storage.js';

export const LOCALE_KEY = 'prompt-workbench-locale';
const english = {
  '↻ 重做': '↻ Redo', '模板工作流': 'Template workflow', '版本': 'Version',
  '已加入群体': 'Added to batch', '暂无触发词，可手工补充': 'No triggers yet; add them manually',
  '没有识别到文本提示词；该任务可能只修改了参数。': 'No text prompts found; this task may only change parameters.',
  '这里只显示已选择的 LoRA 整组触发词，或你加入的完整提示词。': 'Selected LoRA trigger groups and complete prompts appear here.',
  '点选一个可变字段后，可在下方 LoRA 库点击“填入模板”。固定字段在清空变量时会保留。所有内容都可直接修改。': 'Select a variable field, then fill it from the LoRA library. Clearing variables preserves fixed fields. All fields can be edited.',
  '暂无；可从下方 LoRA 库加入当前模板。': 'None yet. Add fixed LoRAs to this template from the library.',
  '保留原来的模板、人物及画布节点选择。队列仍在时可自动识别；若已经重启导致队列消失，可直接填写中断序号。': 'Keep your original templates, characters and canvas node selection. Existing queue entries can be detected; after a restart, enter a resume position manually.',
  '当前工作流没有可读取的 CLIP 文字。载入含缺失 CLIP 节点的工作流后，原始文字会保留在这里。': 'No readable CLIP text. Original text from missing CLIP nodes will appear here after loading a workflow.',
  '按人物身份建立目录，同一人物的不同 LoRA 和服装会合并；多人物 LoRA 按实际选中的人物触发组拆分。无法可靠判断的资产进入“_未识别人物”。': 'Outputs are grouped by character across LoRAs and outfits. Multi-character models use the selected trigger group. Unidentified outputs go to “_未识别人物”.',
  '块之间分隔符': 'Separator between blocks',
  '输出资产人物归档': 'Organize output by character', '手工完整提示词': 'Manual prompt',
  '可命名模板': 'Named templates', 'CLIP 节点原始文字': 'Original CLIP text',
  'LoRA 中文库': 'LoRA library', '归档': 'Archive', '组合': 'Compose', '手工': 'Manual',
  '模板': 'Templates', '群体': 'Batch', '已连接': 'Connected', '自动整理输出': 'Organize output',
  '整理最终提示词': 'Compose final prompt', '加入完整提示词': 'Add complete prompt',
  '管理可变字段': 'Manage variable fields', '批量生成组合': 'Generate combinations',
  '查看节点原文': 'Read original node text', '浏览人物与服装': 'Browse characters and outfits',
  '组合提示词、管理人物 LoRA，并批量运行模板。': 'Compose prompts, manage character LoRAs and run templates in batches.',
  '工作台功能区': 'Workbench sections', '以后自动分类': 'Automatically organize future output',
  '字段名称': 'Field name', '手工输入，或从 LoRA 自动填充': 'Type here or fill from a LoRA',
  '在这里填写一段完整提示词；加入后会作为一个整体显示在上方。': 'Enter a complete prompt. It will appear above as a single selection.',
  '可用中文、英文、文件名或触发词搜索…': 'Search aliases, filenames or trigger words…',
  '中断序号，例如 190': 'Resume position, e.g. 190',
  '也可每行填写一个人物/替换提示词，例如：\ncharacter A\ncharacter B': 'One character or replacement prompt per line:\ncharacter A\ncharacter B',
  '导入备份将替换当前模板与选择，继续吗？': 'Import replaces current templates and selections. Continue? A backup of your current state will be downloaded.',
  '导入失败': 'Import failed',
  '即使当前版本缺少对应 CLIP 节点，也从工作流原始数据中显示文字；这不代表缺失节点可以执行。': 'View text stored in the workflow even when its CLIP node is missing. Missing nodes still cannot execute.',
  '先在画布选中提示词节点、人物 LoRA 节点及所需数量的固定 LoRA 节点。支持一个人物跑多个模板、一个模板跑多个人物；两边多选时会生成全部组合。队列会逐项执行。': 'Select the prompt node, character LoRA node and enough fixed LoRA nodes on the canvas. Every selected character is combined with every selected template.',
  '中文仅用于显示和搜索，工作流仍保存原始 LoRA 文件名。可按底模筛选，并为任意 LoRA 自定义中文别名。': 'Aliases are used for display and search. Workflows retain original filenames. Filter by base model or customize an alias.',
  '这个模板固定使用的 LoRA（按顺序对应固定 LoRA 加载节点）': 'Fixed LoRAs for this template (ordered to match loader nodes)',
  '自动切换时，请同时选中提示词节点、人物 LoRA 节点和所有可用的固定 LoRA 节点。人物节点优先按标题中的“人物/角色/character”识别；固定节点按节点 ID 从小到大对应模板内顺序。每项任务只启用当前模板需要的数量，多余节点自动旁路；后续模板需要时会自动重新启用。': 'Select the prompt, character LoRA and fixed LoRA nodes. Character nodes are identified by title; fixed nodes follow ascending node ID. Unused fixed loaders are bypassed and restored when needed.',
  '提示词工作台': 'Prompt Workbench', '任务与提示词控制台': 'Tasks and prompt tools',
  '任务队列': 'Task queue', '提示词 / LoRA': 'Prompts / LoRA',
  '刷新': 'Refresh', '编辑': 'Edit', '新建': 'New', '重命名': 'Rename',
  '删除': 'Delete', '复制': 'Copy', '清空': 'Clear', '移除': 'Remove',
  '插队重做': 'Redo next', '取消任务': 'Cancel task', '导入模板': 'Import templates',
  '复制导出': 'Copy export', '＋ 添加字段': '+ Add field', '清空可变项': 'Clear variable fields',
  '生成完整提示词': 'Build prompt', '组合加入上方': 'Add combination above',
  '组合填入当前字段': 'Fill field with combination', '组合加入群体': 'Add combination to batch',
  '从群体取消': 'Remove from batch', '加入群体': 'Add to batch',
  '中文名 / 触发词': 'Alias / triggers', '删除组': 'Delete group', '加入上方': 'Add above',
  '填入当前字段': 'Fill current field', '＋ 新建触发词分组': '+ New trigger group',
  '全选': 'Select all', '清空选择': 'Clear selection', '＋追加': '+ Append',
  '恢复原始': 'Restore original', '所选词加入上方': 'Add selected words above',
  '填入模板当前字段': 'Fill current template field', '删除 LoRA': 'Delete LoRA',
  '载入': 'Load', '保存当前': 'Save current', '清空当前': 'Clear current',
  '清除记录': 'Clear record', '从该序号继续': 'Resume from position',
  '从当前队列继续': 'Resume from current queue', '一键开始群体工作流': 'Start batch',
  '整理现有 output': 'Organize existing output', '写入选中节点': 'Write to selected node',
  '作为完整提示词加入': 'Add as complete prompt', '刷新 LoRA': 'Refresh LoRAs',
  '全部模型': 'All models', '选择': 'Select', '✓ 已选': '✓ Selected',
  '已保存的群体工作流': 'Saved batch presets', '尚无已保存方案': 'No saved presets',
  '保存群体工作流名称': 'Batch preset name', '已选 LoRA 人物': 'Selected LoRA characters',
  '选择模板（箭头后是该模板的替换字段）': 'Templates (arrow shows the replacement field)',
  '每个人物自动切换对应的 LoRA 模型': 'Automatically switch the LoRA for each character',
  '上次群体任务': 'Previous batch', '任务中断续接': 'Resume interrupted batch',
  '暂停投喂': 'Pause submission', '正在暂停…': 'Pausing…', '已暂停投喂': 'Submission paused',
  '等待提交': 'Ready', '提交时断开': 'Submission disconnected', '稳定投喂中': 'Feeding queue',
  '提交已中断': 'Submission interrupted', '已提交，等待核对': 'Queued', '正在执行': 'Running',
  '已全部完成': 'Completed', '正在核对队列…': 'Checking queue…',
  '核对上次群体任务': 'Check previous batch', '群体任务正在提交': 'Batch is submitting',
  '请等待当前批次提交完成。': 'Wait for the current submission to finish.',
  '没有选择模板': 'No templates selected', '请至少勾选一个模板。': 'Select at least one template.',
  '没有人物提示词': 'No character prompts', '从 LoRA 库加入人物，或每行填写一个手工提示词。': 'Add a character from the LoRA library or enter one prompt per line.',
  '群体工作流已保存': 'Batch preset saved', '已载入群体工作流': 'Batch preset loaded',
  '群体工作流已暂停': 'Batch paused', '正在暂停群体工作流': 'Pausing batch',
  '将停止提交新任务；已经进入 ComfyUI 队列的任务仍会完成。': 'New submissions will stop. Tasks already queued will finish.',
  '清空当前群体选择？已保存的群体工作流不会受影响。': 'Clear the current batch selection? Saved presets will be kept.',
  '保存会记录模板、人物/服装组合、手工提示词和 LoRA 自动切换设置。可先保存 1/2/3，再清空当前去处理 4，之后一键载回。': 'Save templates, character/outfit selections, manual prompts and automatic LoRA switching. Save 1/2/3, clear the selection to work on 4, then load the saved preset.',
  '尚未从下方 LoRA 库选择人物。': 'No characters selected from the LoRA library.',
  '没有匹配的 LoRA。': 'No matching LoRAs.', '没有读取到 LoRA 数据。': 'No LoRA data available.',
  '队列是空的。提交任务后，可在这里查看每项任务的提示词。': 'The queue is empty. Submitted tasks and their prompts appear here.',
  '群体工作流': 'Batch workflow', '字段模板': 'Field templates', '最终输出': 'Final output',
  '已选择的完整内容': 'Selected content', '完整提示词': 'Complete prompt',
  '固定': 'Fixed', '可变': 'Variable', '语言': 'Language', '保存失败': 'Save failed',
  '浏览器存储不可用，请导出备份后再关闭页面。': 'Browser storage is unavailable. Export a backup before closing this page.',
  '导出备份': 'Export backup', '导入备份': 'Import backup',
};

export function resolveLocale(value, browserLocale = 'zh-CN') {
  const chosen = value === 'auto' || !value ? browserLocale : value;
  return /^zh\b/i.test(chosen) ? 'zh-CN' : 'en';
}
export function currentLocale() {
  return resolveLocale(storage.getItem(LOCALE_KEY), globalThis.navigator?.language);
}
export function t(text, locale = currentLocale()) {
  if (typeof text !== 'string' || locale === 'zh-CN') return text;
  if (english[text]) return english[text];
  for (const [pattern, render] of patterns) {
    const match = text.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return text;
}
const patterns = [
  [/^运行中 (\d+)$/, n => `Running ${n}`],
  [/^等待中 (\d+)$/, n => `Pending ${n}`],
  [/^继续显示 (\d+) 个$/, n => `Show ${n} more`],
  [/^已显示 (\d+) \/ (\d+) 个等待任务$/, (a, b) => `Showing ${a} of ${b} pending tasks`],
  [/^继续上次群体任务（从 (\d+)）$/, n => `Resume previous batch (from ${n})`],
  [/^群体方案 (\d+)$/, n => `Batch preset ${n}`],
];
export const prompt = (message, value = '') => globalThis.prompt(t(message), value);
export const confirm = (message) => globalThis.confirm(t(message));
