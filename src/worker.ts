import type { OrcaWorkerApi } from 'orca/worker'
import { AgyAdapter } from './adapters/agy'
import { ClaudeAdapter } from './adapters/claude'
import { CodexAdapter } from './adapters/codex'
import { CursorAdapter } from './adapters/cursor'
import { buildFallbackTelemetry } from './adapters/fallback'
import { KimiAdapter } from './adapters/kimi'
import { parseModelWindowOverrides } from './adapters/model-windows'
import type { AdapterContext, AdapterResult } from './adapters/types'
import { GitCollector } from './collectors/git'
import { OrcaContextCollector, type OrcaSessionSummary } from './collectors/orca-context'
import { WslEnvironmentResolver } from './collectors/wsl-env'
import { computeMetrics, type PromptTimingHint } from './engine/metrics'
import { CursorHookManager } from './helpers/cursor-hook'
import { TelemetryLogger } from './logger'
import type {
  AgentOption,
  PluginDisplaySettings,
  TelemetrySnapshot
} from './protocol'

const STATUS_BAR_ID = 'telemetry'
const ACTIVE_POLL_MIN_MS = 1000
const ACTIVE_POLL_MAX_MS = 10_000
const IDLE_POLL_MS = 8000

let activeCleanup: (() => void) | null = null

