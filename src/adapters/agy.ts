import * as path from 'node:path'
import type { ToolCount } from '../protocol'
import { fileExists, findMatchingFiles } from './fs-lookup'
import { resolveContextWindow } from './model-windows'
import { JsonlTailer, parseIsoTimestampMs, safeJsonParse } from './tailer'
import type { AdapterContext, AdapterResult, ParsedTurn } from './types'

export type AgyParseState = {
  model: string | null
  lastContextUsed: number | null
  compactedDetected: boolean
  seenSteps: Set<number>
  lastStepAtMs: number | null
  turns: ParsedTurn[]
  tools: Map<string, ToolCount>
}

export function createAgyState(): AgyParseState {
  return {
    model: null,
    lastContextUsed: null,
    compactedDetected: false,
    seenSteps: new Set(),
    lastStepAtMs: null,
    turns: [],
    tools: new Map()
  }
}

export function ingestAgyLine(line: string, state: AgyParseState, observedAtMs: number): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  const stepIndex = typeof obj.step_index === 'number' ? obj.step_index : null
  if (stepIndex !== null) {
    if (state.seenSteps.has(stepIndex)) return
    state.seenSteps.add(stepIndex)
  }

  const ts = parseIsoTimestampMs(obj.created_at) ?? observedAtMs
  const type = typeof obj.type === 'string' ? obj.type : ''
  const source = typeof obj.source === 'string' ? obj.source : ''

  // If the previous planner turn had no explicit end timestamp yet, refine duration using this step's created_at.
  if (state.turns.length > 0) {
    const prevTurn = state.turns[state.turns.length - 1]
    if (
      prevTurn.durationMs === null &&
      prevTurn.timestampMs !== null &&
      ts > prevTurn.timestampMs &&
      ts - prevTurn.timestampMs <= 600_000
    ) {
      prevTurn.durationMs = ts - prevTurn.timestampMs
    }
  }

  if (typeof obj.model === 'string' && obj.model.length > 0) {
    state.model = obj.model
  }

  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      if (tc && typeof tc === 'object' && typeof (tc as { name?: unknown }).name === 'string') {
        const name = (tc as { name: string }).name
        const prev = state.tools.get(name)
        state.tools.set(name, { name, count: (prev?.count ?? 0) + 1, lastAt: ts })
      }
    }
  }

  const hasUsage =
    typeof obj.input_tokens === 'number' ||
    typeof obj.output_tokens === 'number' ||
    typeof obj.cache_read_tokens === 'number'

  if ((type === 'PLANNER_RESPONSE' || source === 'MODEL') && hasUsage) {
    const rawInput = readNumber(obj.input_tokens)
    const cacheRead = readNumber(obj.cache_read_tokens)
    const output = readNumber(obj.output_tokens)
    const thinking = readNumber(obj.thinking_tokens)
    const model = state.model

    // Anthropic models report non-cached input separately; Gemini reports cached tokens inside prompt/input_tokens.
    const isAnthropic = model ? /claude/i.test(model) : false
    const inputUncached = isAnthropic ? rawInput : Math.max(0, rawInput - cacheRead)
    const contextUsed = isAnthropic
      ? rawInput + cacheRead + output
      : rawInput + output

    if (
      contextUsed > 0 &&
      state.lastContextUsed !== null &&
      state.lastContextUsed > 20_000 &&
      contextUsed < state.lastContextUsed * 0.6
    ) {
      state.compactedDetected = true
    }
    if (contextUsed > 0) state.lastContextUsed = contextUsed

    // During live tailing, `observedAtMs` is close to completion while `created_at` marks step start.
    const liveDelta = observedAtMs - ts
    const fallbackDelta =
      state.lastStepAtMs !== null && ts > state.lastStepAtMs ? ts - state.lastStepAtMs : null
    const durationMs =
      liveDelta > 150 && liveDelta <= 120_000
        ? liveDelta
        : fallbackDelta && fallbackDelta <= 600_000
          ? fallbackDelta
          : null

    state.turns.push({
      timestampMs: ts,
      durationMs,
      model,
      inputUncached,
      output,
      reasoning: thinking,
      cacheRead,
      cacheWrite: 0,
      contextUsed: contextUsed > 0 ? contextUsed : null,
      contextLimit: null
    })
  }

  state.lastStepAtMs = ts
}

export class AgyAdapter {
  private readonly tailer = new JsonlTailer<AgyParseState>()
  private readonly pathBySession = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const logPath = await this.locateTranscriptFile(ctx)
    if (!logPath) return null

    const res = await this.tailer.readIncremental(logPath, createAgyState, ingestAgyLine)
    if (!res.exists) {
      if (ctx.agent.sessionId) this.pathBySession.delete(ctx.agent.sessionId)
      return null
    }

    const state = res.state
    const contextLimit = resolveContextWindow(state.model, 'antigravity', ctx.modelOverrides)

    return {
      source: 'agy-transcript',
      sourceLabel: 'AGY Transcript',
      logPath,
      model: state.model,
      contextUsed: state.lastContextUsed,
      contextLimit,
      contextIsEstimated: false,
      compactedDetected: state.compactedDetected,
      turns: state.turns,
      recentTools: [...state.tools.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    }
  }

  private async locateTranscriptFile(ctx: AdapterContext): Promise<string | null> {
    const sid = ctx.agent.sessionId
    if (sid) {
      const cached = this.pathBySession.get(sid)
      if (cached) return cached
    }

    const brainBases: string[] = []
    for (const root of ctx.homeRoots) {
      brainBases.push(path.join(root.homeWin, '.gemini', 'antigravity-cli', 'brain'))
      brainBases.push(path.join(root.homeWin, '.gemini', 'antigravity', 'brain'))
      brainBases.push(path.join(root.homeWin, '.gemini', 'antigravity-chat', 'antigravity-acp', 'brain'))
    }

    for (const brainDir of brainBases) {
      if (!(await fileExists(brainDir))) continue

      if (sid) {
        const direct = path.join(brainDir, sid, '.system_generated', 'logs', 'transcript.jsonl')
        if (await fileExists(direct)) {
          this.pathBySession.set(sid, direct)
          return direct
        }
      }

      if (ctx.agent.state === 'working') {
        const recent = await findMatchingFiles(
          brainDir,
          (name, fullPath) => name === 'transcript.jsonl' && fullPath.includes('.system_generated'),
          { maxDepth: 4, maxDirs: 80, descendingDirs: true }
        )
        if (recent[0] && Date.now() - recent[0].mtimeMs < 120_000) {
          return recent[0].path
        }
      }
    }

    return null
  }
}

function readNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : 0
}
