import {
  atom,
  Badge,
  Box,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  KeyValue,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  type KeyValueItem,
  type PanelContext,
  type ReadonlyAtom,
  type Tone
} from 'orca'
import type { AgentState, TelemetrySnapshot } from './protocol'

const snapshotAtom = atom<TelemetrySnapshot | null>(null)
const busyAtom = atom<boolean>(false)
const errorAtom = atom<string | null>(null)

let panelVisibleAtom: ReadonlyAtom<boolean> | null = null
let lastReportedVisibility: boolean | null = null

async function requestSnapshot(forceRefresh = false): Promise<void> {
  set(busyAtom, true)
  set(errorAtom, null)
  try {
    const snap = await plugin.request('telemetry.getSnapshot', { forceRefresh })
    set(snapshotAtom, snap)
  } catch (err) {
    set(errorAtom, err instanceof Error ? err.message : String(err))
  } finally {
    set(busyAtom, false)
  }
}

async function selectAgent(agentKey: string): Promise<void> {
  set(busyAtom, true)
  try {
    const snap = await plugin.request('telemetry.selectAgent', { agentKey })
    set(snapshotAtom, snap)
  } catch (err) {
    set(errorAtom, err instanceof Error ? err.message : String(err))
  } finally {
    set(busyAtom, false)
  }
}

async function toggleCursorHook(enabled: boolean): Promise<void> {
  set(busyAtom, true)
  try {
    const snap = await plugin.request('telemetry.toggleCursorHook', { enabled })
    set(snapshotAtom, snap)
  } catch (err) {
    set(errorAtom, err instanceof Error ? err.message : String(err))
  } finally {
    set(busyAtom, false)
  }
}

async function updateDisplaySetting(patch: {
  showStatusBar?: boolean
  showEstimatedCost?: boolean
}): Promise<void> {
  try {
    const snap = await plugin.request('telemetry.updateSettings', patch)
    set(snapshotAtom, snap)
  } catch (err) {
    set(errorAtom, err instanceof Error ? err.message : String(err))
  }
}

export function setup(ctx: PanelContext): void {
  panelVisibleAtom = ctx.visible
  lastReportedVisibility = null
  ctx.subscriptions.push(
    plugin.on('telemetry.updated', (snap) => {
      set(snapshotAtom, snap)
    })
  )
  ctx.subscriptions.push({
    dispose: () => {
      panelVisibleAtom = null
      lastReportedVisibility = false
      void plugin.request('telemetry.setPanelVisible', { visible: false }).catch(() => {})
    }
  })
  void plugin.request('telemetry.setPanelVisible', { visible: read(ctx.visible) }).catch(() => {})
  void requestSnapshot(false)
}

export default function Panel() {
  const snap = read(snapshotAtom)
  const busy = read(busyAtom)
  const errMsg = read(errorAtom)

  // Keep worker polling synchronized with Orca's sidebar visibility without mutating atoms during render.
  const isVisible = panelVisibleAtom ? read(panelVisibleAtom) : true
  if (lastReportedVisibility !== isVisible) {
    lastReportedVisibility = isVisible
    setTimeout(() => {
      void plugin.request('telemetry.setPanelVisible', { visible: isVisible }).catch(() => {})
    }, 0)
  }

  if (!snap) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={3}>Agent Telemetry</Heading>
          <IconButton
            icon="refresh"
            label="Refresh telemetry"
            size="xs"
            variant="ghost"
            onPress={() => requestSnapshot(true)}
          />
        </Row>
        {errMsg ? (
          <Callout tone="danger" title="Load Failed">
            {errMsg}
          </Callout>
        ) : (
          <Row gap="sm" align="center">
            <Spinner label="Loading telemetry" />
            <Text muted size="sm">
              Reading workspace & agent logs...
            </Text>
          </Row>
        )}
      </Stack>
    )
  }

  const wsBadgeText =
    snap.workspace.hostKind === 'wsl'
      ? `WSL · ${snap.workspace.wslDistro ?? 'Linux'}`
      : snap.workspace.hostKind === 'local'
        ? 'Local'
        : snap.workspace.hostKind === 'remote'
          ? 'SSH'
          : 'Workspace'

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={3}>Telemetry</Heading>
          <Badge tone={snap.workspace.hostKind === 'wsl' ? 'accent' : 'neutral'}>
            {wsBadgeText}
          </Badge>
        </Row>
        <IconButton
          icon="refresh"
          label="Refresh telemetry"
          size="xs"
          variant="ghost"
          disabled={busy}
          onPress={() => requestSnapshot(true)}
        />
      </Row>

      {errMsg ? (
        <Callout tone="warning" title="Refresh Notice">
          {errMsg}
        </Callout>
      ) : null}

      <AgentHeaderCard snap={snap} />
      <ContextCard snap={snap} />
      <TokensAndSpeedCard snap={snap} />
      <GitCard snap={snap} />
      <ControlsCard snap={snap} busy={busy} />
      <DiagnosticsCard snap={snap} />
    </Stack>
  )
}

