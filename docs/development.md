# 开发、测试、排障与发版指南

本文档面向仓库维护者与贡献者，覆盖本地环境搭建、日常调试、结构化日志排障以及标准发版流程。

## 开发环境要求

- **操作系统与宿主**：Windows（运行 Orca `>= 1.4.259`），可选开启 WSL2（如 `Ubuntu-22.04`）。
- **CLI 工具链**：已将 `orca` CLI 加入系统 `PATH`（通常位于 `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe`）；可通过 `orca plugin --help` 确认可用性。
- **PowerShell 脚本提示**：
  - Windows PowerShell 5.1 不支持 bash 风格的 `&&` 链接符号，连续脚本请使用换行配合 `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`。
  - 从 PowerShell 通过管道向 `wsl.exe` 传输脚本时，请清除 `\r\n`（仅保留 `\n`）以免 bash 报 `\r` 语法错误；调用独立命令尽量使用 `wsl.exe -d <distro> -- <cmd>` 并参考项目中的 `WSL_UTF8=1`。

## 日常开发与调试命令

### 1. 类型生成与静态校验

```powershell
# 生成/刷新 .orca/types/ 供编辑器与 tsc 使用（该目录已在 .gitignore 忽略）
orca plugin types "d:\OrcaPlugins\orca-agent-telemetry"

# 校验 manifest 权限、贡献点与入口路径合法性
orca plugin validate "d:\OrcaPlugins\orca-agent-telemetry" --json

# 运行宿主级加载检查
orca plugin check "d:\OrcaPlugins\orca-agent-telemetry"
```

### 2. 运行测试套件

```powershell
orca plugin test "d:\OrcaPlugins\orca-agent-telemetry"
```

当前仓库测试覆盖三大维度：
- [src/adapters.test.ts](../src/adapters.test.ts)：验证 WSL 路径与 env 还原（`buildCleanChildEnv`、`WslEnvironmentResolver`）、Git porcelain/numstat 解析、全部 5 家 Agent 解析器与流式去重、`session_index.jsonl` 墓碑与多目录 mtime 优先归因、`config.toml` / `settings.json` 窗口解析、Cursor `hooks.json` 安全合并/卸载、`JsonlTailer` 增量 UTF-8 跨块读取，以及 `TelemetryLogger` 轮转与去重。
- [src/worker.test.ts](../src/worker.test.ts)：使用 `orca/testing` 的 `mockHost` 与 `mountWorker` 模拟真实 Worker 生命周期，验证 `telemetry.getSnapshot`、`telemetry.selectAgent`（包含 `__auto__` 切换）、`agent.prompt.before` Hook 透传、`telemetry.updateSettings`，以及 Paired Environment 遭遇 `selector_not_found` 后自动回退 `environment list` + `worktree ps`。
- [src/panel.test.ts](../src/panel.test.ts)：断言 `panel/index.html` 无外链 `<script src>`/`<link href>`、正确接入 `--orca-*` 变量与 `orca.plugin.request` / `orca.on` 接口、包含会话切换胶囊与 XSS 转义 helper。

### 3. 本地热加载与实机视觉验收

```powershell
# 以开发模式挂载本地目录并自动批准权限
orca plugin dev load "d:\OrcaPlugins\orca-agent-telemetry" --approve

# 打开 Orca 面板并截图导出校验视觉渲染与真实数据
orca plugin open dorajasmine.agent-telemetry --json
orca plugin shot dorajasmine.agent-telemetry --out "panel-preview.png" --json
```

> 提示：`orca plugin shot` 输出 JSON 中的 `"errors": []` 与 `"settled": true` 可确认前端运行时无未捕获异常。

---

## 日志体系与运行时诊断（[src/logger.ts](../src/logger.ts)）

插件内置双通道日志类 `TelemetryLogger`：
1. **宿主频道**：将精简日志通过 `orca.log(...)` 输出到 Orca 插件运行日志（不转发 `DEBUG`）。
2. **本地持久化文件**：序列化写入 `%USERPROFILE%\.orca-telemetry\plugin.log`（约 `512 KB` 自动轮转为 `plugin.log.1`），并在内存保留最近 30 条供界面底部的 **Diagnostics & Logs** 直接展开查看。
3. **去重策略（`logOnce`）**：
   - `INFO` / `DEBUG`：按 `key` 记录上次内容，只要消息未变化就**永久抑制重复写入**（切换了新的 `wire.jsonl` 或工作区时会自动重新打点）。
   - `WARN` / `ERROR`：同一 `key + message` 在 `60s` 内仅输出一次，防止网络盘或缺失环境导致的持续刷屏。

