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
  contextWindow: number | null
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
    contextWindow: null,
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
    readString(obj.model) ??
    readString(payload.modelAlias) ??
    readString(obj.modelAlias)
  if (maybeModel) state.model = maybeModel

  const maybeContextWindow = readNumber(
    payload.maxTokens ??
      obj.maxTokens ??
      payload.max_context_size ??
      obj.max_context_size
  )
  if (maybeContextWindow >= 32_768) {
    state.contextWindow = maybeContextWindow
  }

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

  if (type === 'token_counting.measured' || type === 'token_counting.turn_recorded') {
    const measured = readNumber(payload.tokens ?? obj.tokens)
    if (measured > 0) trackCompaction(state, measured)
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
    const cfg = await readKimiConfigLimitsForWire(logPath)
    const model = state.model ?? cfg?.defaultModel ?? null
    const cfgLimit = model ? cfg?.contextByModel.get(model) : undefined
    const effectiveLimit = cfgLimit ?? state.contextWindow
    const mergedOverrides =
      model && effectiveLimit && ctx.modelOverrides[model] === undefined
        ? { ...ctx.modelOverrides, [model]: effectiveLimit }
        : ctx.modelOverrides

    const contextLimit = resolveContextWindow(model, 'kimi', mergedOverrides) ?? effectiveLimit ?? null
    const contextUsed =
      state.lastContextUsed ??
      (state.contextRatioOverride !== null && contextLimit
        ? Math.round(state.contextRatioOverride * contextLimit)
        : null)

    return {
      source: state.format,
      sourceLabel: state.format === 'kimi-legacy' ? 'Kimi CLI Wire' : 'Kimi Code Wire',
      logPath,
      model,
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
    if (cached && (await fileExists(cached))) return cached
    if (cached) this.pathByAgentKey.delete(cacheKey)

    const sid = ctx.agent.sessionId
    const targetPaths = buildWorkspacePathSet(ctx.workspace)
    const promptHint = buildPromptSnippet(ctx.agent.prompt)
    const targetMs = agentActivityTimestamp(ctx.agent)
    const wsBaseName = path.basename(ctx.workspace.linuxPath ?? ctx.workspace.windowsPath ?? '').toLowerCase()

    const workspaceHashes = new Set<string>()
    for (const p of [ctx.workspace.linuxPath, ctx.workspace.windowsPath, ctx.workspace.rawPath]) {
      if (!p) continue
      const clean = p.replace(/\/+$/, '')
      workspaceHashes.add(createHash('md5').update(clean).digest('hex'))
      const norm = normalizePathForCompare(clean)
      if (norm) workspaceHashes.add(createHash('md5').update(norm).digest('hex'))
    }

    const kimiHomes: { baseWin: string; distro: string | null }[] = []
    const customHome = process.env.KIMI_CODE_HOME
    if (customHome) kimiHomes.push({ baseWin: customHome, distro: null })
    for (const root of ctx.homeRoots) {
      kimiHomes.push({ baseWin: path.join(root.homeWin, '.kimi-code'), distro: root.distro })
      kimiHomes.push({ baseWin: path.join(root.homeWin, '.kimi'), distro: root.distro })
    }

    const matchOpts: KimiMatchOptions = {
      sid,
      targetPaths,
      workspaceHashes,
      wsBaseName,
      promptHint,
      targetMs
    }

    // Tier 1: Query `~/.kimi-code/session_index.jsonl` (scoring real wire mtime & state.json).
    let bestMatch: KimiMatchResult | null = null
    for (const kh of kimiHomes) {
      const indexFile = path.join(kh.baseWin, 'session_index.jsonl')
      if (await fileExists(indexFile)) {
        const match = await this.lookupInSessionIndex(indexFile, kh.distro, matchOpts)
        if (match?.confident) {
          this.pathByAgentKey.set(cacheKey, match.wirePath)
          return match.wirePath
        }
        if (match && !bestMatch) bestMatch = match
      }
    }

    // Tier 2 & 3: Direct hash lookup & mtime-ordered session scan (avoids alphabetical dir caps).
    for (const kh of kimiHomes) {
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

      const match = await scanSessionsRootByMtime(sessionsRoot, matchOpts)
      if (match?.confident) {
        this.pathByAgentKey.set(cacheKey, match.wirePath)
        return match.wirePath
      }
      if (match && !bestMatch) bestMatch = match
    }

    return bestMatch?.wirePath ?? null
  }

  private async lookupInSessionIndex(
    indexFile: string,
    distro: string | null,
    opts: KimiMatchOptions
  ): Promise<KimiMatchResult | null> {
    const tail = await readTailUtf8(indexFile, 512 * 1024)
    if (!tail) return null

    type IndexRow = {
      sessionId?: string
      id?: string
      sessionDir?: string
      workDir?: string
      cwd?: string
      title?: string
      updatedAt?: string | number
      deleted?: boolean
    }

    // Collapse append-only index rows by sessionId so deleted sessions are skipped cleanly.
    const latestBySession = new Map<string, { row: IndexRow; order: number }>()
    let order = 0
    for (const rawLine of tail.split(/\r?\n/)) {
      const row = safeJsonParse<IndexRow>(rawLine.trim())
      if (!row) continue
      const rowKey = row.sessionId ?? row.id ?? row.sessionDir ?? `row-${order}`
      if (row.deleted) {
        latestBySession.delete(rowKey)
      } else if (row.sessionDir) {
        latestBySession.set(rowKey, { row, order })
      }
      order++
    }

    type IndexCandidate = {
      sessionDir: string
      wirePath: string
      wireMtimeMs: number
      isSidMatch: boolean
      isCwdMatch: boolean
      indexTitle?: string
      indexUpdatedAtMs?: number
      order: number
    }

    const matchingRows: {
      row: IndexRow
      isSidMatch: boolean
      isCwdMatch: boolean
      winSessionDir: string
      order: number
    }[] = []

    for (const { row, order: rowOrder } of latestBySession.values()) {
      const rowSid = row.sessionId ?? row.id ?? ''
      const rowCwd = normalizePathForCompare(row.workDir ?? row.cwd)
      const isSidMatch = Boolean(opts.sid && rowSid === opts.sid)
      const isCwdMatch = Boolean(rowCwd && opts.targetPaths.has(rowCwd))
      if (!isSidMatch && !isCwdMatch) continue
      if (!row.sessionDir) continue

      const winSessionDir =
        distro && row.sessionDir.startsWith('/')
          ? toWslUncPath(distro, row.sessionDir)
          : row.sessionDir
      matchingRows.push({ row, isSidMatch, isCwdMatch, winSessionDir, order: rowOrder })
    }

    if (matchingRows.length === 0) return null

    const resolved = await Promise.all(
      matchingRows.map(async (item): Promise<IndexCandidate | null> => {
        const wirePath = await findWireInsideSessionDir(item.winSessionDir)
        if (!wirePath) return null
        const wireMtimeMs = await statMtimeMs(wirePath)
        if (wireMtimeMs <= 0) return null
        return {
          sessionDir: item.winSessionDir,
          wirePath,
          wireMtimeMs,
          isSidMatch: item.isSidMatch,
          isCwdMatch: item.isCwdMatch,
          indexTitle: item.row.title,
          indexUpdatedAtMs: parseIsoTimestampMs(item.row.updatedAt) ?? undefined,
          order: item.order
        }
      })
    )

    const valid = resolved.filter((c): c is IndexCandidate => c !== null)
    if (valid.length === 0) return null

    const shortlisted = shortlistCandidates(valid, opts.targetMs, 20)
    const evaluated = await Promise.all(
      shortlisted.map((c) =>
        evaluateKimiCandidate(
          {
            sessionDir: c.sessionDir,
            wirePath: c.wirePath,
            wireMtimeMs: c.wireMtimeMs,
            isSidMatch: c.isSidMatch,
            isCwdMatch: c.isCwdMatch,
            indexTitle: c.indexTitle,
            indexUpdatedAtMs: c.indexUpdatedAtMs
          },
          opts
        )
      )
    )

    return pickBestKimiCandidate(
      evaluated.filter((c): c is ScoredKimiCandidate => c !== null),
      opts.targetMs
    )
  }
}

