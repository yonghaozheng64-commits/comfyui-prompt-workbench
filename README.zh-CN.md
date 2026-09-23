# ComfyUI 提示词工作台

[English](README.md) · 版本 0.2.1

本地侧栏扩展，支持提示词组合、字段模板、LoRA 人物/服装分组、群体方案保存及批量任务暂停续接。

## 安装与兼容性

放入 `ComfyUI/custom_nodes/comfyui-prompt-workbench`，重启 ComfyUI 并刷新页面。无需 npm 构建或额外安装 Python 依赖。

需要 Python 3.10+，前端必须提供 `extensionManager.registerSidebarTab`。过旧的前端会在控制台提示更新。后端不支持轻量历史查询时，改用当前队列与本地完成标记续接。

`comfyui-lora-trigger-helper` 是可选配套插件，提供已策展的模型分组和人物输出归档；本仓库不包含该插件及个人 LoRA 数据库。未安装时仍可使用模板、提示词组合、队列预览及当前画布上的 LoRA。

配套插件现已单独发布：[LoRA Trigger Helper](https://github.com/yonghaozheng64-commits/comfyui-lora-trigger-helper)。在允许 Git URL 安装的 Manager 中分别安装这两个仓库，重启后点击工作台的“刷新 LoRA”即可离线扫描自己的模型。首次为空数据库；完整服装分组、中文描述、人物标记需要自行编辑，联网查询也不保证这些内容齐全。

两个插件已一并提交 Manager 收录申请：[PR #3266](https://github.com/Comfy-Org/ComfyUI-Manager/pull/3266)。提交申请不代表已经可以搜索安装，仍须等待维护者审核和列表更新。

## 操作

- 在画布选中提示词节点；批量自动切换还需选中人物 LoRA 和所需的固定 LoRA 加载节点。
- 保存群体方案会记录模板内容快照、人物/服装选择、手工文本、分隔符和自动切换设置。载入会恢复保存时的模板内容。
- “清空当前”清除人物与手工文本，保留模板勾选；已保存方案保留。例如先保存 1/2/3，清空后处理 4，再载回原方案。
- 暂停停止后续入队，已经入队的任务继续完成。通过继续上次群体任务核对并补交缺失任务。投喂期间请保持页面打开。
- 顶部默认跟随 ComfyUI 的语言设置，也可单独选择中英文。界面源文本和缺失翻译回退为英文；中文通过 `locales/zh/main.json` 和 ComfyUI `/i18n` 接口加载。用户提示词、已有模板、模型别名及触发词不作批量翻译。
- 出于安全考虑，网页删除模型及移动已有输出的功能已移除；请改用操作系统文件管理器。未来任务的人物目录分类仍保留。更新配套插件后必须重启 ComfyUI，才能卸载进程中已有的旧接口；只刷新网页不够。
- 导出备份包括模板、群体方案、选择和别名；导入前自动下载当前数据备份。执行记录和画布不在其中，请另存 ComfyUI 工作流。

## 结构与性能

入口负责注册，`backend/` 负责队列状态，`web/state.js`、`storage.js`、`backup.js` 管理持久化，`batch.js` 负责组合计算，`i18n.js` 管理界面语言。界面主体仍保留在 `prompt_workbench.js`，后续可继续按功能拆分。

打开提示词标签才构建 LoRA 界面；后台标签页停止队列轮询，关闭侧栏释放 DOM 观察器。保留最多约 8 个队列任务的逐步提交策略，暂停期间不会被完成事件覆盖。修改不涉及 GPU 推理代码。

沿用原浏览器数据键，存储不可用时退回内存并提示导出；关闭页面前请保存备份。更换浏览器、用户配置或访问地址后须手动导入。

## 验证

```sh
npm run check
npm test
python -m unittest discover -s tests -p "test_*.py"
```

已添加 Windows/Linux、Python 3.10/3.12 的 GitHub Actions 测试配置。测试矩阵不代表所有 ComfyUI 历史版本都已实机验证。

发布不包含私人迁移模板、模型数据库、生成图片、日志或凭据。
