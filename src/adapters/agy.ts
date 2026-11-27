import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentOption, ToolCount } from '../protocol'
import {
  agentActivityTimestamp,
  buildWorkspacePathSet,
  fileExists,
  normalizePathForCompare,
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
  pendingTurnEnd: boolean
  pendingTurnHasToolCalls: boolean
  turns: ParsedTurn[]
  tools: Map<string, ToolCount>
}

export function createAgyState(): AgyParseState {
  return {
    model: null,
    lastContextUsed: null,
    compactedDetected: false,
    seenSteps: new Set(),
    pendingTurnEnd: false,
    pendingTurnHasToolCalls: false,
    turns: [],
    tools: new Map()
  }
}

export function ingestAgyLine(
  line: string,
  state: AgyParseState,
  observedAtMs: number,
  meta?: { isInitialRead: boolean }
): void {
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

  // In Antigravity transcripts, `PLANNER_RESPONSE.created_at` marks when the LLM turn started,
  // while the subsequent `GENERIC` (`source: "MODEL"`) step marks when tool execution started
  // (i.e. right after model generation finished). Avoid counting user think time on `USER_INPUT`.
  if (state.pendingTurnEnd && state.turns.length > 0) {
    const prevTurn = state.turns[state.turns.length - 1]
    const isBoundaryEnd = type !== 'USER_INPUT' && type !== 'CHECKPOINT'
    if (
      isBoundaryEnd &&
      state.pendingTurnHasToolCalls &&
      prevTurn.timestampMs !== null &&
      ts > prevTurn.timestampMs &&
      ts - prevTurn.timestampMs <= 600_000
    ) {
      prevTurn.durationMs = ts - prevTurn.timestampMs
    }
    state.pendingTurnEnd = false
    state.pendingTurnHasToolCalls = false
  }

  if (typeof obj.model === 'string' && obj.model.length > 0) {
    state.model = obj.model
  }

  const hasToolCalls = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0
  if (hasToolCalls) {
    for (const tc of obj.tool_calls as unknown[]) {
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
    // Antigravity `transcript.jsonl` reports uncached `input_tokens` separately from
    // `cache_read_tokens` across both Gemini and Anthropic models.
    const rawInput = readNumber(obj.input_tokens)
    const cacheRead = readNumber(obj.cache_read_tokens)
    const output = readNumber(obj.output_tokens)
    const thinking = readNumber(obj.thinking_tokens)
    const model = state.model

    const inputUncached = rawInput
    const contextUsed = rawInput + cacheRead + output

    if (
      contextUsed > 0 &&
      state.lastContextUsed !== null &&
      state.lastContextUsed > 20_000 &&
      contextUsed < state.lastContextUsed * 0.6
    ) {
      state.compactedDetected = true
    }
    if (contextUsed > 0) state.lastContextUsed = contextUsed

    const isIncremental = meta ? !meta.isInitialRead : false
    const liveDelta = observedAtMs - ts
    const durationMs =
      isIncremental && liveDelta > 150 && liveDelta <= 600_000 ? liveDelta : null

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
    state.pendingTurnEnd = true
    state.pendingTurnHasToolCalls = hasToolCalls
  }
}

export function buildAgyPromptHints(agent: AgentOption): string[] {
  const out: string[] = []
  const add = (raw: string | null | undefined): void => {
    if (!raw) return
    const firstLine = raw.trim().split(/\r?\n/)[0] ?? ''
    const cleaned = firstLine
      .replace(/\s*\[Image #\d+\].*$/i, '')
      .replace(/(?:\.\.\.|…)+$/g, '')
      .trim()
    if (cleaned.length < 3) return
    const snippet = cleaned.slice(0, 50).trim()
    if (snippet.length >= 3 && !out.includes(snippet)) {
      out.push(snippet)
    }
  }
  add(agent.prompt)
  add(agent.title)
  add(agent.taskTitle)
  return out
}

type HistorySummary = {
  workspaceMatched: boolean
  workspaceMismatch: boolean
  promptMatched: boolean
  latestTs: number
}

type AgyCandidate = {
  convId: string
  transcriptPath: string
  mtimeMs: number
  score: number
  activityMs: number
  promptMatched: boolean
  confident: boolean
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
    if (cached && (await fileExists(cached))) return cached
    if (cached) this.pathByAgentKey.delete(cacheKey)

    const sid = ctx.agent.sessionId
    const targetPaths = buildWorkspacePathSet(ctx.workspace)
    const promptHints = buildAgyPromptHints(ctx.agent)
    const targetMs = agentActivityTimestamp(ctx.agent)

    const bases: { baseDir: string; brainDir: string; rootEnv: 'wsl' | 'windows' }[] = []
    for (const root of ctx.homeRoots) {
      for (const sub of ['antigravity-cli', 'antigravity', 'antigravity-chat/antigravity-acp']) {
        const baseDir = path.join(root.homeWin, '.gemini', sub)
        bases.push({ baseDir, brainDir: path.join(baseDir, 'brain'), rootEnv: root.env })
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

    // Tier 2 & 3: Joint scoring across `history.jsonl` and mtime-ordered `brain/*/transcript.jsonl`
    // so Native Chat sessions missing from `history.jsonl` are never hijacked by stale workspace logs.
    let bestOverall: AgyCandidate | null = null

    for (const { baseDir, brainDir, rootEnv } of bases) {
      const historyMap = await this.readHistoryMap(path.join(baseDir, 'history.jsonl'), targetPaths, promptHints)
      const filesByConv = await listBrainTranscripts(brainDir)

      for (const convId of historyMap.keys()) {
        if (!filesByConv.has(convId)) {
          const candidatePath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl')
          const mtimeMs = await statMtimeMs(candidatePath)
          if (mtimeMs > 0) {
            filesByConv.set(convId, { convId, transcriptPath: candidatePath, mtimeMs })
          }
        }
      }

      if (filesByConv.size === 0) continue

      const allItems = [...filesByConv.values()].filter((item) => !historyMap.get(item.convId)?.workspaceMismatch)
      if (allItems.length === 0) continue

      const shortlisted = shortlistAgyFiles(allItems, historyMap, targetMs, 24)
      const envAffinityBonus =
        (ctx.workspace.hostKind === 'wsl' && rootEnv === 'wsl') ||
        (ctx.workspace.hostKind === 'local' && rootEnv === 'windows')
          ? 15
          : 0

      const evaluated = await Promise.all(
        shortlisted.map(async (item): Promise<AgyCandidate | null> => {
          const hist = historyMap.get(item.convId)
          let headMatched = false
          let tailMatched = false
          let promptMatched = Boolean(hist?.promptMatched)

          if (promptHints.length > 0) {
            const head = await readHeadUtf8(item.transcriptPath, 8192)
            headMatched = matchesAnyHint(head, promptHints)
            if (!headMatched || promptHints.length > 1) {
              const tail = await readTailUtf8(item.transcriptPath, 65_536)
              tailMatched = matchesAnyHint(tail, promptHints)
            }
            if (headMatched || tailMatched) {
              promptMatched = true
            }
          }

          const activityMs = Math.max(item.mtimeMs, hist?.latestTs ?? 0)
          const delta = targetMs > 0 && activityMs > 0 ? Math.abs(activityMs - targetMs) : Infinity
          const isFreshMtime = delta <= 120_000
          const isWorkspaceMatch = Boolean(hist?.workspaceMatched)

          const eligible =
            promptMatched ||
            (isWorkspaceMatch && (targetMs <= 0 || delta <= 3_600_000)) ||
            (ctx.agent.state === 'working' && delta <= 15 * 60_000)
          if (!eligible) return null

          let score = envAffinityBonus
          if (isWorkspaceMatch) score += 25
          if (promptMatched) score += 80
          if (headMatched && tailMatched && promptHints.length > 1) score += 20

          if (delta <= 120_000) score += 45
          else if (delta <= 900_000) score += 25
          else if (delta <= 3_600_000) score += 10
          else if (delta > 86_400_000 && Number.isFinite(delta)) score -= 40

          return {
            convId: item.convId,
            transcriptPath: item.transcriptPath,
            mtimeMs: item.mtimeMs,
            score,
            activityMs,
            promptMatched,
            confident: promptMatched || isFreshMtime
          }
        })
      )

      const valid = evaluated.filter((c): c is AgyCandidate => c !== null)
      if (valid.length === 0) continue
      valid.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (targetMs > 0) {
          const diff = Math.abs(a.activityMs - targetMs) - Math.abs(b.activityMs - targetMs)
          if (diff !== 0) return diff
        }
        return b.activityMs - a.activityMs
      })

      const top = valid[0]
      if (top.promptMatched) {
        this.pathByAgentKey.set(cacheKey, top.transcriptPath)
        return top.transcriptPath
      }
      if (!bestOverall || top.score > bestOverall.score) {
        bestOverall = top
      }
    }

    if (bestOverall?.confident) {
      this.pathByAgentKey.set(cacheKey, bestOverall.transcriptPath)
    }
    return bestOverall?.transcriptPath ?? null
  }

  private async readHistoryMap(
    historyFile: string,
    targetPaths: Set<string>,
    promptHints: string[]
  ): Promise<Map<string, HistorySummary>> {
    const out = new Map<string, HistorySummary>()
    const tail = await readTailUtf8(historyFile, 256 * 1024)
    if (!tail) return out

    type HistoryRow = {
      display?: string
      timestamp?: number | string
      workspace?: string
      conversationId?: string
    }

    for (const line of tail.split(/\r?\n/)) {
      const row = safeJsonParse<HistoryRow>(line.trim())
      if (!row?.conversationId) continue

      const ws = normalizePathForCompare(row.workspace)
      const wsMatched = Boolean(ws && targetPaths.has(ws))
      const wsOther = Boolean(targetPaths.size > 0 && ws && !targetPaths.has(ws))
      const rowTs = parseIsoTimestampMs(row.timestamp) ?? 0
      const promptMatched =
        !wsOther &&
        promptHints.length > 0 &&
        typeof row.display === 'string' &&
        promptHints.some((h) => row.display!.includes(h))

      const prev = out.get(row.conversationId)
      if (!prev) {
        out.set(row.conversationId, {
          workspaceMatched: wsMatched,
          workspaceMismatch: wsOther,
          promptMatched,
          latestTs: rowTs
        })
      } else {
        if (wsMatched) {
          prev.workspaceMatched = true
          prev.workspaceMismatch = false
        }
        if (promptMatched) prev.promptMatched = true
        if (rowTs > prev.latestTs) prev.latestTs = rowTs
      }
    }

    return out
  }
}

type BrainTranscriptEntry = {
  convId: string
  transcriptPath: string
  mtimeMs: number
}

async function listBrainTranscripts(brainDir: string): Promise<Map<string, BrainTranscriptEntry>> {
  const out = new Map<string, BrainTranscriptEntry>()
  let entries
  try {
    entries = await fs.readdir(brainDir, { withFileTypes: true })
  } catch {
    return out
  }

  const checked = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e): Promise<BrainTranscriptEntry | null> => {
        const transcriptPath = path.join(brainDir, e.name, '.system_generated', 'logs', 'transcript.jsonl')
        const mtimeMs = await statMtimeMs(transcriptPath)
        return mtimeMs > 0 ? { convId: e.name, transcriptPath, mtimeMs } : null
      })
  )

  for (const item of checked) {
    if (item) out.set(item.convId, item)
  }
  return out
}

