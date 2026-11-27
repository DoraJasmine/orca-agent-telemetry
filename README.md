# Orca Agent Telemetry

Orca 右侧边栏与状态栏 Agent 遥测插件（`dorajasmine.agent-telemetry`），专为 **Windows 本机运行 Orca 客户端 + 连接 WSL / 本机工作区** 场景打造，实时呈现当前活跃或选中 Agent 会话的 **上下文窗口占用、Token 明细、生成速率（`tok/s`）、估算 API 成本与 Git 状态**。

> 当前版本：`0.2.3` · 最低 Orca 版本：`>= 1.4.259` · 运行模式：`trusted-worker` + 零外链 CSP-safe HTML 面板

## 支持的 Agent 与数据源

| Agent | 精确本地数据源（`JsonlTailer` 增量 tail） | Native Chat 会话归因信号 | 兜底数据源 |
| :--- | :--- | :--- | :--- |
| **Claude Code** (`claude`) | `~/.claude/projects/<slug>/<session>.jsonl`（按 `message.id` 去重，读取 `settings.json` 中的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`） | `sessionId`、`~/.claude/history.jsonl`、目录 slug / 头部 `cwd` 前缀、首条提示词与 mtime | Orca `agent.listSessions` |
| **Kimi Code / CLI** (`kimi`) | 新版 `~/.kimi-code/sessions/.../wire.jsonl`（`usage.record` `turn` 作用域、`profile.bind.modelAlias`、`token_counting.measured`，读取 `config.toml` `max_context_size`）与旧版 `.kimi/sessions/.../wire.jsonl`（`StatusUpdate`） | `session_index.jsonl`（跳过 `deleted: true` 墓碑）、`state.json`（`cwd`/`title`/`lastPrompt`/`updatedAt`）、`wire.jsonl` 真实 mtime 与头尾提示词 | Orca `agent.listSessions` |
| **Codex** (`codex`) | `~/.codex/sessions/**/rollout-*.jsonl`（`last_token_usage` / `total_token_usage` / `model_context_window`，已对 `rate_limits` 重复行去重，避免 `reasoning` 重复计入输出） | `session_meta.payload.cwd`（支持超 `64 KB` 截断回退正则提取）、提示词与 `mtimeMs` | Orca `agent.listSessions` |
| **Antigravity** (`antigravity` / `agy`) | `~/.gemini/{antigravity-cli,antigravity,antigravity-chat/antigravity-acp}/brain/<id>/.system_generated/logs/transcript.jsonl`（`PLANNER_RESPONSE` / `step_index` 去重，按 `input_tokens + cache_read_tokens + output_tokens` 核算上下文） | `history.jsonl`、按 `mtimeMs` 排序的 `brain/*` 头部 `title` / 尾部 `prompt` 联合评分 | Orca `agent.listSessions` |
| **Cursor** (`cursor`) | 开启 **Cursor Hook 精确统计** 后，通过 `~/.cursor/hooks.json` 写入 `~/.orca-telemetry/cursor-usage.jsonl`（`generation_id` 去重，扣除含 cache 重复项） | `session_id`、`workspace_roots`、大小写 Slug 下的 `agent-transcripts/*.jsonl` | Transcript 字符估算（`≈ 3.8 chars/token`）+ Orca `agent.listSessions` |

## 核心功能

- **多会话一眼切换（Auto Follow / Manual Pin）**：顶部会话 Pill 栏展示当前工作区检测到的全部会话与状态；默认 **Auto Follow** 自动跟踪正在运行或最近更新的会话，点击任意会话 Pill 可秒级切换查看，点击 `Auto` 恢复自动跟随。
- **Context Window**：上下文占用进度条、百分比、`已用 / 上限`、当前模型名、基于会话配置或模型表的精确窗口识别（支持 Kimi/DeepSeek/Claude `1M`、Codex `258.4k` 等）及上下文压缩检测提示。
- **Tokens & Speed**：本轮输出速率 (`Turn tok/s`)、近 30s 滚动速率 (`Rolling Avg`)、整场平均速率 (`Session Avg`)、总 Token、Input (New) / Output / Reasoning / Cache Read / Cache Write 明细、缓存命中率、可选 API 估算费用及高频工具调用统计。
- **Git & Worktree**：WSL 工作区经由 `wsl.exe` 在 Linux 侧原生执行 `git`，避开 9P 跨盘扫描延迟与换行符误报；展示分支、Upstream 领先/落后、变更数量、增删行数、最近 Commit 与可折叠改动文件清单。
- **Cursor Hook 精确采集开关**：可在面板内直接启用/关闭；启用时向目标环境（WSL 或 Windows）的 `~/.cursor/hooks.json` 安全合并写入本插件条目，保留原有其他 Hook，关闭时仅卸载本插件条目。
- **可见性感知与零外部依赖**：侧边栏基于 Orca 原生 CSS 变量（`--orca-*`）适配浅/深色主题；`JsonlTailer` 通过 `stat + offset` 轮询适配 WSL2 `\\wsl.localhost`；可见性与 Agent 状态变化时自动调节采样频率。

## 安装与使用

### 从 GitHub 安装与升级

```powershell
orca plugin system on
orca plugin install https://github.com/DoraJasmine/orca-agent-telemetry.git
```

更新已安装版本：

```powershell
orca plugin update dorajasmine.agent-telemetry
```

### 权限声明说明

安装时需授予以下能力（定义于 [orca-plugin.json](./orca-plugin.json)）：

| 权限 / 模式 | 用途 |
| :--- | :--- |
| `execution: "trusted-worker"` | 在独立 Node.js Worker 进程读取本地/WSL 代理日志并调用 `wsl.exe` 与 `orca` CLI |
| `workspace:read` | 读取当前工作区名称、分支、路径、终端与工作区切换事件 |
| `agent:read` | 订阅 `agent.status.changed` 等 Agent 状态变更通知 |
| `history:read` | 读取各本地 CLI 工具的会话索引、标题、状态与 Token 统计记录 |
| `storage:own` | 持久化运行日志 `~/.orca-telemetry/plugin.log` 与 Cursor Hook spool 数据 |
| `settings:own` | 读写面板内的开关与用户自定义上下文窗口覆盖设置 |

## 本地开发常用命令

```powershell
# 1. 在仓库根目录生成 Orca SDK 类型定义（.orca/types/）
orca plugin types .

# 2. 校验清单结构与无头面板静态检查
orca plugin validate .
orca plugin check .

# 3. 运行全套单元测试（adapters / worker / panel）
orca plugin test .

# 4. 热加载当前目录到本机 Orca 并实时调试
orca plugin dev load . --approve
orca plugin dev watch .

# 5. 打开面板并截取渲染快照校验 UI
orca plugin open dorajasmine.agent-telemetry
orca plugin shot dorajasmine.agent-telemetry --out panel-shot.png
```

## 目录结构

```text
orca-agent-telemetry/
├─ orca-plugin.json               # 插件清单、面板/状态栏/事件/Hook 贡献点、设置与权限声明
├─ tsconfig.json                  # TypeScript 配置（继承 ./.orca/types/tsconfig.json）
├─ panel/
│  └─ index.html                  # CSP-safe 单文件侧边栏前端（内联 CSS/JS 与 --orca-* 主题令牌）
├─ src/
│  ├─ protocol.ts                 # Panel ↔ Worker RPC 请求、事件与数据结构契约
│  ├─ worker.ts                   # Trusted Worker 生命周期、自适应调度、Epoch 守卫与状态栏汇总
│  ├─ logger.ts                   # 双通道结构化日志（orca.log + 512KB 轮转 ~/.orca-telemetry/plugin.log）
│  ├─ collectors/
│  │  ├─ wsl-env.ts               # WSL UNC 路径解析、orca CLI 定位、scrubbed env 还原与命令执行器
│  │  ├─ orca-context.ts          # Orca Host API 采集 + Paired Environment CLI 回退 + Agent 排序合并
│  │  └─ git.ts                   # WSL/本地 Git 状态与 numstat 增量解析
│  ├─ adapters/
│  │  ├─ types.ts                 # AdapterContext / AdapterResult / ParsedTurn 统一接口
│  │  ├─ tailer.ts                # 兼容 9P 的字节偏移增量 JSONL Tailer 与时间解析工具
│  │  ├─ fs-lookup.ts             # 多平台目录遍历、时间邻近挑选与头尾切片读取
│  │  ├─ model-windows.ts         # 各厂商上下文窗口上限表、配置覆盖与 API 成本估算
│  │  ├─ claude.ts                # Claude Code JSONL 适配器
│  │  ├─ kimi.ts                  # Kimi Code Wire / Legacy CLI 适配器与 config.toml 解析
│  │  ├─ codex.ts                 # Codex rollout JSONL 适配器
│  │  ├─ agy.ts                   # Antigravity transcript JSONL 适配器
│  │  ├─ cursor.ts                # Cursor Hook spool 与 transcript 估算适配器
│  │  └─ fallback.ts              # 基于 Orca Session 汇总的兜底适配器
│  ├─ engine/
│  │  └─ metrics.ts               # 上下文占比、推理 Token 去重、速率（tok/s）与成本汇总引擎
│  ├─ helpers/
│  │  └─ cursor-hook.ts           # `~/.cursor/hooks.json` 安全合并/卸载与 hook 脚本源生成器
│  ├─ adapters.test.ts            # 适配器解析、会话归因、WSL 解析、Git、Hook 与日志单元测试
│  ├─ worker.test.ts              # Worker 请求/Hook/设置与 Paired WSL 回退集成测试
│  └─ panel.test.ts               # Panel CSP 约束与通信契约静态测试
├─ docs/                          # 项目研发文档（架构、适配器、指标与 UI、开发与排障指南）
├─ CHANGELOG.md                   # 版本变更记录
├─ LICENSE
└─ README.md
```

## 项目文档索引

为了方便后续迭代维护与新增 Agent 支持，完整工程文档按职责拆分为以下部分：

- [系统架构与数据流 (`docs/architecture.md`)](./docs/architecture.md) — 运行时拓扑、Paired WSL 环境发现、Worker Epoch 并发防线、自适应调度、Panel ↔ Worker RPC 契约与核心技术决策。
- [适配器与数据源规范 (`docs/adapters.md`)](./docs/adapters.md) — Native Chat 跨 UUID 会话匹配原理、5 大 Agent 的日志 Schema/去重细节、模型窗口解析优先级，以及新增 Agent 适配器的完整指南。
- [指标核算、UI 与配置规范 (`docs/metrics-and-ui.md`)](./docs/metrics-and-ui.md) — `tok/s` 速率与推理 Token 精确口径、设置项格式（含 `contextWindowOverride`）、CSP-safe HTML 面板约定与交互状态持久性。
- [开发、测试、排障与发版指南 (`docs/development.md`)](./docs/development.md) — 本地搭建、PowerShell / WSL 脚本注意事项、日志诊断手册、单测规范、常见故障排查 Playbook 与发版 CheckList。
- [变更日志 (`CHANGELOG.md`)](./CHANGELOG.md) — `v0.1.0` 至 `v0.2.3` 的完整迭代记录。