type KimiMatchOptions = {
  sid: string | null
  targetPaths: Set<string>
  workspaceHashes: Set<string>
  wsBaseName: string
  promptHint: string | null
  targetMs: number
}

type KimiMatchResult = {
  wirePath: string
  confident: boolean
}

type ScoredKimiCandidate = {
  wirePath: string
  score: number
  activityMs: number
  confident: boolean
}

function shortlistCandidates<T extends { isSidMatch: boolean; wireMtimeMs: number }>(
  items: T[],
  targetMs: number,
  limit: number
): T[] {
  if (items.length <= limit) return items
  const picked = new Set<T>()
  const bySid = items.filter((i) => i.isSidMatch)
  for (const item of bySid) picked.add(item)

  const byClosest = [...items].sort((a, b) =>
    targetMs > 0
      ? Math.abs(a.wireMtimeMs - targetMs) - Math.abs(b.wireMtimeMs - targetMs)
      : b.wireMtimeMs - a.wireMtimeMs
  )
  for (const item of byClosest.slice(0, Math.max(limit - 5, 10))) {
    picked.add(item)
  }

  const byNewest = [...items].sort((a, b) => b.wireMtimeMs - a.wireMtimeMs)
  for (const item of byNewest) {
    if (picked.size >= limit) break
    picked.add(item)
  }
  return [...picked]
}

