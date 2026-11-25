import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { toWslUncPath } from '../collectors/wsl-env'
import type { ToolCount } from '../protocol'
import {
  agentActivityTimestamp,
  buildPromptSnippet,
  buildWorkspacePathSet,
  fileExists,
  findMatchingFiles,
  normalizePathForCompare,
  readHeadUtf8,
  readTailUtf8
} from './fs-lookup'
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
    parseIsoTimestampMs(obj.time) ??
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
    type === 'agent.turn.started' ||
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

  // Modern Kimi Code CLI (`usage.record`): only aggregate turn-scoped records (`usageScope === 'turn'`).
  if (type === 'usage.record') {
    const scope =
      readString(payload.usageScope) ??
      readString(obj.usageScope) ??
      readString(payload.scope) ??
      readString(obj.scope)
    if (scope && scope !== 'turn') return

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
  private readonly pathByAgentKey = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const logPath = await this.locateWireFile(ctx)
    if (!logPath) {
      ctx.logger?.logOnce(
        `kimi-miss:${ctx.agent.key}`,
        'INFO',
        'kimi',
        `No wire.jsonl matched for key=${ctx.agent.key} sessionId=${ctx.agent.sessionId ?? 'none'}`
      )
      return null
    }

    ctx.logger?.logOnce(`kimi-hit:${ctx.agent.key}`, 'INFO', 'kimi', `Using wire log: ${logPath}`)

    const res = await this.tailer.readIncremental(logPath, createKimiState, ingestKimiLine)
    if (!res.exists) {
      this.pathByAgentKey.delete(ctx.agent.key)
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
    const cacheKey = ctx.agent.key
    const cached = this.pathByAgentKey.get(cacheKey)
    if (cached) return cached

    const sid = ctx.agent.sessionId
    const targetPaths = buildWorkspacePathSet(ctx.workspace)
    const promptHint = buildPromptSnippet(ctx.agent.prompt)
    const targetMs = agentActivityTimestamp(ctx.agent)

    const workspaceHashes = new Set<string>()
    for (const p of [ctx.workspace.linuxPath, ctx.workspace.windowsPath, ctx.workspace.rawPath]) {
      if (!p) continue
      const clean = p.replace(/\/+$/, '')
      workspaceHashes.add(createHash('md5').update(clean).digest('hex'))
      const norm = normalizePathForCompare(clean)
      if (norm) workspaceHashes.add(createHash('md5').update(norm).digest('hex'))
    }

    // Tier 1: Query `~/.kimi-code/session_index.jsonl` directly if available.
    const kimiHomes: { baseWin: string; distro: string | null }[] = []
    const customHome = process.env.KIMI_CODE_HOME
    if (customHome) kimiHomes.push({ baseWin: customHome, distro: null })
    for (const root of ctx.homeRoots) {
      kimiHomes.push({ baseWin: path.join(root.homeWin, '.kimi-code'), distro: root.distro })
      kimiHomes.push({ baseWin: path.join(root.homeWin, '.kimi'), distro: root.distro })
    }

    for (const kh of kimiHomes) {
      const indexFile = path.join(kh.baseWin, 'session_index.jsonl')
      if (await fileExists(indexFile)) {
        const matchedFromIndex = await this.lookupInSessionIndex(
          indexFile,
          kh.distro,
          sid,
          targetPaths,
          promptHint,
          targetMs
        )
        if (matchedFromIndex) {
          this.pathByAgentKey.set(cacheKey, matchedFromIndex)
          return matchedFromIndex
        }
      }

      const sessionsRoot = path.join(kh.baseWin, 'sessions')
      if (!(await fileExists(sessionsRoot))) continue

      if (sid) {
        for (const hash of workspaceHashes) {
          const directLegacy = path.join(sessionsRoot, hash, sid, 'wire.jsonl')
          if (await fileExists(directLegacy)) {
            this.pathByAgentKey.set(cacheKey, directLegacy)
            return directLegacy
          }
        }
      }

      const files = await findMatchingFiles(
        sessionsRoot,
        (name) => name === 'wire.jsonl',
        { maxDepth: 5, maxDirs: 120, descendingDirs: true }
      )
      if (files.length === 0) continue

      if (sid) {
        const matched = files.find((f) => f.path.includes(sid))
        if (matched) {
          this.pathByAgentKey.set(cacheKey, matched.path)
          return matched.path
        }
      }

      // Check state.json in parent session folders or workspace hash for Native Chat matching.
      const scoredCandidates: { path: string; mtimeMs: number; score: number }[] = []
      const wsBaseName = path.basename(ctx.workspace.linuxPath ?? ctx.workspace.windowsPath ?? '').toLowerCase()

      for (const f of files.slice(0, 60)) {
        let score = 0
        if (wsBaseName && f.path.toLowerCase().includes(`wd_${wsBaseName}_`)) {
          score += 20
        }
        const matchedHash = [...workspaceHashes].some((h) => f.path.includes(h))
        if (matchedHash) {
          score += 30
        }

        const sessionDir = findSessionDirFromWire(f.path)
        if (sessionDir) {
          const stateRaw = await readOptionalText(path.join(sessionDir, 'state.json'))
          if (stateRaw) {
            const st = safeJsonParse<{
              id?: string
              workDir?: string
              cwd?: string
              title?: string
              lastPrompt?: string
              updatedAt?: number | string
            }>(stateRaw)
            const wd = normalizePathForCompare(st?.cwd ?? st?.workDir)
            if (wd && targetPaths.has(wd)) {
              score += 50
            } else if (wd) {
              continue
            }
            if (sid && st?.id === sid) score += 100
            if (promptHint && ((st?.lastPrompt && st.lastPrompt.includes(promptHint)) || (st?.title && st.title.includes(promptHint)))) {
              score += 40
            }
            const stUpdated = parseIsoTimestampMs(st?.updatedAt)
            if (targetMs > 0 && stUpdated) {
              const delta = Math.abs(stUpdated - targetMs)
              if (delta < 120_000) score += 25
              else if (delta < 3600_000) score += 10
            }
          }
        }

        if (score > 0 && promptHint) {
          const head = await readHeadUtf8(f.path, 4096)
          if (head.includes(promptHint)) score += 35
        }

        if (score > 0) {
          scoredCandidates.push({ path: f.path, mtimeMs: f.mtimeMs, score })
        }
      }

      if (scoredCandidates.length > 0) {
        scoredCandidates.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          return Math.abs(a.mtimeMs - targetMs) - Math.abs(b.mtimeMs - targetMs)
        })
        const best = scoredCandidates[0]
        this.pathByAgentKey.set(cacheKey, best.path)
        return best.path
      }
    }

    return null
  }

  private async lookupInSessionIndex(
    indexFile: string,
    distro: string | null,
    sid: string | null,
    targetPaths: Set<string>,
    promptHint: string | null,
    targetMs: number
  ): Promise<string | null> {
    const tail = await readTailUtf8(indexFile, 128 * 1024)
    if (!tail) return null

    type IndexRow = {
      sessionId?: string
      id?: string
      sessionDir?: string
      workDir?: string
      cwd?: string
      title?: string
      updatedAt?: string | number
    }

    const candidates: { wirePath: string; score: number; updatedAtMs: number }[] = []

    for (const rawLine of tail.split(/\r?\n/)) {
      const row = safeJsonParse<IndexRow>(rawLine.trim())
      if (!row || !row.sessionDir) continue

      const rowSid = row.sessionId ?? row.id ?? ''
      const rowCwd = normalizePathForCompare(row.workDir ?? row.cwd)
      const isSidMatch = Boolean(sid && rowSid === sid)
      const isCwdMatch = Boolean(rowCwd && targetPaths.has(rowCwd))
      if (!isSidMatch && !isCwdMatch) continue

      const winSessionDir =
        distro && row.sessionDir.startsWith('/')
          ? toWslUncPath(distro, row.sessionDir)
          : row.sessionDir

      const wirePath = await findWireInsideSessionDir(winSessionDir)
      if (!wirePath) continue

      let score = isSidMatch ? 100 : 10
      if (promptHint && row.title && row.title.includes(promptHint)) score += 30
      const updatedAtMs = parseIsoTimestampMs(row.updatedAt) ?? 0
      if (targetMs > 0 && updatedAtMs > 0) {
        const delta = Math.abs(updatedAtMs - targetMs)
        if (delta < 120_000) score += 20
        else if (delta < 3600_000) score += 5
      }
      candidates.push({ wirePath, score, updatedAtMs })
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.updatedAtMs - a.updatedAtMs))
    return candidates[0].wirePath
  }
}

async function findWireInsideSessionDir(sessionDir: string): Promise<string | null> {
  const direct = path.join(sessionDir, 'wire.jsonl')
  if (await fileExists(direct)) return direct
  const agentsDir = path.join(sessionDir, 'agents')
  const wires = await findMatchingFiles(agentsDir, (name) => name === 'wire.jsonl', {
    maxDepth: 2,
    maxDirs: 10,
    descendingDirs: false
  })
  return wires[0]?.path ?? null
}

function findSessionDirFromWire(wirePath: string): string | null {
  const parts = wirePath.split(/[\\/]/)
  const agentsIdx = parts.lastIndexOf('agents')
  if (agentsIdx > 0) return parts.slice(0, agentsIdx).join(path.sep)
  return path.dirname(wirePath)
}

async function readOptionalText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
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
