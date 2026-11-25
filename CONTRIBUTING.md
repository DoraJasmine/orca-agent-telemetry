# Contributing

感谢对 `orca-agent-telemetry` 的贡献。提交代码前，请先阅读以下工程文档：

- [系统架构与数据流](./docs/architecture.md)
- [适配器与数据源规范（含新增 Agent 指南）](./docs/adapters.md)
- [指标核算、UI 与配置规范](./docs/metrics-and-ui.md)
- [开发、测试、排障与发版指南](./docs/development.md)

## 开发约定

1. **零外链前端约束**：[panel/index.html](./panel/index.html) 必须保持完全内联（禁用外链 `<script src>` / `<link href>`），所有动态文本经 `esc()` 转义后再拼接 DOM。
2. **WSL 兼容性**：新增文件发现、路径映射或子进程调用不得依赖 `fs.watch`（9P 不稳定）或硬编码 Windows 盘符，复用 [src/collectors/wsl-env.ts](./src/collectors/wsl-env.ts) 与 [src/adapters/fs-lookup.ts](./src/adapters/fs-lookup.ts)。
3. **测试门禁**：所有逻辑改动（尤其是新适配器、正则窗口或解析字段）须在 `src/*.test.ts` 补充对应单元测试，并在提交前通过以下检查：

```powershell
orca plugin test .
orca plugin validate . --json
orca plugin check .
```
