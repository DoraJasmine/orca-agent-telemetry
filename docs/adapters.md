# 适配器与数据源规范

本文档详细记录插件支持的 5 种本地 Agent 适配器与 1 种兜底策略的文件路径、Native Chat 跨 UUID 归因机制、日志 Schema 与去重规则，以及如何为新 Agent 扩展适配器。

## 适配器接口契约

接口定义于 [src/adapters/types.ts](../src/adapters/types.ts)：
- **`AdapterContext`**：传入目标 `agent: AgentOption`、`workspace: WorkspaceEnv`、`homeRoots: HomeRoot[]`（按 WSL 当前 distro 优先，其次 Windows home）、`orcaSession: OrcaSessionSummary | null`、`cursorHookEnabled`、`modelOverrides` 与 `logger`。
- **`AdapterResult`**：返回统一的 `source`、`sourceLabel`、`logPath`、`model`、`contextUsed`、`contextLimit`、`contextIsEstimated`、`compactedDetected`、`reasoningIncludedInOutput`、`tokensAvailable`、`turns: ParsedTurn[]`、`cumulativeOverride` 与 `recentTools`。

所有文件扫描与读取均使用 [src/adapters/fs-lookup.ts](../src/adapters/fs-lookup.ts) 与 [src/adapters/tailer.ts](../src/adapters/tailer.ts) 提供的跨 Windows / `\\wsl.localhost` 工具，避免全盘暴力遍历。

---

## Native Chat 跨 UUID 会话匹配原则

Orca 在 **Native Chat** 或 **Paired WSL Environment** 下启动的会话，其对外暴露的 `sessionId`（如 `structured-agent-session-*` 或 Orca pane UUID）往往与各 CLI 工具内部落盘使用的 UUID **不一致**。为此所有适配器均采用分级匹配与置信缓存策略：

1. **Tier 1 — 直接 ID 匹配**：优先查找路径或头部字段中直接包含 `ctx.agent.sessionId` 的文件；命中即高置信锁定 `pathByAgentKey`。
2. **Tier 2 — 索引账本映射**：读取各 CLI 的全局索引文件（如 `~/.kimi-code/session_index.jsonl`、`~/.claude/history.jsonl`、`~/.gemini/antigravity-cli/history.jsonl`），按工作区路径、`prompt` 摘要（`buildPromptSnippet`）与活动时间戳（`agentActivityTimestamp`）综合评分。
3. **Tier 3 — 工作区目录 / Slug 与头部特征扫描**：按工作区转义目录（如 Claude Slug、Cursor Slug、Kimi `wd_<base>_*`）缩小搜索域，利用 `readHeadUtf8`（最长 `16–64 KB`）或 `readTailUtf8` 核对 `cwd` 与用户提示词。
4. **置信缓存防锁死规则**：若仅靠时间戳兜底命中、且与 `targetMs` 相差超过 `120_000 ms`（且无 SID / 提示词直接印证），**不得写入 `pathByAgentKey` 永久缓存**。这样可以确保新开会话首轮尚未 flush 新日志时不会永久误锁到历史旧会话，下次轮询即可自动切换过去。

---

## 各 Agent 适配器实现细节

### 1. Claude Code（[src/adapters/claude.ts](../src/adapters/claude.ts)）

- **检索路径**：
  1. `<home>/.claude/projects/<slug>/<sid>.jsonl`（Slug 规则：工作区路径中非 `[A-Za-z0-9-]` 字符替换为 `-`）
  2. `<home>/.claude/history.jsonl`（倒数 128 KB 按 `project`、`display` 与时间评分映射真实 `sessionId`）
  3. 跨子目录回退：读取各 `projects/*/*.jsonl` 前 `32 KB`（前 12 行）核对 `cwd` 是否与工作区互为前缀（兼容工作区内进入子目录运行 CLI 的场景）。
