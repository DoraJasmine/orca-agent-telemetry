import * as path from 'node:path'
import type { ToolCount } from '../protocol'
import { findMatchingFiles, normalizePathForCompare, readHeadUtf8 } from './fs-lookup'
import { resolveContextWindow } from './model-windows'
import { JsonlTailer, parseIsoTimestampMs, safeJsonParse } from './tailer'
import type { AdapterContext, AdapterResult, ParsedTurn } from './types'

type CodexTotals = {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
}

export type CodexParseState = {
  model: string | null
  contextWindow: number | null
  lastUsageKey: string | null
  lastTotal: CodexTotals | null
  lastContextUsed: number | null
  compactedDetected: boolean
  lastTurnAnchorMs: number | null
  turns: ParsedTurn[]
  tools: Map<string, ToolCount>
}

export function createCodexState(): CodexParseState {
  return {
    model: null,
    contextWindow: null,
    lastUsageKey: null,
    lastTotal: null,
    lastContextUsed: null,
    compactedDetected: false,
    lastTurnAnchorMs: null,
    turns: [],
    tools: new Map()
  }
}

export function ingestCodexLine(line: string, state: CodexParseState, observedAtMs: number): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  const ts = parseIsoTimestampMs(obj.timestamp) ?? observedAtMs
  const type = typeof obj.type === 'string' ? obj.type : ''
  const payload = asRecord(obj.payload)
  if (!payload) return

  if (type === 'session_meta' || type === 'turn_context') {
    const model = readString(payload.model) ?? readString(asRecord(payload.info)?.model)
    if (model) state.model = model
    if (type === 'turn_context') {
      state.lastTurnAnchorMs = ts
    }
    return
  }

  if (type === 'response_item') {
    const itemType = readString(payload.type)
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const name = readString(payload.name) ?? 'tool'
      recordTool(state.tools, name, ts)
    }
    return
  }

  if (type !== 'event_msg') return
  const payloadType = readString(payload.type)

  if (payloadType === 'user_message' || payloadType === 'agent_reasoning') {
    state.lastTurnAnchorMs = ts
    return
  }

  if (payloadType !== 'token_count') return
  const info = asRecord(payload.info)
  if (!info) return

  const windowSize = readNumber(info.model_context_window)
  if (windowSize > 0) {
    state.contextWindow = windowSize
  }

  const totalObj = asRecord(info.total_token_usage)
  const lastObj = asRecord(info.last_token_usage)
  if (!totalObj && !lastObj) return

  const currentTotal: CodexTotals | null = totalObj
    ? {
        input: readNumber(totalObj.input_tokens),
        cached: readNumber(totalObj.cached_input_tokens),
        output: readNumber(totalObj.output_tokens),
        reasoning: readNumber(totalObj.reasoning_output_tokens),
        total: readNumber(totalObj.total_tokens)
      }
    : null

  // Codex re-emits identical `token_count` payloads when refreshing rate limits.
  if (currentTotal) {
    const key = `${currentTotal.input}:${currentTotal.cached}:${currentTotal.output}:${currentTotal.reasoning}:${currentTotal.total}`
    if (key === state.lastUsageKey) return
    state.lastUsageKey = key
  }

  let turnInput = 0
  let turnCached = 0
  let turnOutput = 0
  let turnReasoning = 0

  if (lastObj && (readNumber(lastObj.input_tokens) > 0 || readNumber(lastObj.output_tokens) > 0)) {
    turnInput = readNumber(lastObj.input_tokens)
    turnCached = readNumber(lastObj.cached_input_tokens)
    turnOutput = readNumber(lastObj.output_tokens)
    turnReasoning = readNumber(lastObj.reasoning_output_tokens)
  } else if (currentTotal) {
    const prev = state.lastTotal ?? { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }
    turnInput = Math.max(0, currentTotal.input - prev.input)
    turnCached = Math.max(0, currentTotal.cached - prev.cached)
    turnOutput = Math.max(0, currentTotal.output - prev.output)
    turnReasoning = Math.max(0, currentTotal.reasoning - prev.reasoning)
  }

  if (currentTotal) {
    state.lastTotal = currentTotal
  }

  // In OpenAI/Codex usage objects, `cached_input_tokens` is a subset of `input_tokens`.
  const inputUncached = Math.max(0, turnInput - turnCached)
  const contextUsed = turnInput + turnOutput > 0 ? turnInput + turnOutput : null

  if (contextUsed !== null && state.lastContextUsed !== null) {
    if (state.lastContextUsed > 20_000 && contextUsed < state.lastContextUsed * 0.6) {
      state.compactedDetected = true
    }
  }
  if (contextUsed !== null) {
    state.lastContextUsed = contextUsed
  }

  const durationMs =
    state.lastTurnAnchorMs !== null && ts > state.lastTurnAnchorMs && ts - state.lastTurnAnchorMs <= 600_000
      ? ts - state.lastTurnAnchorMs
      : null
  state.lastTurnAnchorMs = ts

  state.turns.push({
    timestampMs: ts,
    durationMs,
    model: state.model,
    inputUncached,
    output: turnOutput,
    reasoning: turnReasoning,
    cacheRead: turnCached,
    cacheWrite: 0,
    contextUsed,
    contextLimit: state.contextWindow
  })
}

