import * as fs from 'node:fs/promises'
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
  readTailUtf8,
  type FoundFile
} from './fs-lookup'
import { resolveContextWindow } from './model-windows'
import { JsonlTailer, parseIsoTimestampMs, safeJsonParse } from './tailer'
import type { AdapterContext, AdapterResult, ParsedTurn } from './types'

export type ClaudeParseState = {
  model: string | null
  lastContextUsed: number | null
  compactedDetected: boolean
  lastRequestAtMs: number | null
  turns: ParsedTurn[]
  turnIndexByMessageId: Map<string, number>
  seenToolUseIds: Set<string>
  tools: Map<string, ToolCount>
}

export function createClaudeState(): ClaudeParseState {
  return {
    model: null,
    lastContextUsed: null,
    compactedDetected: false,
    lastRequestAtMs: null,
    turns: [],
    turnIndexByMessageId: new Map(),
    seenToolUseIds: new Set(),
    tools: new Map()
  }
}

export function ingestClaudeLine(line: string, state: ClaudeParseState, observedAtMs: number): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  const type = readString(obj.type) ?? ''
  const ts = parseIsoTimestampMs(obj.timestamp) ?? observedAtMs

  if (type === 'user' || type === 'api-request') {
    state.lastRequestAtMs = ts
    return
  }

  if (type !== 'assistant') return
  const msg = asRecord(obj.message)
  if (!msg) return

  const model = readString(msg.model)
  if (!model || model === '<synthetic>') return
  state.model = model

  const content = msg.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (readString(b.type) === 'tool_use') {
        const toolId = readString(b.id)
        if (toolId) {
          if (state.seenToolUseIds.has(toolId)) continue
          state.seenToolUseIds.add(toolId)
        }
        const name = readString(b.name) ?? 'tool'
        const prev = state.tools.get(name)
        state.tools.set(name, { name, count: (prev?.count ?? 0) + 1, lastAt: ts })
      }
    }
  }

  const usage = asRecord(msg.usage)
  if (!usage) return

  const inputUncached = readNumber(usage.input_tokens)
  const cacheWrite = readNumber(usage.cache_creation_input_tokens)
  const cacheRead = readNumber(usage.cache_read_input_tokens)
  const output = readNumber(usage.output_tokens)
  const outDetails = asRecord(usage.output_tokens_details)
  const reasoning = readNumber(outDetails?.thinking_tokens)

  const contextUsed = inputUncached + cacheWrite + cacheRead + output
  if (contextUsed === 0 && output === 0) return

  const msgId = readString(msg.id)
  const existingIdx = msgId ? state.turnIndexByMessageId.get(msgId) : undefined

  if (existingIdx !== undefined) {
    const prevTurn = state.turns[existingIdx]
    const prevContext = prevTurn.contextUsed ?? 0
    if (
      output >= prevTurn.output &&
      inputUncached + cacheWrite + cacheRead >=
        prevTurn.inputUncached + prevTurn.cacheWrite + prevTurn.cacheRead
    ) {
      const nextDuration =
        prevTurn.durationMs !== null && prevTurn.durationMs !== undefined
          ? Math.max(prevTurn.durationMs, computeDuration(state.lastRequestAtMs, ts) ?? 0) || null
          : computeDuration(state.lastRequestAtMs, ts)
      state.turns[existingIdx] = {
        timestampMs: ts,
        durationMs: nextDuration,
        model,
        inputUncached,
        output,
        reasoning,
        reasoningIncludedInOutput: true,
        cacheRead,
        cacheWrite,
        contextUsed: contextUsed > 0 ? contextUsed : prevContext || null,
        contextLimit: null
      }
      if (contextUsed > 0 && existingIdx === state.turns.length - 1) {
        state.lastContextUsed = contextUsed
      }
    }
    return
  }

  if (
    contextUsed > 0 &&
    state.lastContextUsed !== null &&
    state.lastContextUsed > 20_000 &&
    contextUsed < state.lastContextUsed * 0.6
  ) {
    state.compactedDetected = true
  }
  if (contextUsed > 0) {
    state.lastContextUsed = contextUsed
  }

  const durationMs = computeDuration(state.lastRequestAtMs, ts)
  const turn: ParsedTurn = {
    timestampMs: ts,
    durationMs,
    model,
    inputUncached,
    output,
    reasoning,
    reasoningIncludedInOutput: true,
    cacheRead,
    cacheWrite,
    contextUsed: contextUsed > 0 ? contextUsed : null,
    contextLimit: null
  }
  const idx = state.turns.push(turn) - 1
  if (msgId) {
    state.turnIndexByMessageId.set(msgId, idx)
  }
}

export class ClaudeAdapter {
  private readonly tailer = new JsonlTailer<ClaudeParseState>()
  private readonly pathByAgentKey = new Map<string, string>()