- **日志 Schema 与去重**：
  - 按 `type === 'user' | 'api-request'` 记录 Turn 起始时间戳锚点 `lastRequestAtMs`。
  - 对 `type === 'assistant'` 跳过 `model === '<synthetic>'`。
  - **流式分片去重**：Claude Code 会针对同一条 `message.id` 连续落盘多次中间状态；通过 `turnIndexByMessageId` 对同一 `message.id` **原地覆写更新**（仅当 `output` 与总输入单调不减时），并用 `seenToolUseIds` 防止同一工具调用被重复计数。
  - **Token 与窗口**：`contextUsed = input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`；设置 `reasoningIncludedInOutput = true`（`thinking_tokens` 已含在 `output_tokens` 内，供展示明细但不二次计入总量与计费）。若 `~/.claude/settings.json` 配有 `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`（`>= 32_000`），优先作为上下文上限。

### 2. Kimi Code / Legacy Kimi CLI（[src/adapters/kimi.ts](../src/adapters/kimi.ts)）

- **检索路径**：
  1. **Tier 1（`session_index.jsonl`）**：读取 `~/.kimi-code/session_index.jsonl`（尾部 512 KB），先按顺序折叠更新并清除 `deleted: true` 的墓碑记录。由于生产环境的 `session_index.jsonl` 行本身**不含 `updatedAt` 和 `title`**，绝不能只按索引字段排序（否则同工作区多会话平局必中第一条最老会话）；插件会并发 `stat` 各个 `wire.jsonl` 的真实 `mtimeMs`，挑选时间最邻近与最新的前 20 个候选，再读取各自 `state.json` 与 `wire.jsonl` 头（`16 KB`）/尾（`12 KB`）进行综合打分。
  2. **Tier 2/3（无索引兜底）**：优先匹配工作区 MD5 哈希或 `wd_<basename>_*` 项目目录，再对子目录按真实 `wire.jsonl` 的 `mtimeMs` 排序（避开 120 个目录截断及 UUID 字母序排序陷阱）。
- **配置窗口解析（`parseKimiConfigToml`）**：
  - 直接从所属 `.kimi-code/config.toml`（带 `mtimeMs + size` 缓存）解析顶级 `default_model` 与各 `[models."<name>"]` 区块内的 `max_context_size`（例如 `kimi-code/k3.1-pro`、`kimi-code/kimi-for-coding` 的 `1048576` 与 `kimi-code/k3-256k`、`kimi-for-coding-highspeed` 的 `262144`）。
- **日志 Schema**：
  - 提取模型来源：`payload.model`、`payload.request.model`、`obj.model` 之外，还兼容 `profile.bind` / `llm.request` 中的 `modelAlias`，以及 `llm.request` 内的 `maxTokens`（`>= 32_768` 时记作 `contextWindow`）。
  - 现代 Wire：仅聚合 `type === 'usage.record'` 且 `usageScope === 'turn'`（缺失时允许）的记录，跳过 `usageScope === 'session'` 汇总防重复累加；同时消费 `token_counting.measured` / `token_counting.turn_recorded` 辅助追踪最新上下文占比与压缩。
  - 旧版 CLI（`StatusUpdate`）：读取 `context_usage` 比例（`contextRatioOverride`）并对单调递增的 `token_usage` 累积计数器做差值核算。

### 3. Codex（[src/adapters/codex.ts](../src/adapters/codex.ts)）

- **检索路径**：扫描 `<home>/.codex/sessions/**/rollout-*.jsonl`。由于 Codex 首行 `session_meta` 常携带超过 `64 KB` 的超长 `base_instructions` 导致完整 JSON 行被截断，插件每次读取头部 **`65_536` 字节**，若整行 `JSON.parse` 失败，则通过 `extractCodexHeadCwd` 正则回退解析 `"cwd"` 字段。
- **日志 Schema 与去重**：
  - 提取 `session_meta` / `turn_context` 的 `model`，并在 `turn_context` / `user_message` / `agent_reasoning` 更新请求锚点 `lastTurnAnchorMs`。
  - 对 `event_msg` (`type === 'token_count'`)：Codex 在周期性更新 `rate_limits` 时会原样重发同一组 `total_token_usage`；插件利用总数与最后用量的签名键 `lastUsageKey` 对连续完全相同的事件直接去重。
  - 按 `info.model_context_window` 设置上下文上限；按 `info.last_usage_includes_reasoning`（默认 `true`）控制 `reasoning_output_tokens` 是否已包含于 `output_tokens`，并使用 `cumulativeOverride` 对齐文件内权威累积总值。