function AgentHeaderCard({ snap }: { snap: TelemetrySnapshot }) {
  const active = snap.activeAgent
  if (!active) {
    return (
      <Card title={snap.workspace.displayName} description="No active agent terminal in this workspace">
        <EmptyState
          icon="bot"
          title="Waiting for an agent"
          description="Start Kimi, Cursor, Codex, or AGY in this workspace to monitor tokens & speed."
        />
      </Card>
    )
  }

  const selectOptions = snap.agents.map((a) => {
    const labelName = a.title ?? a.taskTitle ?? (a.prompt ? a.prompt.slice(0, 24) : null)
    return {
      value: a.key,
      label: `${a.agent}${labelName ? ` · ${labelName}` : ''} (${stateText(a.state)})`
    }
  })

  const subLabel = active.taskTitle ?? active.title ?? active.prompt

  return (
    <Box direction="column" gap="xs" padding="sm" border radius="md" background="card">
      {snap.agents.length > 1 ? (
        <Select
          label="Active Agent"
          labelHidden
          value={active.key}
          options={selectOptions}
          onChange={(val) => {
            void selectAgent(val)
          }}
        />
      ) : null}
      <Row justify="between" align="center" wrap>
        <Row gap="xs" align="center">
          <Badge tone={stateTone(active.state)}>{stateText(active.state)}</Badge>
          <Text size="sm" weight="semibold">
            {active.agent}
          </Text>
          {active.stateStartedAt > 0 ? (
            <RelativeTime at={active.stateStartedAt} format="duration" muted />
          ) : null}
        </Row>
        <Badge tone={snap.source === 'orca-session' || snap.source === 'cursor-transcript' ? 'warning' : 'neutral'}>
          {snap.sourceLabel}
        </Badge>
      </Row>
      {subLabel ? (
        <Text size="xs" muted truncate>
          {subLabel}
        </Text>
      ) : null}
    </Box>
  )
}

function ContextCard({ snap }: { snap: TelemetrySnapshot }) {
  const ctx = snap.context
  const pct = ctx.percent ?? 0
  const barTone: Tone = pct >= 85 ? 'danger' : pct >= 70 ? 'warning' : 'accent'

  const usageLabel =
    ctx.usedTokens !== null
      ? `${ctx.isEstimated ? '~' : ''}${formatTokens(ctx.usedTokens)} / ${
          ctx.limitTokens !== null ? formatTokens(ctx.limitTokens) : '?'
        }`
      : 'Unavailable'

  return (
    <Card title="Context Window">
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Text size="sm" weight="semibold" tone={pct >= 70 ? barTone : 'neutral'}>
            {ctx.percent !== null ? `${ctx.isEstimated ? '~' : ''}${ctx.percent.toFixed(1)}%` : '--'}
          </Text>
          <Text size="xs" muted>
            {usageLabel}
          </Text>
        </Row>
        <Progress label="Context usage" labelHidden value={ctx.percent ?? 0} />
        <Row justify="between" align="center" wrap>
          <Text size="xs" muted truncate>
            {ctx.model ? `Model: ${ctx.model}` : 'Model: unknown'}
          </Text>
          {ctx.compactedDetected ? <Badge tone="warning">Compacted</Badge> : null}
        </Row>
        {pct >= 85 ? (
          <Callout tone="danger" title="Context nearly full">
            Over 85% used — consider compacting or opening a new session.
          </Callout>
        ) : null}
      </Stack>
    </Card>
  )
}

