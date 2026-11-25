import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { ToolCount } from '../protocol'
import { fileExists, findMatchingFiles, normalizePathForCompare } from './fs-lookup'
import { resolveContextWindow } from './model-windows'
import { JsonlTailer, parseIsoTimestampMs, safeJsonParse } from './tailer'
import type { AdapterContext, AdapterResult, ParsedTurn } from './types'

export type KimiParseState = {
  format: 'kimi-wire' | 'kimi-legacy'
  model: string | null
  contextRatioOverride: number | null
  lastContextUsed: number | null
  compactedDetected: boolean
  lastRequestAtMs: number | null
  lastLegacyCumulative: {
    inputOther: number
    output: number
    cacheRead: number
    cacheWrite: number
  } | null
  turns: ParsedTurn[]
  tools: Map<string, ToolCount>
}

export function createKimiState(): KimiParseState {
  return {
    format: 'kimi-wire',
    model: null,
    contextRatioOverride: null,
    lastContextUsed: null,
    compactedDetected: false,
    lastRequestAtMs: null,
    lastLegacyCumulative: null,
    turns: [],
    tools: new Map()
  }
}

export function ingestKimiLine(line: string, state: KimiParseState, observedAtMs: number): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  const messageObj = asRecord(obj.message)
  const type =
    readString(obj.type) ??
    readString(obj.event) ??
    readString(messageObj?.type) ??
    ''
  const payload = asRecord(obj.payload) ?? asRecord(messageObj?.payload) ?? obj
  const ts =
    parseIsoTimestampMs(obj.timestamp) ??
    parseIsoTimestampMs(obj.created_at) ??
    parseIsoTimestampMs(payload.timestamp) ??
    observedAtMs

  const maybeModel =
    readString(payload.model) ??
    readString(asRecord(payload.request)?.model) ??
    readString(obj.model)
  if (maybeModel) state.model = maybeModel

  if (
    type === 'llm.request' ||
    type === 'turn.prompt' ||
    type === 'TurnBegin' ||
    type === 'StepBegin'
  ) {
    state.lastRequestAtMs = ts
    return
  }

  if (type === 'tool.call' || type === 'ToolCall' || type === 'tool_use') {
    const toolName =
      readString(payload.name) ??
      readString(asRecord(payload.function)?.name) ??
      readString(payload.tool) ??
      'tool'
    recordTool(state.tools, toolName, ts)
    return
  }

  // Modern Kimi Code CLI (`usage.record`): only aggregate turn-scoped records.
  if (type === 'usage.record') {
    const scope = readString(payload.scope) ?? readString(obj.scope)
    if (scope === 'session') return

    const usage = asRecord(payload.usage) ?? asRecord(obj.usage) ?? payload
    const inputOther = readNumber(usage.inputOther ?? usage.input_other ?? usage.inputTokens)
    const output = readNumber(usage.output ?? usage.outputTokens)
    const cacheRead = readNumber(usage.inputCacheRead ?? usage.input_cache_read)
    const cacheWrite = readNumber(usage.inputCacheCreation ?? usage.input_cache_creation)
    const contextUsed = inputOther + cacheRead + cacheWrite + output

    trackCompaction(state, contextUsed)
    const durationMs = computeDuration(state.lastRequestAtMs, ts)
    state.lastRequestAtMs = ts

    state.turns.push({
      timestampMs: ts,
      durationMs,
      model: state.model,
      inputUncached: inputOther,
      output,
      reasoning: 0,
      cacheRead,
      cacheWrite,
      contextUsed: contextUsed > 0 ? contextUsed : null,
      contextLimit: null
    })
    return
  }

  // Legacy Python `kimi-cli` (`StatusUpdate` with `token_usage` and `context_usage`).
  if (type === 'StatusUpdate' || asRecord(payload.token_usage)) {
    state.format = 'kimi-legacy'
    const ratio = readFloat(payload.context_usage)
    if (ratio !== null && ratio >= 0 && ratio <= 1.5) {
      state.contextRatioOverride = Math.min(1, ratio)
    }

    const tu = asRecord(payload.token_usage)
    if (!tu) return

    const inputOther = readNumber(tu.input_other ?? tu.inputOther)
    const output = readNumber(tu.output)
    const cacheRead = readNumber(tu.input_cache_read ?? tu.inputCacheRead)
    const cacheWrite = readNumber(tu.input_cache_creation ?? tu.inputCacheCreation)

    // Legacy StatusUpdate may emit per-step or monotonic cumulative counters; treat monotonic increase safely.
    const prev = state.lastLegacyCumulative
    let deltaInput = inputOther
    let deltaOutput = output
    let deltaCacheRead = cacheRead
    let deltaCacheWrite = cacheWrite

    if (
      prev &&
      inputOther >= prev.inputOther &&
      output >= prev.output &&
      cacheRead >= prev.cacheRead &&
      cacheWrite >= prev.cacheWrite
    ) {
      deltaInput = inputOther - prev.inputOther
      deltaOutput = output - prev.output
      deltaCacheRead = cacheRead - prev.cacheRead
      deltaCacheWrite = cacheWrite - prev.cacheWrite
    }

    state.lastLegacyCumulative = { inputOther, output, cacheRead, cacheWrite }
    if (deltaInput + deltaOutput + deltaCacheRead + deltaCacheWrite === 0) return

    const turnContext = deltaInput + deltaCacheRead + deltaCacheWrite + deltaOutput
    trackCompaction(state, turnContext)
    const durationMs = computeDuration(state.lastRequestAtMs, ts)
    state.lastRequestAtMs = ts

    state.turns.push({
      timestampMs: ts,
      durationMs,
      model: state.model,
      inputUncached: deltaInput,
      output: deltaOutput,
      reasoning: 0,
      cacheRead: deltaCacheRead,
      cacheWrite: deltaCacheWrite,
      contextUsed: turnContext > 0 ? turnContext : null,
      contextLimit: null,
      contextRatioOverride: state.contextRatioOverride
    })
  }
}

