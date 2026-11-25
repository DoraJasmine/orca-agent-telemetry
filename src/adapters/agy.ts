import * as path from 'node:path'
import type { ToolCount } from '../protocol'
import {
  agentActivityTimestamp,
  buildPromptSnippet,
  buildWorkspacePathSet,
  fileExists,
  findMatchingFiles,
  normalizePathForCompare,
  pickClosestFileByTimestamp,
  readHeadUtf8,
  readTailUtf8
} from './fs-lookup'
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
  private readonly pathByAgentKey = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const logPath = await this.locateTranscriptFile(ctx)
    if (!logPath) {
      ctx.logger?.logOnce(
        `agy-miss:${ctx.agent.key}`,
        'INFO',
        'agy',
        `No transcript.jsonl matched for key=${ctx.agent.key} sessionId=${ctx.agent.sessionId ?? 'none'}`
      )
      return null
    }

    ctx.logger?.logOnce(`agy-hit:${ctx.agent.key}`, 'INFO', 'agy', `Using transcript: ${logPath}`)

    const res = await this.tailer.readIncremental(logPath, createAgyState, ingestAgyLine)
    if (!res.exists) {
      this.pathByAgentKey.delete(ctx.agent.key)
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
    const cacheKey = ctx.agent.key
    const cached = this.pathByAgentKey.get(cacheKey)
    if (cached) return cached

    const sid = ctx.agent.sessionId
    const targetPaths = buildWorkspacePathSet(ctx.workspace)
    const promptHint = buildPromptSnippet(ctx.agent.prompt)
    const targetMs = agentActivityTimestamp(ctx.agent)

    const bases: { baseDir: string; brainDir: string }[] = []
    for (const root of ctx.homeRoots) {
      for (const sub of ['antigravity-cli', 'antigravity', 'antigravity-chat/antigravity-acp']) {
        const baseDir = path.join(root.homeWin, '.gemini', sub)
        bases.push({ baseDir, brainDir: path.join(baseDir, 'brain') })
      }
    }

    // Tier 1: Direct sessionId match.
    if (sid) {
      for (const { brainDir } of bases) {
        const direct = path.join(brainDir, sid, '.system_generated', 'logs', 'transcript.jsonl')
        if (await fileExists(direct)) {
          this.pathByAgentKey.set(cacheKey, direct)
          return direct
        }
      }
    }

    // Tier 2: Lookup in `history.jsonl` by workspace path + prompt/timestamp (handles Orca Native Chat UUIDs).
    for (const { baseDir, brainDir } of bases) {
      const historyFile = path.join(baseDir, 'history.jsonl')
      if (!(await fileExists(historyFile))) continue
      const convId = await this.lookupInHistory(historyFile, targetPaths, promptHint, targetMs)
      if (convId) {
        const candidate = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl')
        if (await fileExists(candidate)) {
          this.pathByAgentKey.set(cacheKey, candidate)
          return candidate
        }
      }
    }

    // Tier 3: Bounded scan of recent `transcript.jsonl` matching prompt snippet or close timestamp.
    for (const { brainDir } of bases) {
      if (!(await fileExists(brainDir))) continue
      const recent = await findMatchingFiles(
        brainDir,
        (name, fullPath) => name === 'transcript.jsonl' && fullPath.includes('.system_generated'),
        { maxDepth: 4, maxDirs: 80, descendingDirs: true }
      )
      if (recent.length === 0) continue

      if (promptHint) {
        for (const f of recent.slice(0, 12)) {
          const head = await readHeadUtf8(f.path, 4096)
          if (head.includes(promptHint)) {
            this.pathByAgentKey.set(cacheKey, f.path)
            return f.path
          }
        }
      }

      if (ctx.agent.state === 'working') {
        const best = pickClosestFileByTimestamp(recent, targetMs, 15 * 60_000)
        if (best) {
          this.pathByAgentKey.set(cacheKey, best.path)
          return best.path
        }
      }
    }

    return null
  }

  private async lookupInHistory(
    historyFile: string,
    targetPaths: Set<string>,
    promptHint: string | null,
    targetMs: number
  ): Promise<string | null> {
    const tail = await readTailUtf8(historyFile, 128 * 1024)
    if (!tail) return null

    type HistoryRow = {
      display?: string
      timestamp?: number | string
      workspace?: string
      conversationId?: string
    }

    const candidates: { conversationId: string; score: number; ts: number }[] = []

    for (const line of tail.split(/\r?\n/)) {
      const row = safeJsonParse<HistoryRow>(line.trim())
      if (!row?.conversationId) continue

      const ws = normalizePathForCompare(row.workspace)
      if (targetPaths.size > 0 && ws && !targetPaths.has(ws)) continue

      const rowTs = parseIsoTimestampMs(row.timestamp) ?? 0
      let score = ws && targetPaths.has(ws) ? 20 : 1
      if (promptHint && typeof row.display === 'string' && row.display.includes(promptHint)) {
        score += 50
      }
      if (targetMs > 0 && rowTs > 0) {
        const delta = Math.abs(rowTs - targetMs)
        if (delta < 120_000) score += 25
        else if (delta < 3600_000) score += 10
      }
      candidates.push({ conversationId: row.conversationId, score, ts: rowTs })
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.ts - a.ts))
    return candidates[0].conversationId
  }
}

function readNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : 0
}