查看实时日志的快捷方式：

```powershell
Get-Content "$env:USERPROFILE\.orca-telemetry\plugin.log" -Tail 40
```

---

## 常见故障排查手册（Troubleshooting）

| 现象 | 常见原因 | 排查步骤与定位方向 |
| :--- | :--- | :--- |
| 侧边栏显示 `No Workspace` 或 WSL 工作区找不到 Agent | 1. Paired WSL 工作区未在本地 `workspace.list` 返回，且调用 `orca.exe` 时被宿主剥离了 `LOCALAPPDATA`/`APPDATA` 导致 `environment list` 失败。<br>2. 目标 WSL 发行版未处于运行状态。 | 查看 `plugin.log` 中是否有 `Resolved Orca CLI binary:` 与 `Matched paired environment`。手动验证：`wsl.exe -l --running -q` 与 `orca environment list --json`。 |
| 模型名、已用上下文或总 Turn 与当前会话对不上 | CLI 会话 UUID 与 Orca `sessionId` 不一致时匹配到了历史旧会话。 | 1. 展开 UI `Diagnostics & Logs` 核对 `Log:` 命中的文件路径。<br>2. 对照各工具索引与盘上时间戳（如 WSL `~/.kimi-code/session_index.jsonl`、`~/.claude/history.jsonl`、Codex `rollout-*.jsonl` 前 64KB 内的 `cwd`）。 |
| 上下文上限与 CLI 实际配置不符 | 新模型尚未加入 `model-windows.ts` 正则表，或 CLI 配置文件未被解析。 | 1. 检查 Kimi `~/.kimi-code/config.toml` 或 Claude `~/.claude/settings.json`。<br>2. 临时通过插件设置 `contextWindowOverride` 填写 `model=tokens`（如 `my-model=1048576`）；长期修复需更新 `src/adapters/model-windows.ts`。 |
| 开启 **Cursor Hook** 后 Cursor 无法发送提问 | 自定义脚本对 `beforeSubmitPrompt` 未及时输出 `{"continue":true}`，或 WSL 内找不到 `node`。 | 查看目标环境 `~/.cursor/hooks.json` 与 `~/.orca-telemetry/cursor-hook.mjs`；确认 WSL `command -v node` 可返回有效路径，或测试 `echo '{}' \| node ~/.orca-telemetry/cursor-hook.mjs --event beforeSubmitPrompt`。 |
| 侧边栏切换工作区/会话后显示旧数据闪烁 | 旧工作区慢查询异步回写。 | 检查 `src/worker.ts` 变更是否漏掉了 `contextEpoch` 或 `selectionEpoch` 守卫比对。 |

---

## 发版流程（Release Checklist）

每次发布新版本到 GitHub 并同步本机 Orca 请按以下步骤执行：

1. **更新版本与文档**：
   - 更新 [orca-plugin.json](../orca-plugin.json) 的 `"version"`（遵循 SemVer）。
   - 同步更新 [CHANGELOG.md](../CHANGELOG.md) 以及受影响的技术文档或 `README.md`。
2. **本地回归验证**：
   ```powershell
   Set-Location "d:\OrcaPlugins\orca-agent-telemetry"
   orca plugin test .
   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
   orca plugin validate . --json
   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
   orca plugin check .
   ```
3. **提交、打标签并推送远端**：
   ```powershell
   git add -A
   git commit -m "chore: release vX.Y.Z"
   git tag vX.Y.Z
   git push origin HEAD vX.Y.Z
   ```
4. **实机升级与视觉复验**：
   ```powershell
   orca plugin update dorajasmine.agent-telemetry --json
   orca plugin open dorajasmine.agent-telemetry --json
   orca plugin shot dorajasmine.agent-telemetry --out "release_check.png" --json
   Get-Content "$env:USERPROFILE\.orca-telemetry\plugin.log" -Tail 20
   ```
   确认 `plugin.log` 命中预期的日志文件、无异常 WARN/ERROR，且 `release_check.png` 视觉排版正常。