function shortlistAgyFiles(
  items: BrainTranscriptEntry[],
  historyMap: Map<string, HistorySummary>,
  targetMs: number,
  limit: number
): BrainTranscriptEntry[] {
  if (items.length <= limit) return items
  const picked = new Set<BrainTranscriptEntry>()

  for (const item of items) {
    if (historyMap.get(item.convId)?.promptMatched) {
      picked.add(item)
    }
  }

  const byClosest = [...items].sort((a, b) =>
    targetMs > 0
      ? Math.abs(a.mtimeMs - targetMs) - Math.abs(b.mtimeMs - targetMs)
      : b.mtimeMs - a.mtimeMs
  )
  for (const item of byClosest.slice(0, Math.max(limit - 6, 12))) {
    picked.add(item)
  }

  const byNewest = [...items].sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const item of byNewest) {
    if (picked.size >= limit) break
    picked.add(item)
  }

  return [...picked]
}

async function statMtimeMs(targetPath: string): Promise<number> {
  try {
    const st = await fs.stat(targetPath)
    return st.mtimeMs
  } catch {
    return 0
  }
}

function matchesAnyHint(text: string, hints: readonly string[]): boolean {
  if (!text) return false
  for (const h of hints) {
    if (text.includes(h)) return true
    const escaped = JSON.stringify(h).slice(1, -1)
    if (escaped !== h && text.includes(escaped)) return true
  }
  return false
}

function readNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : 0
}