  async collect(ctx: AdapterContext): Promise<AdapterResult | null> {
    const match = await this.locateSessionFile(ctx)
    if (!match) {
      ctx.logger?.logOnce(
        `claude-miss:${ctx.agent.key}`,
        'INFO',
        'claude',
        `No transcript JSONL matched for key=${ctx.agent.key} sessionId=${ctx.agent.sessionId ?? 'none'}`
      )
      return null
    }

    ctx.logger?.logOnce(`claude-hit:${ctx.agent.key}`, 'INFO', 'claude', `Using transcript: ${match.logPath}`)

    const res = await this.tailer.readIncremental(match.logPath, createClaudeState, ingestClaudeLine)
    if (!res.exists) {
      this.pathByAgentKey.delete(ctx.agent.key)
      return null
    }

    const state = res.state
    const configuredLimit = await readClaudeConfiguredMaxContext(match.claudeDir)
    const contextLimit = resolveContextWindow(
      state.model,
      'claude',
      ctx.modelOverrides,
      configuredLimit
    )

    return {
      source: 'claude-jsonl',
      sourceLabel: 'Claude JSONL',
      logPath: match.logPath,
      model: state.model,
      contextUsed: state.lastContextUsed,
      contextLimit,
      contextIsEstimated: false,
      compactedDetected: state.compactedDetected,
      reasoningIncludedInOutput: true,
      turns: state.turns,
      recentTools: [...state.tools.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    }
  }

  private async locateSessionFile(
    ctx: AdapterContext
  ): Promise<{ logPath: string; claudeDir: string } | null> {
    const cacheKey = ctx.agent.key
    const cached = this.pathByAgentKey.get(cacheKey)
    if (cached && (await fileExists(cached))) {
      return { logPath: cached, claudeDir: resolveClaudeRootFromTranscript(cached) }
    }

    const sid = ctx.agent.sessionId
    const slugs = buildClaudeSlugs([
      ctx.workspace.linuxPath,
      ctx.workspace.windowsPath,
      ctx.workspace.rawPath
    ])
    const targetPaths = buildWorkspacePathSet(ctx.workspace)
    const promptHint = buildPromptSnippet(ctx.agent.prompt)
    const targetMs = agentActivityTimestamp(ctx.agent)

    for (const root of ctx.homeRoots) {
      const claudeDir = path.join(root.homeWin, '.claude')
      const projectsDir = path.join(claudeDir, 'projects')
      if (!(await fileExists(projectsDir))) continue

      // Tier 1: Direct sessionId match inside project slug dirs.
      if (sid) {
        for (const slug of slugs) {
          const direct = path.join(projectsDir, slug, `${sid}.jsonl`)
          if (await fileExists(direct)) {
            this.pathByAgentKey.set(cacheKey, direct)
            return { logPath: direct, claudeDir }
          }
        }
      }

      // Tier 2: Lookup `~/.claude/history.jsonl` for Orca Native Chat UUID mapping.
      const historyPath = path.join(claudeDir, 'history.jsonl')
      if (await fileExists(historyPath)) {
        const mappedSid = await this.lookupInHistory(historyPath, targetPaths, promptHint, targetMs)
        if (mappedSid) {
          for (const slug of slugs) {
            const bySlug = path.join(projectsDir, slug, `${mappedSid}.jsonl`)
            if (await fileExists(bySlug)) {
              this.pathByAgentKey.set(cacheKey, bySlug)
              return { logPath: bySlug, claudeDir }
            }
          }
          const found = await findMatchingFiles(
            projectsDir,
            (name) => name === `${mappedSid}.jsonl`,
            { maxDepth: 2, maxDirs: 60, descendingDirs: false }
          )
          if (found.length > 0) {
            this.pathByAgentKey.set(cacheKey, found[0].path)
            return { logPath: found[0].path, claudeDir }
          }
        }
      }

      // Tier 3: Scan slug folder transcripts directly (preferring main session files, matching cwd prefix/prompt/mtime).
      for (const slug of slugs) {
        const slugDir = path.join(projectsDir, slug)
        if (!(await fileExists(slugDir))) continue
        const files = await findMatchingFiles(slugDir, (name) => name.endsWith('.jsonl'), {
          maxDepth: 1,
          maxDirs: 10,
          descendingDirs: true
        })
        if (files.length === 0) continue

        if (promptHint) {
          for (const f of files.slice(0, 10)) {
            const head = await readHeadUtf8(f.path, 16_384)
            if (head.includes(promptHint)) {
              this.pathByAgentKey.set(cacheKey, f.path)
              return { logPath: f.path, claudeDir }
            }
          }
        }

        const best = pickClosestFileByTimestamp(files, targetMs, 60 * 60_000, true)
        if (best) {
          if (targetMs <= 0 || Math.abs(best.mtimeMs - targetMs) <= 120_000) {
            this.pathByAgentKey.set(cacheKey, best.path)
          }
          return { logPath: best.path, claudeDir }
        }
      }

      // Tier 4: Fallback across `projects/*/*.jsonl` if workspace slug wasn't an exact match.
      const anyFiles = await findMatchingFiles(projectsDir, (name) => name.endsWith('.jsonl'), {
        maxDepth: 2,
        maxDirs: 40,
        descendingDirs: true
      })
      const wsMatches: FoundFile[] = []
      for (const f of anyFiles.slice(0, 20)) {
        const head = await readHeadUtf8(f.path, 32_768)
        if (matchesWorkspaceInJsonlHead(head, targetPaths)) {
          if (promptHint && head.includes(promptHint)) {
            this.pathByAgentKey.set(cacheKey, f.path)
            return { logPath: f.path, claudeDir }
          }
          wsMatches.push(f)
        }
      }
      if (wsMatches.length > 0) {
        const best = pickClosestFileByTimestamp(wsMatches, targetMs, 60 * 60_000, true)
        if (best) {
          if (targetMs <= 0 || Math.abs(best.mtimeMs - targetMs) <= 120_000) {
            this.pathByAgentKey.set(cacheKey, best.path)
          }
          return { logPath: best.path, claudeDir }
        }
      }
    }

    return null
  }

  private async lookupInHistory(
    historyPath: string,
    targetPaths: Set<string>,
    promptHint: string | null,
    targetMs: number
  ): Promise<string | null> {
    const tail = await readTailUtf8(historyPath, 128 * 1024)
    if (!tail) return null

    type ClaudeHistoryRow = {
      display?: string
      timestamp?: number | string
      project?: string
      sessionId?: string
    }

    const candidates: { sessionId: string; score: number; ts: number }[] = []

    for (const line of tail.split(/\r?\n/)) {
      const row = safeJsonParse<ClaudeHistoryRow>(line.trim())
      if (!row?.sessionId) continue

      const proj = normalizePathForCompare(row.project)
      const wsMatch = pathMatchesWorkspaceSet(proj, targetPaths)
      if (targetPaths.size > 0 && proj && !wsMatch) continue

      const rowTs = parseIsoTimestampMs(row.timestamp) ?? 0
      let score = wsMatch ? 20 : 1
      if (promptHint && typeof row.display === 'string' && row.display.includes(promptHint)) {
        score += 50
      }
      if (targetMs > 0 && rowTs > 0) {
        const delta = Math.abs(rowTs - targetMs)
        if (delta < 120_000) score += 25
        else if (delta < 3_600_000) score += 10
      }
      candidates.push({ sessionId: row.sessionId, score, ts: rowTs })
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.ts - a.ts))
    return candidates[0].sessionId
  }
}

