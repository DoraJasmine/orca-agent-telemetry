import type { AdapterContext, AdapterResult } from './types'
import { resolveContextWindow } from './model-windows'

/** Fallback adapter backed by Orca's `agent.listSessions` when no local log format is available. */
export function buildFallbackTelemetry(ctx: AdapterContext): AdapterResult {
  const session = ctx.orcaSession
  const totalTokens = session?.totalTokens ?? 0
  const messageCount = session?.messageCount ?? 0
  const contextLimit = resolveContextWindow(null, ctx.agent.agent, ctx.modelOverrides)

  return {
    source: session ? 'orca-session' : 'none',
    sourceLabel: session ? 'Orca Session' : 'Status Only',
    logPath: null,
    model: null,
    contextUsed: null,
    contextLimit,
    contextIsEstimated: false,
    compactedDetected: false,
    tokensAvailable: totalTokens > 0,
    turns: [],
    cumulativeOverride: session
      ? {
          total: totalTokens,
          turnCount: messageCount
        }
      : null,
    recentTools: []
  }
}