export function deactivate(): void {
  activeCleanup?.()
  activeCleanup = null
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  deactivate()

  const logger = new TelemetryLogger({
    sink: (msg) => orca.log(msg)
  })
  const wslEnv = new WslEnvironmentResolver({ logger })
  const orcaCollector = new OrcaContextCollector({ logger })
  const gitCollector = new GitCollector({ logger })
  const cursorHook = new CursorHookManager()

  const codexAdapter = new CodexAdapter()
  const claudeAdapter = new ClaudeAdapter()
  const kimiAdapter = new KimiAdapter()
  const agyAdapter = new AgyAdapter()
  const cursorAdapter = new CursorAdapter()

  let pinnedAgentKey: string | null = null
  let panelVisible = false
  let lastCursorHookEventAt: number | null = null
  let latestSnapshot: TelemetrySnapshot | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let inFlightRefresh: Promise<TelemetrySnapshot> | null = null
  let disposed = false

  const promptTimings = new Map<string, PromptTimingHint>()
  const autoSyncedHookPaths = new Set<string>()

  logger.info('worker', `Activated (Host API ${orca.api.major}.${orca.api.minor})`)

  const readSettings = async (): Promise<{
    display: PluginDisplaySettings
    refreshIntervalMs: number
    modelOverrides: Record<string, number>
  }> => {
    try {
      const raw = await orca.settings.get()
      const showStatusBar = typeof raw.showStatusBar === 'boolean' ? raw.showStatusBar : true
      const showEstimatedCost =
        typeof raw.showEstimatedCost === 'boolean' ? raw.showEstimatedCost : true
      const cursorHookEnabled =
        typeof raw.cursorHookEnabled === 'boolean' ? raw.cursorHookEnabled : false
      const intervalNum =
        typeof raw.refreshIntervalMs === 'number' && Number.isFinite(raw.refreshIntervalMs)
          ? raw.refreshIntervalMs
          : 2000
      const refreshIntervalMs = Math.min(
        ACTIVE_POLL_MAX_MS,
        Math.max(ACTIVE_POLL_MIN_MS, Math.round(intervalNum))
      )
      const overrideStr =
        typeof raw.contextWindowOverride === 'string' ? raw.contextWindowOverride : ''
      return {
        display: { showStatusBar, showEstimatedCost, cursorHookEnabled },
        refreshIntervalMs,
        modelOverrides: parseModelWindowOverrides(overrideStr)
      }
    } catch {
      return {
        display: { showStatusBar: true, showEstimatedCost: true, cursorHookEnabled: false },
        refreshIntervalMs: 2000,
        modelOverrides: {}
      }
    }
  }

  const pickActiveAgent = (agents: AgentOption[]): AgentOption | null => {
    if (agents.length === 0) {
      pinnedAgentKey = null
      return null
    }
    if (pinnedAgentKey) {
      const exact = agents.find((a) => a.key === pinnedAgentKey)
      if (exact) return exact
      // Clear manual pin if that agent closed or belongs to another workspace.
      pinnedAgentKey = null
    }
    // Auto-follow mode: `agents` are sorted newest-first (`updatedAt` / `stateStartedAt`).
    // Prefer a currently working agent if recent (or when top agent is already done).
    const newest = agents[0]
    if (newest.state === 'working') return newest
    const working = agents.find((a) => a.state === 'working')
    if (working) {
      const newestAt = Math.max(newest.updatedAt ?? 0, newest.stateStartedAt)
      const workingAt = Math.max(working.updatedAt ?? 0, working.stateStartedAt)
      if (newest.state === 'done' || newestAt - workingAt <= 600_000) return working
    }
    return newest
  }

  const matchOrcaSession = (
    agent: AgentOption | null,
    sessions: OrcaSessionSummary[]
  ): OrcaSessionSummary | null => {
    if (!agent || sessions.length === 0) return null
    if (agent.sessionId) {
      const byId = sessions.find((s) => s.sessionId === agent.sessionId)
      if (byId) return byId
    }
    const lowerAgent = agent.agent.toLowerCase()
    const sameAgent = sessions.filter((s) => s.agent.toLowerCase() === lowerAgent)
    if (sameAgent.length === 0) return null
    if (agent.title) {
      const byTitle = sameAgent.find((s) => s.title && agent.title && s.title === agent.title)
      if (byTitle) return byTitle
    }
    const targetMs = Math.max(agent.updatedAt ?? 0, agent.stateStartedAt)
    if (targetMs > 0) {
      const sorted = [...sameAgent].sort(
        (a, b) => Math.abs(a.updatedAt - targetMs) - Math.abs(b.updatedAt - targetMs)
      )
      return sorted[0] ?? null
    }
    return sameAgent.find((s) => s.running) ?? sameAgent[0] ?? null
  }

  const runAdapter = async (
    agent: AgentOption | null,
    ctxBase: Omit<AdapterContext, 'agent' | 'orcaSession' | 'logger'>,
    sessions: OrcaSessionSummary[]
  ): Promise<AdapterResult> => {
    if (!agent) {
      return {
        source: 'none',
        sourceLabel: 'No Active Agent',
        logPath: null,
        model: null,
        contextUsed: null,
        contextLimit: null,
        contextIsEstimated: false,
        compactedDetected: false,
        turns: [],
        recentTools: []
      }
    }

    const orcaSession = matchOrcaSession(agent, sessions)
    const adapterCtx: AdapterContext = {
      ...ctxBase,
      agent,
      orcaSession,
      logger
    }

    const kind = agent.agent.toLowerCase()
    if (kind.includes('codex')) {
      const res = await codexAdapter.collect(adapterCtx)
      if (res) return res
    } else if (kind.includes('claude')) {
      const res = await claudeAdapter.collect(adapterCtx)
      if (res) return res
    } else if (kind.includes('kimi')) {
      const res = await kimiAdapter.collect(adapterCtx)
      if (res) return res
    } else if (kind.includes('antigravity') || kind === 'agy') {
      const res = await agyAdapter.collect(adapterCtx)
      if (res) return res
    } else if (kind.includes('cursor')) {
      const cursorRes = await cursorAdapter.collect(adapterCtx)
      if (cursorRes.lastHookEventAt !== null) {
        lastCursorHookEventAt = cursorRes.lastHookEventAt
      }
      if (cursorRes.result) return cursorRes.result
    }

    return buildFallbackTelemetry(adapterCtx)
  }

  const updateStatusBar = async (snapshot: TelemetrySnapshot): Promise<void> => {
    if (!orca.host.has('statusBar.update')) return
    try {
      if (!snapshot.settings.showStatusBar) {
        await orca.host.call('statusBar.update', { id: STATUS_BAR_ID, visible: false })
        return
      }

      const parts: string[] = []
      if (snapshot.activeAgent) {
        const agentName = snapshot.activeAgent.agent
        const ctxPct =
          snapshot.context.percent !== null
            ? `${snapshot.context.isEstimated ? '~' : ''}${Math.round(snapshot.context.percent)}%`
            : '--'
        parts.push(`${agentName} ${ctxPct}`)

        const tokSpeed = snapshot.speed.rollingTokPerSec ?? snapshot.speed.turnTokPerSec
        if (tokSpeed !== null) {
          parts.push(`${tokSpeed} tok/s`)
        } else if (snapshot.tokens.total > 0) {
          parts.push(`${formatCompactTokens(snapshot.tokens.total)} tok`)
        }
      }

      if (snapshot.git.branch) {
        const ab =
          snapshot.git.ahead > 0 || snapshot.git.behind > 0
            ? ` ↑${snapshot.git.ahead}↓${snapshot.git.behind}`
            : ''
        parts.push(`${snapshot.git.branch}${ab}`)
      }

      const text = parts.length > 0 ? parts.join(' · ') : 'Telemetry'
      const pct = snapshot.context.percent ?? 0
      const tone =
        pct >= 85
          ? 'danger'
          : pct >= 70
            ? 'warning'
            : snapshot.activeAgent?.state === 'working'
              ? 'accent'
              : 'neutral'

      const tooltipLines = [
        `Workspace: ${snapshot.workspace.displayName} (${snapshot.workspace.hostKind.toUpperCase()})`,
        snapshot.activeAgent
          ? `Agent: ${snapshot.activeAgent.agent} [${snapshot.activeAgent.state}] (${snapshot.sourceLabel})`
          : 'Agent: none',
        snapshot.context.usedTokens !== null
          ? `Context: ${formatCompactTokens(snapshot.context.usedTokens)} / ${formatCompactTokens(snapshot.context.limitTokens ?? 0)}`
          : 'Context: unavailable',
        `Tokens: ${formatCompactTokens(snapshot.tokens.total)} total`
      ]

      await orca.host.call('statusBar.update', {
        id: STATUS_BAR_ID,
        text,
        icon: 'activity',
        tone,
        tooltip: tooltipLines.join('\n'),
        visible: true
      })
    } catch {
      // Status bar may not be available in headless test hosts.
    }
  }

  const refresh = async (options?: { force?: boolean }): Promise<TelemetrySnapshot> => {
    if (inFlightRefresh && !options?.force) {
      return inFlightRefresh
    }

    const work = (async (): Promise<TelemetrySnapshot> => {
      const cfg = await readSettings()
      const orcaCtx = await orcaCollector.collect(orca, wslEnv, {
        forceSessions: options?.force ?? false
      })

      const activeAgent = pickActiveAgent(orcaCtx.agents)

      const [homeRoots, git] = await Promise.all([
        wslEnv.getHomeSearchRoots(orcaCtx.workspace),
        gitCollector.collect(orcaCtx.workspace, orcaCtx.branch, wslEnv, options?.force ?? false)
      ])

      const adapter = await runAdapter(
        activeAgent,
        {
          workspace: orcaCtx.workspace,
          homeRoots,
          cursorHookEnabled: cfg.display.cursorHookEnabled,
          modelOverrides: cfg.modelOverrides
        },
        orcaCtx.sessions
      )

      const timingHint =
        activeAgent?.terminalId ? promptTimings.get(activeAgent.terminalId) ?? null : null
      const metrics = computeMetrics({
        adapter,
        showEstimatedCost: cfg.display.showEstimatedCost,
        timingHint
      })

      let hookStatus = await cursorHook.inspectStatus(
        cfg.display.cursorHookEnabled,
        orcaCtx.workspace,
        wslEnv,
        lastCursorHookEventAt
      )
      // If Cursor hook is already enabled in settings and the resolved WSL/local target doesn't have
      // our hook yet (e.g. first boot into WSL after toggling on Windows), auto-sync once per target path.
      if (
        cfg.display.cursorHookEnabled &&
        !hookStatus.installed &&
        !hookStatus.error &&
        hookStatus.hooksJsonPath &&
        (orcaCtx.workspace.hostKind === 'wsl' || orcaCtx.workspace.hostKind === 'local') &&
        !autoSyncedHookPaths.has(hookStatus.hooksJsonPath)
      ) {
        autoSyncedHookPaths.add(hookStatus.hooksJsonPath)
        hookStatus = await cursorHook.applyToggle(true, orcaCtx.workspace, wslEnv, lastCursorHookEventAt)
        logger.info(
          'cursor-hook',
          `Auto-synced Cursor hook (${hookStatus.targetEnv}, installed=${hookStatus.installed}${hookStatus.error ? `, error=${hookStatus.error}` : ''})`
        )
      }

      const snapshot: TelemetrySnapshot = {
        updatedAt: Date.now(),
        workspace: orcaCtx.workspace,
        agents: orcaCtx.agents,
        selectedAgentKey: activeAgent?.key ?? null,
        pinnedAgentKey,
        activeAgent,
        source: adapter.source,
        sourceLabel: adapter.sourceLabel,
        logPath: adapter.logPath,
        context: metrics.context,
        tokens: metrics.tokens,
        speed: metrics.speed,
        recentTools: adapter.recentTools,
        git,
        cursorHook: hookStatus,
        settings: cfg.display,
        diagnostics: logger.getRecent(15)
      }

      latestSnapshot = snapshot
      await updateStatusBar(snapshot)
      orca.panels.post('telemetry.updated', snapshot)
      scheduleNextPoll(snapshot, cfg.refreshIntervalMs)
      return snapshot
    })()

    inFlightRefresh = work
    try {
      return await work
    } finally {
      if (inFlightRefresh === work) {
        inFlightRefresh = null
      }
    }
  }

  const scheduleNextPoll = (snapshot: TelemetrySnapshot | null, activeMs: number): void => {
    if (disposed) return
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    const shouldPoll = panelVisible || (snapshot?.settings.showStatusBar ?? true)
    if (!shouldPoll) return

    const hasWorkingAgent = snapshot?.agents.some((a) => a.state === 'working') ?? false
    const delay = hasWorkingAgent ? activeMs : IDLE_POLL_MS
    refreshTimer = setTimeout(() => {
      if (!disposed) {
        void refresh()
      }
    }, delay)
    ;(refreshTimer as { unref?: () => void }).unref?.()
  }

  const scheduleDebouncedRefresh = (force = false): void => {
    if (disposed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (!disposed) void refresh({ force })
    }, 150)
  }

  const disposables = [
    orca.events.on('workspace.changed', () => {
      pinnedAgentKey = null
      scheduleDebouncedRefresh(true)
    }),
    orca.events.on('workspace.created', () => {
      scheduleDebouncedRefresh(true)
    }),
    orca.events.on('workspace.removed', () => {
      scheduleDebouncedRefresh(true)
    }),
    orca.events.on('agent.status.changed', (payload) => {
      if (payload.terminalId) {
        const now = payload.receivedAt || Date.now()
        const existing = promptTimings.get(payload.terminalId)
        if (payload.state === 'blocked' || payload.state === 'waiting') {
          if (existing && existing.blockedStartedAtMs === null) {
            existing.blockedStartedAtMs = now
          }
        } else if (payload.state === 'working') {
          if (existing && existing.blockedStartedAtMs !== null) {
            existing.blockedAccumMs += Math.max(0, now - existing.blockedStartedAtMs)
            existing.blockedStartedAtMs = null
          } else if (!existing) {
            promptTimings.set(payload.terminalId, {
              lastPromptAtMs: payload.mainAgent?.stateStartedAt ?? now,
              blockedAccumMs: 0,
              blockedStartedAtMs: null
            })
          }
        }
      }
      scheduleDebouncedRefresh(payload.state === 'done')
    }),
    orca.hooks.on('agent.prompt.before', (event, next) => {
      promptTimings.set(event.terminalId, {
        lastPromptAtMs: Date.now(),
        blockedAccumMs: 0,
        blockedStartedAtMs: null
      })
      return next(event)
    }),
    orca.hooks.on('agent.tool.after', (event, next) => {
      scheduleDebouncedRefresh(false)
      return next(event)
    }),
    orca.settings.onDidChange(() => {
      scheduleDebouncedRefresh(true)
    }),
    orca.panels.handle('telemetry.getSnapshot', async (input) => {
      if (input?.selectedAgentKey === '__auto__') {
        pinnedAgentKey = null
      } else if (input?.selectedAgentKey) {
        pinnedAgentKey = input.selectedAgentKey
      }
      if (!input?.forceRefresh && latestSnapshot && Date.now() - latestSnapshot.updatedAt < 500) {
        return latestSnapshot
      }
      return refresh({ force: input?.forceRefresh ?? false })
    }),
    orca.panels.handle('telemetry.selectAgent', async ({ agentKey }) => {
      pinnedAgentKey = agentKey === '__auto__' ? null : agentKey
      return refresh({ force: true })
    }),
    orca.panels.handle('telemetry.setPanelVisible', async ({ visible }) => {
      panelVisible = visible
      if (visible) {
        scheduleDebouncedRefresh(false)
      } else {
        const cfg = await readSettings()
        scheduleNextPoll(latestSnapshot, cfg.refreshIntervalMs)
      }
      return { ok: true }
    }),
    orca.panels.handle('telemetry.toggleCursorHook', async ({ enabled }) => {
      await orca.settings.set('cursorHookEnabled', enabled)
      const currentWs = latestSnapshot?.workspace ?? (await orcaCollector.collect(orca, wslEnv)).workspace
      const status = await cursorHook.applyToggle(enabled, currentWs, wslEnv, lastCursorHookEventAt)
      logger.info(
        'cursor-hook',
        `Cursor hook ${enabled ? 'enabled' : 'disabled'} (${status.targetEnv}, installed=${status.installed}${status.error ? `, error=${status.error}` : ''})`
      )
      return refresh({ force: true })
    }),
    orca.panels.handle('telemetry.updateSettings', async (input) => {
      if (typeof input.showStatusBar === 'boolean') {
        await orca.settings.set('showStatusBar', input.showStatusBar)
      }
      if (typeof input.showEstimatedCost === 'boolean') {
        await orca.settings.set('showEstimatedCost', input.showEstimatedCost)
      }
      return refresh({ force: true })
    })
  ]

  activeCleanup = () => {
    disposed = true
    if (refreshTimer) clearTimeout(refreshTimer)
    if (debounceTimer) clearTimeout(debounceTimer)
    refreshTimer = null
    debounceTimer = null
    for (const d of disposables) {
      d.dispose()
    }
    void logger.flush()
  }

  try {
    const cfg = await readSettings()
    if (cfg.display.showStatusBar) {
      await refresh({ force: false })
    }
  } catch (error) {
    logger.warn('worker', `Initial refresh warning: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