export class CodexAdapter {
  private readonly tailer = new JsonlTailer<CodexParseState>()
  private readonly pathBySession = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const logPath = await this.locateSessionFile(ctx)
    if (!logPath) return null

    const res = await this.tailer.readIncremental(logPath, createCodexState, ingestCodexLine)
    if (!res.exists) {
      if (ctx.agent.sessionId) this.pathBySession.delete(ctx.agent.sessionId)
      return null
    }

    const state = res.state
    const lastTurn = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null
    const contextLimit = resolveContextWindow(
      state.model,
      'codex',
      ctx.modelOverrides,
      state.contextWindow
    )

    return {
      source: 'codex-jsonl',
      sourceLabel: 'Codex JSONL',
      logPath,
      model: state.model,
      contextUsed: state.lastContextUsed ?? lastTurn?.contextUsed ?? null,
      contextLimit,
      contextIsEstimated: false,
      compactedDetected: state.compactedDetected,
      turns: state.turns,
      cumulativeOverride: state.lastTotal
        ? {
            inputUncached: Math.max(0, state.lastTotal.input - state.lastTotal.cached),
            inputTotal: state.lastTotal.input,
            output: state.lastTotal.output,
            reasoning: state.lastTotal.reasoning,
            cacheRead: state.lastTotal.cached,
            cacheWrite: 0,
            total: state.lastTotal.total
          }
        : null,
      recentTools: [...state.tools.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    }
  }

  private async locateSessionFile(ctx: AdapterContext): Promise<string | null> {
    const sid = ctx.agent.sessionId
    if (sid) {
      const cached = this.pathBySession.get(sid)
      if (cached) return cached
    }

    const targetWorkspacePaths = new Set(
      [ctx.workspace.linuxPath, ctx.workspace.windowsPath, ctx.workspace.rawPath]
        .map(normalizePathForCompare)
        .filter(Boolean)
    )

    for (const root of ctx.homeRoots) {
      const sessionsRoot = path.join(root.homeWin, '.codex', 'sessions')
      const files = await findMatchingFiles(
        sessionsRoot,
        (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
        { maxDepth: 4, maxDirs: 60, descendingDirs: true }
      )
      if (files.length === 0) continue

      if (sid) {
        const direct = files.find((f) => f.path.includes(sid))
        if (direct) {
          this.pathBySession.set(sid, direct.path)
          return direct.path
        }
        for (const candidate of files.slice(0, 20)) {
          const head = await readHeadUtf8(candidate.path, 2048)
          if (head.includes(sid)) {
            this.pathBySession.set(sid, candidate.path)
            return candidate.path
          }
        }
      }

      if (targetWorkspacePaths.size > 0) {
        for (const candidate of files.slice(0, 12)) {
          const head = await readHeadUtf8(candidate.path, 2048)
          const firstLine = head.split(/\r?\n/)[0] ?? ''
          const meta = safeJsonParse<{ payload?: { cwd?: string } }>(firstLine)
          const cwd = normalizePathForCompare(meta?.payload?.cwd)
          if (cwd && targetWorkspacePaths.has(cwd)) {
            if (sid) this.pathBySession.set(sid, candidate.path)
            return candidate.path
          }
        }
      }
    }

    return null
  }
}

function recordTool(map: Map<string, ToolCount>, name: string, at: number): void {
  const prev = map.get(name)
  map.set(name, { name, count: (prev?.count ?? 0) + 1, lastAt: at })
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : null
}

function readString(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null
}

function readNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : 0
}
