# ComfyUI Prompt Workbench

A local sidebar for prompt composition, field templates, LoRA character/outfit selection and resumable batch submission.

[简体中文](README.zh-CN.md)

## Install

Place this directory in `ComfyUI/custom_nodes/comfyui-prompt-workbench`, restart ComfyUI and refresh the browser. Open **Prompt Workbench** in the sidebar. No npm build or extra Python package installation is required.

Requires Python 3.10+ and a ComfyUI frontend exposing `extensionManager.registerSidebarTab`. Older frontends show an actionable console message instead of failing tab registration. Update ComfyUI's frontend if the sidebar is unavailable.

The optional `comfyui-lora-trigger-helper` plugin supplies curated LoRA groups and character output organization. Without it, this extension can compose prompts, manage templates and inspect LoRAs in the loaded graph; it does not automatically curate every file in your model folder. LoRA files and private metadata are not bundled.

Install the companion [LoRA Trigger Helper](https://github.com/yonghaozheng64-commits/comfyui-lora-trigger-helper) for metadata editing, scanning and output organization. Manager users can install each repository via **Install via Git URL**, where permitted. Restart ComfyUI and use **Refresh LoRAs** for an offline scan. The helper starts without a personal database; create outfit groups and character labels for your own models. See its README for optional online hash lookup and local data backups.

Both repositories are being submitted to the Manager catalog. A submitted PR does not mean the packages are already searchable; availability follows upstream review and catalog refresh.

## Use

- Select a prompt/CLIP node on the canvas before writing a prompt.
- For a batch, select the character LoRA loader and enough fixed LoRA loaders as well.
- **Save current** records selected templates (including field snapshots), character/outfit groups, manual text, separator and automatic switching. **Clear current** clears characters/manual text but keeps selected templates. Load a saved preset to restore it.
- **Pause submission** stops new submissions. Already queued tasks finish. Resume checks queue/history and submits missing jobs. Keep the browser open while feeding a batch.
- **Export backup** saves templates, selections, presets and aliases. Import downloads a backup of the current state before replacement. Execution history and the canvas graph are not included; save your ComfyUI workflow separately.

## Languages and storage

The language selector supports Simplified Chinese and English, initially following the browser. UI translation lives in `web/i18n.js`; unknown/legacy strings fall back to their source. User-authored prompts, model names and trigger words are preserved.

Data remains in browser storage using existing v1/v2 keys. Storage failure falls back to memory and displays a warning: export before closing the page. Changing browser/profile/origin does not automatically transfer settings.

## Structure

- `__init__.py`: ComfyUI registration and local route validation.
- `backend/queue_status.py`: compact history and queue compatibility.
- `web/prompt_workbench.js`: sidebar orchestration and UI.
- `web/state.js`, `storage.js`, `backup.js`: state migration, persistence and backups.
- `web/batch.js`: pure template expansion and job indexing.
- `web/i18n.js`, `lora_i18n.js`: UI languages and model alias vocabulary.
- `tests/`: batch runtime, storage, backup and backend regression tests.

The frontend remains partly monolithic; extracted modules define boundaries for further incremental refactoring.

## Performance and compatibility

LoRA UI is built on first entering the prompt tab, not during ComfyUI startup. Queue polling is suspended while the browser tab is hidden. Sidebar DOM observers are disconnected when the panel closes. Batch submission retains the existing eight-task queue high-water mark. Pausing is checked before submitting each generated graph. No GPU inference path is changed.

Backends with mapped history return compact status records. Older queue implementations fall back to current-queue data plus locally recorded completion markers. No complete history graph copy is requested in that fallback. Failed executions are not treated as successes.

## Development

```sh
npm run check
npm test
python -m unittest discover -s tests -p "test_*.py"
```

Tests use Node's built-in runner and Python unittest; there are no test dependencies. CI is configured for Windows/Linux and Python 3.10/3.12, Node 22. A configured CI matrix is not a claim that every ComfyUI release has been tested.

Personal migration files, browser backups, model databases, generated media and credentials are excluded from the repository. No new telemetry or remote metadata lookup is added by this release.
