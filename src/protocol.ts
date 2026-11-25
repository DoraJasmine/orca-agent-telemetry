// Shared panel <-> worker contract for Orca Agent Telemetry.
export {}

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type TelemetrySource =
  | 'codex-jsonl'
  | 'kimi-wire'
  | 'kimi-legacy'
  | 'agy-transcript'
  | 'cursor-hook'
  | 'cursor-transcript'
  | 'orca-session'
  | 'none'

export type WorkspaceEnv = {
  workspaceId: string | null
  displayName: string
  rawPath: string | null
  hostKind: 'local' | 'wsl' | 'remote' | 'unknown'
  wslDistro: string | null
  linuxPath: string | null
  windowsPath: string | null
}

export type ContextStats = {
  usedTokens: number | null
  limitTokens: number | null
  percent: number | null
  isEstimated: boolean
  compactedDetected: boolean
  model: string | null
}

export type TokenStats = {
  inputUncached: number
  inputTotal: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cacheHitRatePct: number | null
  estimatedCostUsd: number | null
  turnCount: number
}

export type SpeedStats = {
  turnTokPerSec: number | null
  rollingTokPerSec: number | null
  sessionAvgTokPerSec: number | null
  lastTurnOutputTokens: number | null
  lastTurnDurationMs: number | null
}

export type GitFileChange = {
  status: string
  path: string
  added: number | null
  deleted: number | null
}

export type GitSnapshot = {
  available: boolean
  source: 'wsl-git' | 'local-git' | 'orca-branch' | 'unavailable'
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  modified: number
  added: number
  deleted: number
  untracked: number
  linesAdded: number
  linesDeleted: number
  lastCommit: {
    hash: string
    subject: string
    authoredAtMs: number | null
  } | null
  files: GitFileChange[]
  error?: string
}

export type CursorHookStatus = {
  enabled: boolean
  installed: boolean
  targetEnv: 'wsl' | 'windows'
  distro: string | null
  hooksJsonPath: string | null
  spoolPath: string | null
  lastEventAt: number | null
  error?: string
}

export type AgentOption = {
  key: string
  agent: string
  title: string | null
  state: AgentState
  stateStartedAt: number
  sessionId: string | null
  terminalId: string | null
  taskTitle: string | null
}

export type ToolCount = {
  name: string
  count: number
  lastAt: number | null
}

export type PluginDisplaySettings = {
  showStatusBar: boolean
  showEstimatedCost: boolean
  cursorHookEnabled: boolean
}

export type TelemetrySnapshot = {
  updatedAt: number
  workspace: WorkspaceEnv
  agents: AgentOption[]
  selectedAgentKey: string | null
  activeAgent: AgentOption | null
  source: TelemetrySource
  sourceLabel: string
  logPath: string | null
  context: ContextStats
  tokens: TokenStats
  speed: SpeedStats
  recentTools: ToolCount[]
  git: GitSnapshot
  cursorHook: CursorHookStatus
  settings: PluginDisplaySettings
}

declare module 'orca' {
  interface PluginRequests {
    'telemetry.getSnapshot': {
      input?: { selectedAgentKey?: string; forceRefresh?: boolean }
      output: TelemetrySnapshot
    }
    'telemetry.selectAgent': {
      input: { agentKey: string }
      output: TelemetrySnapshot
    }
    'telemetry.setPanelVisible': {
      input: { visible: boolean }
      output: { ok: true }
    }
    'telemetry.toggleCursorHook': {
      input: { enabled: boolean }
      output: TelemetrySnapshot
    }
    'telemetry.updateSettings': {
      input: { showStatusBar?: boolean; showEstimatedCost?: boolean }
      output: TelemetrySnapshot
    }
  }
  interface PluginPanelEvents {
    'telemetry.updated': TelemetrySnapshot
  }
}
