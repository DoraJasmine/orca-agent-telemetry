# Changelog

本文件记录 `dorajasmine.agent-telemetry` 的主要版本演进（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格）。

## [0.2.3] - 2026-11-27

### Fixed
- **Antigravity Token 与上下文统计口径修复**：统一 `agy.ts` 对 Gemini 与 Anthropic 模型的解析逻辑——Antigravity `transcript.jsonl` 中的 `input_tokens` 仅代表未命中缓存的新增输入（不含 `cache_read_tokens`），改为统一按 `inputUncached = input_tokens` 与 `contextUsed = input_tokens + cache_read_tokens + output_tokens` 计算，解决上下文显示偏小（如 `4.6k`）、命中缓存时新增输入被扣成 `0` 及误报 `Compacted` 的问题。
- **Antigravity 会话归因准确度修复**：重构 `locateTranscriptFile` 与 `readHistoryMap`，将 `history.jsonl` 与按真实 `mtimeMs` 排序的 `brain/*/.system_generated/logs/transcript.jsonl` 联合打分，同时结合 `agent.title`（头部 `8 KB`）与 `agent.prompt`（尾部 `64 KB`，自动清理 `[Image #N]` 与省略号 `…`）匹配，防止未写 `history.jsonl` 的 Native Chat 新会话被几天前同工作区的历史记录劫持锁死。
- **Antigravity 生成速率计时修复**：`JsonlTailer` 透传 `isInitialRead` 标记，`ingestAgyLine` 改为结合 `PLANNER_RESPONSE` 与后续 `GENERIC` (`source: "MODEL"`) 步骤的时间差（排除 `USER_INPUT` 等待时间）计算生成耗时，避免同秒 `0s` 或前置步骤间隔造成的 `tok/s` 失真。

## [0.2.2] - 2026-11-25

### Fixed
- **Kimi 会话归因准确度修复**：重构 `lookupInSessionIndex` 与目录回退扫描，跳过 `~/.kimi-code/session_index.jsonl` 中 `"deleted": true` 墓碑行，并按真实 `wire.jsonl` `mtimeMs` + `state.json` + 头/尾提示词联合评分，解决多历史会话并存时平局错选旧会话及弱匹配锁死缓存的问题。
- **Kimi 模型识别与 `1M` 上下文对齐**：补充解析 `profile.bind.modelAlias`、`llm.request.maxTokens` 与 `token_counting.measured`；支持直接读取 `.kimi-code/config.toml` 的 `default_model` 与 `max_context_size`；更新 `model-windows.ts`，区分 `k3-256k` / `-highspeed` / `k2`（`262,144`）与 `k3` / `k3.1-pro` / `kimi-for-coding`（`1,048,576`）及 DeepSeek V4（`1,000,000`）。

## [0.2.1] - 2026-11-25

### Fixed
- **快速切换防竞态**：为工作区上下文和会话选择引入 `contextEpoch` / `selectionEpoch` 守卫，防止快速切换工作区或连点会话 Pill 时被慢异步轮询结果覆盖。

## [0.2.0] - 2026-11-25

### Added
- **新版轻量内联面板 UI**：由重型 TSX 组件全面重构为 CSP-safe 单文件 HTML/CSS/SVG（[panel/index.html](./panel/index.html)），深度对齐 `--orca-*` 宿主设计令牌并持久化折叠面板状态。
- **Auto Follow & 1-Click 会话切换栏**：顶部增加多会话 Pill 切换器，支持秒级切换查看与一键恢复自动跟踪。
- **两阶段工作区切换与实时状态叠加**：引入 `applyLiveActivityOverlay` 与快速缓存先出屏刷新。

## [0.1.8] - 2026-11-25

### Fixed
- 修复 Codex 超长 `session_meta.base_instructions` 截断前 `64 KB` 第 0 行 JSON 时通过正则安全提取 `"cwd"`；扩展 Claude / Cursor 头部提示词采样范围。

## [0.1.7] - 2026-11-25

### Added
- 新增 **Claude Code** 原生适配器（支持 `message.id` 流式片段去重、`cwd` 子目录前缀匹配及 `settings.json` `1M` 上下文读取）。

### Fixed
- 解除过度固定的自动选中锁，恢复默认追踪最新活跃 Agent；修复 Codex / Claude `reasoning` Token 被重复计入总量与计费的问题；调整 `TelemetryLogger` `INFO` 去重为按内容变更持久化抑制，消除每分钟定时刷屏日志。

## [0.1.6] - 2026-11-25

### Fixed
- 为 Cursor `beforeSubmitPrompt` Hook 输出 `{"continue":true}\n` 避免阻断提问提交，并在 WSL 启动及工作区切换时自动检测同步 `~/.cursor/hooks.json`。

## [0.1.5] - 2026-11-25

### Fixed
- 在 `trusted-worker` 擦除 Windows 环境变量的场景下，基于 `os.homedir()` 自动重建 `USERPROFILE` / `HOME` / `APPDATA` / `LOCALAPPDATA`，保证派生 `orca.exe` 可正常访问用户运行时目录。

## [0.1.4] - 2026-11-25

### Fixed
- 当 `LOCALAPPDATA` 未设置时，依次经由 `process.execPath` 同级目录及 `os.homedir()` 解析定位 `resources/bin/orca.exe`。

## [0.1.3] - 2026-11-25

### Fixed
- 派生子进程前剥离 `ELECTRON_RUN_AS_NODE` 等包装变量；缓存遭遇 `selector_not_found` 的 `workspaceId` 以消除无效重试开销。

## [0.1.2] - 2026-11-25

### Added
- 支持 Orca Paired WSL Environment（CLI `environment list` / `worktree ps` 回退发现）、Native Chat 跨 UUID 会话匹配与持久化日志 `~/.orca-telemetry/plugin.log`；对齐真实 Kimi / Codex 日志格式。

## [0.1.1] - 2026-11-25

### Changed
- 将插件 ID 与 Publisher 规范重命名为 `dorajasmine.agent-telemetry`（避免占用官方保留 `orca-` 前缀）。

## [0.1.0] - 2026-11-25

### Added
- 初始版本发布，提供 Worker、面板、状态栏简报、Codex/Kimi/AGY/Cursor 适配器、WSL Git 采集与速率核算引擎。