async function scanSessionsRootByMtime(
  sessionsRoot: string,
  opts: KimiMatchOptions
): Promise<KimiMatchResult | null> {
  const projectDirs = await listSubdirsSortedByRelevance(sessionsRoot, opts.workspaceHashes, opts.wsBaseName)
  const rawCandidates: {
    sessionDir: string
    wirePath: string
    wireMtimeMs: number
    isSidMatch: boolean
  }[] = []

  // Prioritize directories matching this workspace first, then fallback to generic dirs.
  const dirsToInspect = projectDirs.slice(0, 12)
  let sawMatchedWorkspace = false
  for (const pDir of dirsToInspect) {
    if (!pDir.matchedWorkspace && sawMatchedWorkspace && rawCandidates.length > 0) {
      break
    }
    if (pDir.matchedWorkspace) sawMatchedWorkspace = true
    let entries
    try {
      entries = await fs.readdir(pDir.path, { withFileTypes: true })
    } catch {
      continue
    }

    const subdirs = entries.filter((e) => e.isDirectory())
    const resolvedSubdirs = await Promise.all(
      subdirs.map(async (sub) => {
        const sessionDir = path.join(pDir.path, sub.name)
        const wirePath = await findWireInsideSessionDir(sessionDir)
        if (!wirePath) return null
        const wireMtimeMs = await statMtimeMs(wirePath)
        if (wireMtimeMs <= 0) return null
        const isSidMatch = Boolean(opts.sid && (sub.name === opts.sid || wirePath.includes(opts.sid)))
        return { sessionDir, wirePath, wireMtimeMs, isSidMatch }
      })
    )

    for (const item of resolvedSubdirs) {
      if (item) rawCandidates.push(item)
    }
  }

  // Fallback for non-standard deeper layouts inside matching workspace directories.
  if (rawCandidates.length === 0) {
    for (const pDir of dirsToInspect.slice(0, 4)) {
      const files = await findMatchingFiles(
        pDir.path,
        (name) => name === 'wire.jsonl',
        { maxDepth: 4, maxDirs: 240, descendingDirs: false }
      )
      for (const f of files) {
        const sessionDir = findSessionDirFromWire(f.path)
        if (!sessionDir) continue
        rawCandidates.push({
          sessionDir,
          wirePath: f.path,
          wireMtimeMs: f.mtimeMs,
          isSidMatch: Boolean(opts.sid && f.path.includes(opts.sid))
        })
      }
    }
  }

  if (rawCandidates.length === 0) return null

  const shortlisted = shortlistCandidates(rawCandidates, opts.targetMs, 24)
  const evaluated = await Promise.all(
    shortlisted.map((c) =>
      evaluateKimiCandidate(
        {
          sessionDir: c.sessionDir,
          wirePath: c.wirePath,
          wireMtimeMs: c.wireMtimeMs,
          isSidMatch: c.isSidMatch,
          isCwdMatch: false
        },
        opts
      )
    )
  )

  return pickBestKimiCandidate(
    evaluated.filter((c): c is ScoredKimiCandidate => c !== null),
    opts.targetMs
  )
}

