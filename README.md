# Orca Agent Telemetry

Orca 右侧边栏与状态栏 Agent 遥测插件，专为 **Windows 本机运行 Orca 客户端 + 连接 WSL 作为工作区**（同时兼容本机 Windows 工作区）打造，实时显示当前工作区的 **上下文用量、Token 明细、生成速率（`tok/s`）与 Git 状态**。

## 支持的 Agent 与数据源

| Agent | 精确数据源（本地增量读取） | 兜底数据源 |
| :--- | :--- | :--- |
| **Codex** (`codex`) | `~/.codex/sessions/**/rollout-*.jsonl`（`last_token_usage` / `total_token_usage` / `model_context_window`，已去重 `rate_limits` 重复事件） | Orca `agent.listSessions` |
| **Kimi** (`kimi`) | 新版 `.kimi-code/sessions/.../wire.jsonl`（turn-scoped `usage.record`）与旧版 `.kimi/sessions/.../wire.jsonl`（`StatusUpdate`） | Orca `agent.listSessions` |
| **Antigravity** (`antigravity` / `agy`) | `.gemini/antigravity*/brain/<id>/.system_generated/logs/transcript.jsonl`（`PLANNER_RESPONSE`） | Orca `agent.listSessions` |
| **Cursor** (`cursor`) | 开启面板内 **Cursor Hook 精确统计** 开关后，通过 `~/.cursor/hooks.json`（`beforeSubmitPrompt` + `stop`）按轮记录精确 Token 与模型 | `agent-transcripts/*.jsonl` 字符估算 + Orca `agent.listSessions` |

## 核心功能

- **Context Window**：上下文占用进度条、百分比、`已用 / 上限`、当前模型名、上下文压缩提示及 `>85%` 高占用提醒。
- **Tokens & Speed**：本轮输出速率 (`Turn tok/s`)、近 30s 滚动速率 (`Rolling tok/s`)、总 Token、Input (New) / Output / Reasoning / Cache Read / Cache Write 明细、缓存命中率、可选 API 估算费用及工具调用次数统计。
- **Git & Worktree**：在 WSL 工作区下经由 `wsl.exe` 在 Linux 侧原生执行 `git`，避开 9P 跨盘慢与换行符误报；展示分支、Upstream `↑/↓`、变更文件统计、增删行数、最近 Commit 及可折叠改动文件清单。
- **Cursor Hook 开关**：面板内提供独立开关：
  - 关闭时零配置读取对话文本估算与 Orca Session 汇总；
  - 开启时自动向目标环境（WSL 或 Windows）的 `~/.cursor/hooks.json` 合并写入本插件条目，不改动你原有的其他 Hook；关闭时仅移除本插件条目。
- **状态栏简报与可见性感知调度**：支持一键开关底部状态栏摘要与估算费用；采用 `stat + offset` 增量 tail（兼容 WSL2 `\\wsl.localhost` 9P 路径），并随侧边栏可见性与 Agent 运行状态自动调频。

## 安装与使用

### 从 GitHub 安装

```powershell
orca plugin system on
orca plugin install https://github.com/DoraJasmine/orca-agent-telemetry.git
```

安装时按提示批准插件权限（`workspace:read`、`agent:read`、`history:read`、`storage:own`、`settings:own` 及 `trusted-worker`），随后在 Orca 右侧边栏点击 **Agent Telemetry** 图标即可查看。

> **兼容性说明**：支持 Orca Paired Environment（`--environment WSL`）以及 Orca Native Chat 会话（当 `orcaSessionId` 与底层 CLI 的 UUID 不同时，自动通过工作区路径、`state.json`、`history.jsonl` 与首条提示词/时间接近度匹配）。面板底部的 **Diagnostics & Logs** 可展开查看工作区路径、命中的日志文件及运行日志（持久化于 `~/.orca-telemetry/plugin.log`）。

### 本地开发与测试

```powershell
# 生成类型定义（如刚克隆仓库）
orca plugin types .

# 校验清单与无头渲染检查
orca plugin validate .
orca plugin check .

# 运行单元测试（基于 orca/testing）
orca plugin test .

# 热加载到本机 Orca 并实时查看日志
orca plugin dev load . --approve
orca plugin dev watch .
```

## 目录结构

```text
orca-agent-telemetry/
├─ orca-plugin.json               # 清单、权限、设置项、状态栏与事件/钩子声明
├─ tsconfig.json                  # 继承 ./.orca/types/tsconfig.json
├─ src/
│  ├─ protocol.ts                 # Panel ↔ Worker 强类型契约
│  ├─ worker.ts                   # Trusted Worker 主循环、调度与状态栏更新
│  ├─ panel.tsx                   # 右侧边栏原生 TSX UI
│  ├─ collectors/                 # wsl-env / orca-context / git 采集器
│  ├─ adapters/                   # tailer / codex / kimi / agy / cursor / fallback
│  ├─ engine/                     # 上下文、速率（tok/s）与成本核算引擎
│  ├─ helpers/                    # Cursor Hook 管理器与 standalone hook 脚本
│  ├─ adapters.test.ts            # 解析器、WSL 路径、Git 与 Hook 单测
│  ├─ panel.test.tsx              # 面板渲染与交互单测
│  ├─ panel.check.ts              # `orca plugin check` 检查场景
│  └─ worker.test.ts              # Worker 请求、Hook 与权限校验单测
├─ LICENSE
└─ README.md
```