function TokensAndSpeedCard({ snap }: { snap: TelemetrySnapshot }) {
  const { tokens, speed, settings, recentTools } = snap
  const turnSpeedText = speed.turnTokPerSec !== null ? `${speed.turnTokPerSec}` : '--'
  const rollingSpeedText = speed.rollingTokPerSec !== null ? `${speed.rollingTokPerSec}` : '--'

  const items: KeyValueItem[] = [
    { label: 'Input (New)', value: formatTokens(tokens.inputUncached) },
    { label: 'Output', value: formatTokens(tokens.output) }
  ]
  if (tokens.reasoning > 0) {
    items.push({ label: 'Reasoning', value: formatTokens(tokens.reasoning) })
  }
  items.push(
    { label: 'Cache Read', value: formatTokens(tokens.cacheRead) },
    { label: 'Cache Write', value: formatTokens(tokens.cacheWrite) },
    {
      label: 'Cache Hit',
      value: tokens.cacheHitRatePct !== null ? `${tokens.cacheHitRatePct.toFixed(1)}%` : '--'
    },
    { label: 'Turns', value: tokens.turnCount }
  )
  if (settings.showEstimatedCost) {
    items.push({
      label: 'Est. Cost',
      value: tokens.estimatedCostUsd !== null ? `$${tokens.estimatedCostUsd.toFixed(4)}` : '--'
    })
  }

  return (
    <Card title="Tokens & Speed">
      <Stack gap="sm">
        <Row gap="xs" align="stretch">
          <MetricTile label="Turn tok/s" value={turnSpeedText} />
          <MetricTile label="Rolling tok/s" value={rollingSpeedText} />
          <MetricTile label="Total" value={formatTokens(tokens.total)} />
        </Row>

        <KeyValue label="Token Breakdown" items={items} />

        {recentTools.length > 0 ? (
          <Collapsible title={`Tools (${recentTools.length})`} defaultOpen={false}>
            <Stack gap="xs">
              {recentTools.map((tool) => (
                <Row key={tool.name} justify="between" align="center">
                  <Text size="xs" truncate>
                    {tool.name}
                  </Text>
                  <Badge tone="neutral">×{tool.count}</Badge>
                </Row>
              ))}
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Card>
  )
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <Box direction="column" gap="none" padding="xs" border radius="sm" background="muted" grow>
      <Text size="xs" muted>
        {label}
      </Text>
      <Text size="sm" weight="semibold">
        {value}
      </Text>
    </Box>
  )
}

function GitCard({ snap }: { snap: TelemetrySnapshot }) {
  const { git } = snap
  const sourceLabel =
    git.source === 'wsl-git'
      ? 'WSL Git'
      : git.source === 'local-git'
        ? 'Local Git'
        : git.source === 'orca-branch'
          ? 'Branch Only'
          : 'Unavailable'

  return (
    <Card title="Git & Worktree">
      <Stack gap="xs">
        <Row justify="between" align="center" wrap>
          <Row gap="xs" align="center">
            <Text size="sm" weight="semibold" truncate>
              {git.branch ?? 'No branch'}
            </Text>
            {git.ahead > 0 || git.behind > 0 ? (
              <Badge tone="accent">{`↑${git.ahead} ↓${git.behind}`}</Badge>
            ) : null}
          </Row>
          <Badge tone="neutral">{sourceLabel}</Badge>
        </Row>

        {git.available && git.source !== 'orca-branch' ? (
          <Row justify="between" align="center">
            <Text size="xs" muted>
              {`M ${git.modified} · A ${git.added} · D ${git.deleted} · ? ${git.untracked}`}
            </Text>
            <Text size="xs" weight="medium">
              {`+${git.linesAdded} / -${git.linesDeleted}`}
            </Text>
          </Row>
        ) : null}

        {git.lastCommit ? (
          <Row justify="between" align="center" gap="xs">
            <Text size="xs" muted truncate>
              {`${git.lastCommit.hash} ${git.lastCommit.subject}`}
            </Text>
            {git.lastCommit.authoredAtMs ? (
              <RelativeTime at={git.lastCommit.authoredAtMs} format="short" muted />
            ) : null}
          </Row>
        ) : null}

        {git.error ? (
          <Text size="xs" tone="warning">
            {git.error}
          </Text>
        ) : null}

        {git.files.length > 0 ? (
          <Collapsible title={`Changed Files (${git.files.length})`} defaultOpen={false}>
            <Stack gap="xs">
              {git.files.slice(0, 25).map((f) => (
                <Row key={`${f.status}:${f.path}`} justify="between" align="center" gap="xs">
                  <Text size="xs" truncate>
                    {`${f.status} ${f.path}`}
                  </Text>
                  {f.added !== null && f.deleted !== null ? (
                    <Text size="xs" muted>
                      {`+${f.added}/-${f.deleted}`}
                    </Text>
                  ) : null}
                </Row>
              ))}
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Card>
  )
}

function ControlsCard({ snap, busy }: { snap: TelemetrySnapshot; busy: boolean }) {
  const { cursorHook, settings } = snap
  const envLabel = cursorHook.targetEnv === 'wsl' ? `WSL (${cursorHook.distro ?? 'Linux'})` : 'Windows'

  return (
    <Card title="Telemetry Controls">
      <Stack gap="xs">
        <Switch
          label="Cursor Hook 精确统计"
          checked={cursorHook.enabled}
          disabled={busy}
          onChange={(checked) => {
            void toggleCursorHook(checked)
          }}
        />
        <Text size="xs" muted>
          {cursorHook.enabled
            ? cursorHook.installed
              ? `${envLabel} 已挂载 ~/.cursor/hooks.json（按轮捕获 Token 与模型）`
              : `${envLabel} 开关已启用，正在等待写入 ~/.cursor/hooks.json`
            : '关闭中：Cursor 使用 Orca Session 汇总与对话文本估算'}
        </Text>
        {cursorHook.error ? (
          <Callout tone="warning" title="Cursor Hook 提示">
            {cursorHook.error}
          </Callout>
        ) : null}

        <Separator />

        <Switch
          label="底部状态栏显示简报"
          checked={settings.showStatusBar}
          onChange={(checked) => {
            void updateDisplaySetting({ showStatusBar: checked })
          }}
        />
        <Switch
          label="显示 API 估算费用"
          checked={settings.showEstimatedCost}
          onChange={(checked) => {
            void updateDisplaySetting({ showEstimatedCost: checked })
          }}
        />
      </Stack>
    </Card>
  )
}

function DiagnosticsCard({ snap }: { snap: TelemetrySnapshot }) {
  const wsPath = snap.workspace.linuxPath ?? snap.workspace.windowsPath ?? snap.workspace.rawPath ?? 'none'
  return (
    <Collapsible title="Diagnostics & Logs" defaultOpen={false}>
      <Stack gap="xs">
        <KeyValue
          label="Paths"
          items={[
            { label: 'Workspace', value: wsPath, code: true },
            { label: 'Log File', value: snap.logPath ?? 'none', code: true }
          ]}
        />
        {snap.diagnostics.length > 0 ? (
          <Stack gap="none">
            {snap.diagnostics.slice(-8).map((line, i) => (
              <Text key={`${i}:${line.slice(0, 24)}`} size="xs" muted truncate>
                {line}
              </Text>
            ))}
          </Stack>
        ) : (
          <Text size="xs" muted>
            No diagnostic log entries yet.
          </Text>
        )}
      </Stack>
    </Collapsible>
  )
}

function stateTone(state: AgentState): Tone {
  switch (state) {
    case 'working':
      return 'accent'
    case 'blocked':
      return 'warning'
    case 'done':
      return 'success'
    case 'waiting':
    default:
      return 'neutral'
  }
}

function stateText(state: AgentState): string {
  switch (state) {
    case 'working':
      return 'Working'
    case 'blocked':
      return 'Blocked'
    case 'done':
      return 'Done'
    case 'waiting':
    default:
      return 'Waiting'
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