async function listSubdirsSortedByRelevance(
  sessionsRoot: string,
  workspaceHashes: Set<string>,
  wsBaseName: string
): Promise<{ path: string; matchedWorkspace: boolean; mtimeMs: number }[]> {
  let entries
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const lower = e.name.toLowerCase()
        const fullPath = path.join(sessionsRoot, e.name)
        const matchedWorkspace =
          workspaceHashes.has(e.name) ||
          Boolean(wsBaseName && lower.startsWith(`wd_${wsBaseName}_`))
        const mtimeMs = await statMtimeMs(fullPath)
        return { path: fullPath, matchedWorkspace, mtimeMs }
      })
  )

  dirs.sort((a, b) => {
    if (a.matchedWorkspace !== b.matchedWorkspace) return a.matchedWorkspace ? -1 : 1
    return b.mtimeMs - a.mtimeMs
  })
  return dirs
}

async function evaluateKimiCandidate(
  input: {
    sessionDir: string
    wirePath: string
    wireMtimeMs: number
    isSidMatch: boolean
    isCwdMatch: boolean
    indexTitle?: string
    indexUpdatedAtMs?: number
  },
  opts: KimiMatchOptions
): Promise<ScoredKimiCandidate | null> {
  let score = 0
  let isSidMatch = input.isSidMatch
  let isCwdMatch = input.isCwdMatch
  let promptMatched = Boolean(
    opts.promptHint && input.indexTitle && input.indexTitle.includes(opts.promptHint)
  )

  if (opts.wsBaseName && input.wirePath.toLowerCase().includes(`wd_${opts.wsBaseName}_`)) {
    score += 15
  }
  if ([...opts.workspaceHashes].some((h) => input.wirePath.includes(h))) {
    score += 30
  }

  let stUpdated: number | null = null
  const stateRaw = await readOptionalText(path.join(input.sessionDir, 'state.json'))
  if (stateRaw) {
    const st = safeJsonParse<{
      id?: string
      workDir?: string
      cwd?: string
      title?: string
      lastPrompt?: string
      updatedAt?: number | string
      archived?: boolean
    }>(stateRaw)
    const wd = normalizePathForCompare(st?.cwd ?? st?.workDir)
    if (wd) {
      if (!opts.targetPaths.has(wd)) return null
      isCwdMatch = true
    }
    if (opts.sid && st?.id === opts.sid) isSidMatch = true
    if (
      opts.promptHint &&
      ((st?.lastPrompt && st.lastPrompt.includes(opts.promptHint)) ||
        (st?.title && st.title.includes(opts.promptHint)))
    ) {
      promptMatched = true
    }
    if (st?.archived) score -= 25
    stUpdated = parseIsoTimestampMs(st?.updatedAt)
  }

  if (!isSidMatch && !isCwdMatch && score === 0) return null

  if (isSidMatch) score += 200
  if (isCwdMatch) score += 50

  if (opts.promptHint && !promptMatched) {
    const head = await readHeadUtf8(input.wirePath, 16_384)
    if (head.includes(opts.promptHint)) {
      promptMatched = true
    } else {
      const tail = await readTailUtf8(input.wirePath, 12_288)
      if (tail.includes(opts.promptHint)) promptMatched = true
    }
  }
  if (promptMatched) score += 80

  const activityMs = Math.max(input.wireMtimeMs, stUpdated ?? 0, input.indexUpdatedAtMs ?? 0)
  let isFreshMtime = false
  if (opts.targetMs > 0 && activityMs > 0) {
    const delta = Math.abs(activityMs - opts.targetMs)
    if (delta < 120_000) {
      score += 45
      isFreshMtime = true
    } else if (delta < 900_000) {
      score += 25
    } else if (delta < 3_600_000) {
      score += 10
    } else if (delta > 86_400_000) {
      score -= 35
    }
  }

  return {
    wirePath: input.wirePath,
    score,
    activityMs,
    confident: isSidMatch || promptMatched || isFreshMtime
  }
}