### 4. Antigravity（[src/adapters/agy.ts](../src/adapters/agy.ts)）

- **检索路径**：依次检索 `<home>/.gemini/{antigravity-cli,antigravity,antigravity-chat/antigravity-acp}/`，优先按 `sessionId` 匹配 `brain/<id>/.system_generated/logs/transcript.jsonl`，其次经由 `history.jsonl`（匹配 `workspace`、`display`、`timestamp`）定位 `conversationId`，最后在 `.system_generated` 下按时间邻近回退。
- **日志 Schema**：
  - 通过 `step_index` 严格去重。
  - 解析 `PLANNER_RESPONSE` / `source === 'MODEL'` 的用量记录，处理厂商计数差异：Anthropic 模型（`/claude/i`）的 `input_tokens` **不含**缓存，因此 `contextUsed = input_tokens + cache_read_tokens + output_tokens`；Gemini 模型的 `input_tokens` **已包含**缓存读取部分，因此 `inputUncached = max(0, input_tokens - cache_read_tokens)`、`contextUsed = input_tokens + output_tokens`。
  - 当单条记录 `created_at` 与观测时间差在 `(200ms, 600s]` 之外时，等待下一步的 `created_at` 自动修正前一步的 `durationMs`。

### 5. Cursor（[src/adapters/cursor.ts](../src/adapters/cursor.ts), [src/helpers/cursor-hook.ts](../src/helpers/cursor-hook.ts)）

- **模式 A — Cursor Hook 精确统计**（推荐，需开启开关）：
  - 启动及工作区切换时（当设置为启用状态），自动在目标环境的 `~/.orca-telemetry/cursor-hook.mjs` 落盘无外部依赖的 Node 脚本，并与 `~/.cursor/hooks.json` 的 `beforeSubmitPrompt` / `stop` 安全合并（识别 `.orca-telemetry/cursor-hook.mjs` 标记，绝不篡改用户自定义的其他 Hook）。在 WSL 下会自动探测 Linux 侧 `node` 二进制绝对路径。
  - **关键协议**：`beforeSubmitPrompt` 必须向标准输出打印 `{"continue":true}\n`，否则 Cursor 将拒绝提交用户提问；`stop` 钩子输出 `{}\n`。
  - `ingestCursorHookLine` 消费 `~/.orca-telemetry/cursor-usage.jsonl`，按 `generation_id` 对 `stop` 与 `afterAgentResponse` 去重，并按 Cursor 口径从 `input_tokens` 中扣除 `cache_read_tokens + cache_write_tokens` 得到未缓存输入。
- **模式 B — Transcript 估算兜底**（未启用 Hook 或无 Hook 数据）：
  - 查找 `<home>/.cursor/projects/<slug>/agent-transcripts/` 下的 `.jsonl`（Slug 同时兼容保留原始大小写和全小写格式），统计可见文本与工具参数字符总长度按 `chars / 3.8` 估算上下文占用，并在可能时叠加 `orcaSession.totalTokens` 总量。

### 6. 通用兜底（[src/adapters/fallback.ts](../src/adapters/fallback.ts)）

当没有任何本地日志文件命中时，使用 `ctx.orcaSession` 生成 `source: 'orca-session'` 或 `'none'` 的结果，保留总 Token、消息轮数与当前 Agent 家族的默认上下文窗口，面板状态清晰标注来源，避免盲目报错或显示误导数值。

---

## 模型窗口解析与成本估算（[src/adapters/model-windows.ts](../src/adapters/model-windows.ts)）