export class KimiAdapter {
  private readonly tailer = new JsonlTailer<KimiParseState>()
  private readonly pathBySession = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const logPath = await this.locateWireFile(ctx)
    if (!logPath) return null

    const res = await this.tailer.readIncremental(logPath, createKimiState, ingestKimiLine)
    if (!res.exists) {
      if (ctx.agent.sessionId) this.pathBySession.delete(ctx.agent.sessionId)
      return null
    }

    const state = res.state
    const contextLimit = resolveContextWindow(state.model, 'kimi', ctx.modelOverrides)
    const contextUsed =
      state.lastContextUsed ??
      (state.contextRatioOverride !== null && contextLimit
        ? Math.round(state.contextRatioOverride * contextLimit)
        : null)

    return {
      source: state.format,
      sourceLabel: state.format === 'kimi-legacy' ? 'Kimi CLI Wire' : 'Kimi Code Wire',
      logPath,
      model: state.model,
      contextUsed,
      contextLimit,
      contextIsEstimated: false,
      compactedDetected: state.compactedDetected,
      turns: state.turns,
      recentTools: [...state.tools.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    }
  }

  private async locateWireFile(ctx: AdapterContext): Promise<string | null> {
    const sid = ctx.agent.sessionId
    if (sid) {
      const cached = this.pathBySession.get(sid)
      if (cached) return cached
    }

    const workspaceHashes = new Set<string>()
    for (const p of [ctx.workspace.linuxPath, ctx.workspace.windowsPath, ctx.workspace.rawPath]) {
      if (!p) continue
      const clean = p.replace(/\/+$/, '')
      workspaceHashes.add(createHash('md5').update(clean).digest('hex'))
      const norm = normalizePathForCompare(clean)
      if (norm) workspaceHashes.add(createHash('md5').update(norm).digest('hex'))
    }

    const customHome = process.env.KIMI_CODE_HOME
    const baseDirs: string[] = []
    if (customHome) baseDirs.push(path.join(customHome, 'sessions'))
    for (const root of ctx.homeRoots) {
      baseDirs.push(path.join(root.homeWin, '.kimi-code', 'sessions'))
      baseDirs.push(path.join(root.homeWin, '.kimi', 'sessions'))
    }

    for (const sessionsRoot of baseDirs) {
      if (!(await fileExists(sessionsRoot))) continue

      if (sid) {
        for (const hash of workspaceHashes) {
          const directLegacy = path.join(sessionsRoot, hash, sid, 'wire.jsonl')
          if (await fileExists(directLegacy)) {
            this.pathBySession.set(sid, directLegacy)
            return directLegacy
          }
        }
      }

      const files = await findMatchingFiles(
        sessionsRoot,
        (name) => name === 'wire.jsonl',
        { maxDepth: 5, maxDirs: 100, descendingDirs: true }
      )
      if (files.length === 0) continue

      if (sid) {
        const matched = files.find((f) => f.path.includes(sid))
        if (matched) {
          this.pathBySession.set(sid, matched.path)
          return matched.path
        }
      }

      // If no sessionId matched directly, prefer the workspace-hash match modified recently.
      for (const hash of workspaceHashes) {
        const byHash = files.find((f) => f.path.includes(hash))
        if (byHash) {
          if (sid) this.pathBySession.set(sid, byHash.path)
          return byHash.path
        }
      }

      // Fallback only if file was modified in the last 10 minutes while agent is running.
      const newest = files[0]
      if (newest && Date.now() - newest.mtimeMs < 10 * 60_000 && ctx.agent.state === 'working') {
        return newest.path
      }
    }

    return null
  }
}

function trackCompaction(state: KimiParseState, contextUsed: number): void {
  if (contextUsed <= 0) return
  if (state.lastContextUsed !== null && state.lastContextUsed > 20_000 && contextUsed < state.lastContextUsed * 0.6) {
    state.compactedDetected = true
  }
  state.lastContextUsed = contextUsed
}

function computeDuration(anchorMs: number | null, ts: number): number | null {
  if (anchorMs === null || ts <= anchorMs || ts - anchorMs > 600_000) return null
  return ts - anchorMs
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

function readFloat(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null
}