function pickBestKimiCandidate(
  candidates: ScoredKimiCandidate[],
  targetMs: number
): KimiMatchResult | null {
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (targetMs > 0) {
      const diff = Math.abs(a.activityMs - targetMs) - Math.abs(b.activityMs - targetMs)
      if (diff !== 0) return diff
    }
    return b.activityMs - a.activityMs
  })
  const best = candidates[0]
  return { wirePath: best.wirePath, confident: best.confident }
}

async function statMtimeMs(targetPath: string): Promise<number> {
  try {
    const st = await fs.stat(targetPath)
    return st.mtimeMs
  } catch {
    return 0
  }
}

type KimiConfigLimits = {
  defaultModel: string | null
  contextByModel: Map<string, number>
}

const kimiConfigCache = new Map<string, { mtimeMs: number; size: number; limits: KimiConfigLimits }>()

async function readKimiConfigLimitsForWire(wirePath: string): Promise<KimiConfigLimits | null> {
  const parts = wirePath.split(/[\\/]/)
  const sessionsIdx = parts.lastIndexOf('sessions')
  if (sessionsIdx <= 0) return null
  const configPath = path.join(parts.slice(0, sessionsIdx).join(path.sep), 'config.toml')

  let st
  try {
    st = await fs.stat(configPath)
  } catch {
    return null
  }

  const cached = kimiConfigCache.get(configPath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.limits
  }

  const raw = await readOptionalText(configPath)
  if (!raw) return null

  const limits = parseKimiConfigToml(raw)
  kimiConfigCache.set(configPath, { mtimeMs: st.mtimeMs, size: st.size, limits })
  return limits
}

export function parseKimiConfigToml(tomlText: string): KimiConfigLimits {
  let defaultModel: string | null = null
  const contextByModel = new Map<string, number>()
  let activeModelSection: string | null = null
  let inTopLevel = true

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      inTopLevel = false
      const modelMatch = line.match(/^\[models\.(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/)
      activeModelSection = modelMatch ? (modelMatch[1] ?? modelMatch[2] ?? modelMatch[3]).trim() : null
      continue
    }

    if (inTopLevel) {
      const defMatch = line.match(/^default_model\s*=\s*(?:"([^"]+)"|'([^']+)')/)
      if (defMatch) defaultModel = (defMatch[1] ?? defMatch[2]).trim()
      continue
    }

    if (activeModelSection) {
      const ctxMatch = line.match(/^max_context_size\s*=\s*([0-9_]+)/)
      if (ctxMatch) {
        const parsed = Number.parseInt(ctxMatch[1].replace(/_/g, ''), 10)
        if (Number.isFinite(parsed) && parsed > 0) {
          contextByModel.set(activeModelSection, parsed)
        }
      }
    }
  }

  return { defaultModel, contextByModel }
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
