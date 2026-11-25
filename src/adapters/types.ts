import type { AgentOption, TelemetrySource, TokenStats, ToolCount, WorkspaceEnv } from '../protocol'
import type { OrcaSessionSummary } from '../collectors/orca-context'
import type { HomeRoot } from '../collectors/wsl-env'

export type ParsedTurn = {
  timestampMs: number | null
  durationMs?: number | null
  model?: string | null
  inputUncached: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  contextUsed: number | null
  contextLimit: number | null
  contextRatioOverride?: number | null
}

export type AdapterResult = {
  source: TelemetrySource
  sourceLabel: string
  logPath: string | null
  model: string | null
  contextUsed: number | null
  contextLimit: number | null
  contextIsEstimated: boolean
  compactedDetected: boolean
  turns: ParsedTurn[]
  cumulativeOverride?: Partial<TokenStats> | null
  recentTools: ToolCount[]
}

export type AdapterContext = {
  agent: AgentOption
  workspace: WorkspaceEnv
  homeRoots: HomeRoot[]
  orcaSession: OrcaSessionSummary | null
  cursorHookEnabled: boolean
  modelOverrides: Record<string, number>
}