export function buildClaudeSlugs(paths: (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    if (!raw) continue
    const trimmed = raw.trim().replace(/[\\/]+$/, '')
    if (!trimmed) continue
    const slug = trimmed.replace(/[^A-Za-z0-9-]/g, '-')
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      out.push(slug)
    }
  }
  return out
}

function resolveClaudeRootFromTranscript(transcriptPath: string): string {
  // Expected: `<home>/.claude/projects/<slug>/<file>.jsonl`
  return path.dirname(path.dirname(path.dirname(transcriptPath)))
}

async function readClaudeConfiguredMaxContext(claudeDir: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as { env?: { CLAUDE_CODE_MAX_CONTEXT_TOKENS?: string | number } }
    const val = Number(parsed?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
    return Number.isFinite(val) && val >= 32_000 ? Math.round(val) : null
  } catch {
    return null
  }
}

function pathMatchesWorkspaceSet(candidatePath: string, targetPaths: Set<string>): boolean {
  if (!candidatePath) return false
  if (targetPaths.has(candidatePath)) return true
  for (const ws of targetPaths) {
    if (candidatePath.startsWith(`${ws}/`) || ws.startsWith(`${candidatePath}/`)) {
      return true
    }
  }
  return false
}

function matchesWorkspaceInJsonlHead(head: string, targetPaths: Set<string>): boolean {
  if (targetPaths.size === 0) return true
  for (const line of head.split(/\r?\n/).slice(0, 12)) {
    const obj = safeJsonParse<{ cwd?: string }>(line.trim())
    const cwd = normalizePathForCompare(obj?.cwd)
    if (cwd && pathMatchesWorkspaceSet(cwd, targetPaths)) return true
  }
  return false
}

function computeDuration(anchorMs: number | null, ts: number): number | null {
  if (anchorMs === null || ts <= anchorMs) return null
  const delta = ts - anchorMs
  return delta <= 600_000 ? delta : null
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
