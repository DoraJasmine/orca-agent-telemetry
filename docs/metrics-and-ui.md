# 指标核算、UI 与配置规范

本文档描述 `src/engine/metrics.ts` 的全部统计公式、`orca-plugin.json` 设置项语义以及 `panel/index.html` 的前端设计约束。

## 指标核算公式（[src/engine/metrics.ts](../src/engine/metrics.ts)）

所有适配器输出的 `ParsedTurn[]` 均统一交由 `computeMetrics` 处理，以消除不同厂商统计口径的差异。

### 1. 上下文窗口与压缩检测

- **上下文占用百分比**：
  $$\text{percent} = \min\left(100,\; \text{round}_1\left(\frac{\text{contextUsed}}{\text{contextLimit}} \times 100\right)\right)$$
  当任意字段缺失或 `contextLimit <= 0` 时返回 `null`（UI 展示为 `--`）。
- **压缩自动检测（`compactedDetected`）**：在各适配器增量读取单轮上下文用量时，若上一轮上下文 `> 20,000` 且当前轮骤降至上一轮的 `60%` 以下，即判定发生过上下文压缩/截断，界面展示橙色提示标记。

### 2. Token 汇总与推理防双计

- **`inputTotal`**：$\text{inputUncached} + \text{cacheRead} + \text{cacheWrite}$（若提供权威 `cumulativeOverride.inputTotal` 则优先采用）。
- **推理 Token（`reasoning`）口径兼容**：
  - 当 `adapter.reasoningIncludedInOutput` 为 `true`（如 Codex、Claude Code，其 `output_tokens` 已含思考 Token）时：
    $$\text{total} = \text{inputTotal} + \text{output}$$
  - 当 `reasoningIncludedInOutput` 为 `false` 且独立上报 `reasoning` 时：
    $$\text{total} = \text{inputTotal} + \text{output} + \text{reasoning}$$
  - 同理，`estimateCostUsd` 会在 `reasoningIncludedInOutput === true` 时避免对 `reasoning` 重复按输出单价计费（详见 [src/adapters/model-windows.ts](../src/adapters/model-windows.ts)）。
- **缓存命中率（`cacheHitRatePct`）**：
  $$\text{cacheHitRatePct} = \text{round}_1\left(\frac{\text{cacheRead}}{\text{inputUncached} + \text{cacheRead} + \text{cacheWrite}} \times 100\right)$$

### 3. 速率计算（`tok/s`）与阻塞时长扣除

速率计算遵循 `MIN_RELIABLE_DURATION_MS = 200` 与上限 `600_000` ms（超过 10 分钟视作空转挂起，不计入生成速率分母）：

- **每轮有效输出**：`reasoningIncludedInOutput ? t.output : t.output + t.reasoning`。
- **最近一轮（`turnTokPerSec`）**：取最后一轮的有效输出与耗时比值（精确到 0.1）；若最后一轮日志尚未带时间戳差，且存在 Worker 记录的 `PromptTimingHint`（由 `agent.prompt.before` 与 `agent.status.changed` 追踪），将使用 `turn.timestampMs - lastPromptAtMs - blockedAccumMs` 计算真实生成耗时，自动扣除审批等待/权限卡住时间。
- **30 秒滚动窗口（`rollingTokPerSec`）**：汇总距离最后一轮 `timestampMs` 不超过 `ROLLING_WINDOW_MS = 30_000` ms 的所有有效轮次，若窗口内有效输出不足则退化为 `turnTokPerSec`。
- **整场平均（`sessionAvgTokPerSec`）**：整份会话内所有满足 `200ms <= dur <= 600s` 轮次的有效输出之和除以有效耗时之和。

---

## 插件设置与配置说明（[orca-plugin.json](../orca-plugin.json)）

Manifest 中共声明 5 个设置项（通过 Orca 设置页面或面板内部控件修改）：

| Key | 类型 | 默认值 | 生效位置 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `cursorHookEnabled` | `boolean` | `false` | 面板开关 / 设置 | 开启后向当前环境挂载 `~/.cursor/hooks.json`；关闭时自动清除插件 Hook 条目 |
| `showStatusBar` | `boolean` | `true` | 面板开关 / 设置 | 控制是否在 Orca 底部状态栏推送简报（模型/上下文百分比/tok/s/变更文件） |
| `showEstimatedCost` | `boolean` | `true` | 面板开关 / 设置 | 控制是否按官方参考单价计算并显示 `$Est. Cost` |
| `refreshIntervalMs` | `number` | `2000` | Orca 设置 | 侧边栏可见且会话空闲时的常规采样周期；运行中面板可见时上限钳制为 `1000ms` |
| `contextWindowOverride` | `string` | `""` | Orca 设置 | 自定义模型窗口大小，逗号分隔的 `key=tokens` 列表（见下文格式） |

### `contextWindowOverride` 语法示例

由 `parseModelWindowOverrides` 解析（键名统一转小写、忽略无效项）：

```text
kimi-code/k3-256k=262144, claude-sonnet-4-6=1000000, gpt-5-codex=400000
```

在插件测试或无自定义模型别名时，也可以只配置短名称或完整 Provider 前缀名。

---

## Panel UI 与前端约束（[panel/index.html](../panel/index.html)）

### 1. CSP 与单文件内联原则
- **严禁外部网络/文件依赖**：所有样式与脚本必须内联于 `panel/index.html` 中，不得包含 `<script src=...>` 或 `<link href=...>`；该约束由 [src/panel.test.ts](../src/panel.test.ts) 强制校验，违背会导致 Orca Webview 安全策略拦截。
- **防 XSS 转义约定**：任何来自用户 Prompt、工作区名称、分支名、文件路径、日志行的字符串进入 `innerHTML` 前，**必须**经由 `esc(...)` 转义；`data-*` 属性读写需走标准 DOM `dataset` 或转义属性。

### 2. 主题令牌复用
面板 CSS 完全引用 Orca 宿主注入的 `--orca-*` 变量（如 `--orca-foreground`、`--orca-muted`、`--orca-border`、`--orca-card`、`--orca-accent`、`--orca-warning` 等），自动适配浅色、深色及高对比度主题，同时兼容 `orca plugin shot --theme light|dark` 无头截图校验。

### 3. UI 结构与状态持久性
- **Header**：显示工作区名称、当前主机环境胶囊徽章（如 `WSL · Ubuntu-22.04` / `Local`）、Git 分支及右上角手动强制刷新按钮。
- **SESSIONS 栏**：提供 `Auto · <agent>` 快速回退胶囊与当前工作区多会话 Pill，旁侧标注当前模式标签（`Auto Follow` / `Manual Pin`）。
- **Context Window 卡片**：大号占用百分比、进度条（`>85%` 高危警示色）、`已用 / 上限`（按 SI 十进制缩写 `k`/`M` 对齐显示，如 `1,048,576 -> 1.05M`）、Model 全名与压缩标记。
- **Tokens & Speed 卡片**：三格高亮 KPI（`Turn Speed` / `Rolling Avg` / `Total`）+ 8 项网格明细 + 可折叠高频工具统计。
- **Git & Worktree 卡片**：分支名、来源（`WSL Git` / `Local Git` / `Orca Branch`）、`M/A/D/?` 与 `+lines / -lines` 计数、最近一次 Commit 与可折叠改动文件清单（折起状态在跨次刷新重绘时保留）。
- **CONTROLS 卡片**：内置 3 个即时生效开关（Cursor Hook、状态栏简报、API 估算费用）以及可折叠的 `Diagnostics & Logs` 面板。