### 上下文窗口优先级

`resolveContextWindow(model, agentKind, overrides, explicitWindow)` 按由高到低的顺序解析上限：

1. **显式插件设置覆盖 (`ctx.modelOverrides`)**：来自插件设置 `contextWindowOverride`。
2. **适配器级实测/配置文件值 (`explicitWindow`)**：如 Codex `model_context_window`、Claude `settings.json`、Kimi `config.toml` / `maxTokens`（注：Kimi Adapter 在未设置对应模型的用户 `contextWindowOverride` 时也会将 `config.toml` 配置注入覆盖表以确保生效）。
3. **内置模型正则表 (`DEFAULT_MODEL_TABLE`)**：从上到下首次命中生效，涵盖 Codex/GPT-5、OpenAI o 系列、Claude 4.x/Fable、Gemini 3/4/Pro/Flash、Kimi（先匹配 `256k` / `highspeed` / `k2` 为 `262_144`，再匹配 `k3` / `kimi-for-coding` 为 `1_048_576`）、DeepSeek V4（`1_000_000`）等。
4. **Provider 兜底默认值**：`claude -> 200_000`、`codex -> 258_400`、`kimi -> 1_048_576`、`antigravity -> 1_000_000`、`cursor -> 200_000`。

> **维护提示**：向 `DEFAULT_MODEL_TABLE` 新增规则时，务必把**更具体/特殊后缀**（如 `-highspeed`、`-256k`、`-1m`）写在**宽泛家族正则**之前。

---

## 扩展指南：如何新增一个 Agent 适配器

以接入一个假设名为 `acme` 的新 CLI Agent 为例，完整步骤如下：

1. **扩展协议类型（[src/protocol.ts](../src/protocol.ts)）**：
   - 将新来源字面量（如 `'acme-jsonl'`）加入 `TelemetrySource` 联合类型。
2. **补充模型窗口与单价（[src/adapters/model-windows.ts](../src/adapters/model-windows.ts)）**：
   - 在 `DEFAULT_MODEL_TABLE` 与 `resolveContextWindow` 的 `switch (agentKind.toLowerCase())` 分支补充默认上下文窗口与千/百万 Token 定价。
3. **新建适配器（`src/adapters/acme.ts`）**：
   - 导出 `createAcmeState()`、`ingestAcmeLine(line, state, observedAtMs)`（纯函数，方便离线单测）和 `AcmeAdapter` 类（持有 `JsonlTailer` 与置信缓存 `pathByAgentKey`）。
   - 使用 `ctx.homeRoots` 遍历 WSL 与本地用户目录，使用 `fs-lookup.ts` 提供的 `agentActivityTimestamp`、`buildPromptSnippet`、`buildWorkspacePathSet`、`findMatchingFiles` 处理 Native Chat 归因；仅在强匹配或 `<= 120_000 ms` 时间匹配时固化 `pathByAgentKey`。
   - 确认新工具的 `reasoning` 与 `cache_read` 是否已经包含在总输入/输出字段中，正确设置 `reasoningIncludedInOutput`。
4. **接入 Worker 分发与前端徽章（[src/worker.ts](../src/worker.ts) & [panel/index.html](../panel/index.html)）**：
   - 在 `src/worker.ts` 实例化 `AcmeAdapter` 并在 `collectAgentTelemetry` 的 `switch` 中分发匹配（如 `'acme'`）。
   - 如需特定会话 Pill 配色或提示文案，在 `panel/index.html` 中核对展示逻辑；未特殊指定时界面会自动回退显示标准中性标签与 `sourceLabel`。
5. **编写测试并更新文档（[src/adapters.test.ts](../src/adapters.test.ts) & [README.md](../README.md)）**：
   - 覆盖“行解析与去重”、“Native Chat 跨 UUID 归因（WSL UNC + `cwd` + `promptHint`）”两类测试。
   - 运行 `orca plugin test .` 与 `orca plugin validate .` 验证通过后更新文档列表。
