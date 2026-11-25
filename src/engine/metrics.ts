import { estimateCostUsd } from '../adapters/model-windows'
import type { AdapterResult, ParsedTurn } from '../adapters/types'
import type { ContextStats, SpeedStats, TokenStats } from '../protocol'

export type PromptTimingHint = {
  lastPromptAtMs: number
  blockedAccumMs: number
  blockedStartedAtMs: number | null
}

const MIN_RELIABLE_DURATION_MS = 200
const ROLLING_WINDOW_MS = 30_000

export function computeMetrics(input: {
  adapter: AdapterResult
  showEstimatedCost: boolean
  timingHint?: PromptTimingHint | null
  nowMs?: number
}): {
  context: ContextStats
  tokens: TokenStats
  speed: SpeedStats
} {
  const { adapter, showEstimatedCost, timingHint } = input
  const nowMs = input.nowMs ?? Date.now()

  const turns = adapter.turns.map((turn, idx) => {
    if (
      idx === adapter.turns.length - 1 &&
      (turn.durationMs === null || turn.durationMs === undefined) &&
      timingHint &&
      turn.timestampMs !== null &&
      turn.timestampMs > timingHint.lastPromptAtMs
    ) {
      const blocked =
        timingHint.blockedAccumMs +
        (timingHint.blockedStartedAtMs !== null
          ? Math.max(0, turn.timestampMs - timingHint.blockedStartedAtMs)
          : 0)
      const activeMs = Math.max(0, turn.timestampMs - timingHint.lastPromptAtMs - blocked)
      if (activeMs >= MIN_RELIABLE_DURATION_MS && activeMs <= 600_000) {
        return { ...turn, durationMs: activeMs }
      }
    }
    return turn
  })

  let inputUncached = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0

  for (const t of turns) {
    inputUncached += t.inputUncached
    output += t.output
    reasoning += t.reasoning
    cacheRead += t.cacheRead
    cacheWrite += t.cacheWrite
  }

  const ov = adapter.cumulativeOverride
  if (ov) {
    if (typeof ov.inputUncached === 'number') inputUncached = ov.inputUncached
    if (typeof ov.output === 'number') output = ov.output
    if (typeof ov.reasoning === 'number') reasoning = ov.reasoning
    if (typeof ov.cacheRead === 'number') cacheRead = ov.cacheRead
    if (typeof ov.cacheWrite === 'number') cacheWrite = ov.cacheWrite
  }

  const inputTotal = ov?.inputTotal ?? inputUncached + cacheRead + cacheWrite
  const total = ov?.total ?? inputTotal + output + reasoning
  const turnCount = ov?.turnCount ?? turns.length

  const cacheDenominator = inputUncached + cacheRead + cacheWrite
  const cacheHitRatePct =
    cacheDenominator > 0 ? Math.round((cacheRead / cacheDenominator) * 1000) / 10 : null

  const estimatedCostUsd = showEstimatedCost
    ? estimateCostUsd(adapter.model, {
        inputUncached,
        output,
        reasoning,
        cacheRead,
        cacheWrite
      })
    : null

  const contextUsed = adapter.contextUsed
  const contextLimit = adapter.contextLimit
  const percent =
    contextUsed !== null && contextLimit !== null && contextLimit > 0
      ? Math.min(100, Math.round((contextUsed / contextLimit) * 1000) / 10)
      : null

  const speed = computeSpeed(turns, nowMs)

  return {
    context: {
      usedTokens: contextUsed,
      limitTokens: contextLimit,
      percent,
      isEstimated: adapter.contextIsEstimated,
      compactedDetected: adapter.compactedDetected,
      model: adapter.model
    },
    tokens: {
      inputUncached,
      inputTotal,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total,
      cacheHitRatePct,
      estimatedCostUsd,
      turnCount
    },
    speed
  }
}

function computeSpeed(turns: readonly ParsedTurn[], nowMs: number): SpeedStats {
  if (turns.length === 0) {
    return {
      turnTokPerSec: null,
      rollingTokPerSec: null,
      sessionAvgTokPerSec: null,
      lastTurnOutputTokens: null,
      lastTurnDurationMs: null
    }
  }

  const lastTurn = turns[turns.length - 1]
  const lastOut = lastTurn.output + lastTurn.reasoning
  const lastDur = lastTurn.durationMs ?? null
  const turnTokPerSec =
    lastDur !== null && lastDur >= MIN_RELIABLE_DURATION_MS && lastOut > 0
      ? round1(lastOut / (lastDur / 1000))
      : null

  let rollingOut = 0
  let rollingMs = 0
  let sessionOut = 0
  let sessionMs = 0

  const anchorMs = lastTurn.timestampMs ?? nowMs
  for (const t of turns) {
    const dur = t.durationMs ?? null
    const out = t.output + t.reasoning
    if (dur === null || dur < MIN_RELIABLE_DURATION_MS || out <= 0) continue

    sessionOut += out
    sessionMs += dur

    if (t.timestampMs !== null && anchorMs - t.timestampMs <= ROLLING_WINDOW_MS) {
      rollingOut += out
      rollingMs += dur
    }
  }

  const rollingTokPerSec =
    rollingMs >= MIN_RELIABLE_DURATION_MS && rollingOut > 0
      ? round1(rollingOut / (rollingMs / 1000))
      : turnTokPerSec

  const sessionAvgTokPerSec =
    sessionMs >= MIN_RELIABLE_DURATION_MS && sessionOut > 0
      ? round1(sessionOut / (sessionMs / 1000))
      : null

  return {
    turnTokPerSec,
    rollingTokPerSec,
    sessionAvgTokPerSec,
    lastTurnOutputTokens: lastOut > 0 ? lastOut : null,
    lastTurnDurationMs: lastDur
  }
}

function round1(val: number): number {
  return Math.round(val * 10) / 10
}
