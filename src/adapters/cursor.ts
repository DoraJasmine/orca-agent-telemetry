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
  readHeadUtf8
} from './fs-lookup'
import { resolveContextWindow } from './model-windows'
import { JsonlTailer, parseIsoTimestampMs, safeJsonParse } from './tailer'
import type { AdapterContext, AdapterResult, ParsedTurn } from './types'

export type CursorHookParseState = {
  model: string | null
  lastContextUsed: number | null
  compactedDetected: boolean
  seenGenerations: Set<string>
  promptStartByConversation: Map<string, number>
  turnsBySession: Map<string, ParsedTurn[]>
  turnsByCwd: Map<string, ParsedTurn[]>
  lastEventAtMs: number | null
}

export type CursorTranscriptParseState = {
  totalChars: number
  messageCount: number
  tools: Map<string, ToolCount>
}

export function createCursorHookState(): CursorHookParseState {
  return {
    model: null,
    lastContextUsed: null,
    compactedDetected: false,
    seenGenerations: new Set(),
    promptStartByConversation: new Map(),
    turnsBySession: new Map(),
    turnsByCwd: new Map(),
    lastEventAtMs: null
  }
}

export function createCursorTranscriptState(): CursorTranscriptParseState {
  return {
    totalChars: 0,
    messageCount: 0,
    tools: new Map()
  }
}

export function ingestCursorHookLine(
  line: string,
  state: CursorHookParseState,
  observedAtMs: number
): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  const ts = parseIsoTimestampMs(obj.timestamp) ?? observedAtMs
  state.lastEventAtMs = ts

  const eventName = readString(obj.hook_event_name) ?? ''
  const sessionKey = readString(obj.session_id) ?? readString(obj.conversation_id) ?? '__default__'
  const cwdKey = normalizePathForCompare(readString(obj.workspace_roots) ?? readString(obj.cwd))

  if (eventName === 'beforeSubmitPrompt') {
    state.promptStartByConversation.set(sessionKey, ts)
    return
  }

  if (eventName !== 'stop' && eventName !== 'afterAgentResponse') return

  const genId = readString(obj.generation_id)
  if (genId) {
    if (state.seenGenerations.has(genId)) return
    state.seenGenerations.add(genId)
  }

  const model = readString(obj.model)
  if (model) state.model = model

  const rawInput = readNumber(obj.input_tokens ?? obj.inputTokens)
  const output = readNumber(obj.output_tokens ?? obj.outputTokens)
  const cacheRead = readNumber(obj.cache_read_tokens ?? obj.cacheReadTokens)
  const cacheWrite = readNumber(obj.cache_write_tokens ?? obj.cacheWriteTokens)

  // Cursor's `input_tokens` includes `cache_read_tokens + cache_write_tokens`.
  const inputUncached = Math.max(0, rawInput - cacheRead - cacheWrite)
  const contextUsed = rawInput + output > 0 ? rawInput + output : null

  if (
    contextUsed !== null &&
    state.lastContextUsed !== null &&
    state.lastContextUsed > 20_000 &&
    contextUsed < state.lastContextUsed * 0.6
  ) {
    state.compactedDetected = true
  }
  if (contextUsed !== null) state.lastContextUsed = contextUsed

  const promptStart = state.promptStartByConversation.get(sessionKey) ?? null
  const durationMs =
    promptStart !== null && ts > promptStart && ts - promptStart <= 600_000
      ? ts - promptStart
      : null
  if (promptStart !== null) {
    state.promptStartByConversation.delete(sessionKey)
  }

  const turn: ParsedTurn = {
    timestampMs: ts,
    durationMs,
    model,
    inputUncached,
    output,
    reasoning: 0,
    cacheRead,
    cacheWrite,
    contextUsed,
    contextLimit: null
  }

  const list = state.turnsBySession.get(sessionKey) ?? []
  list.push(turn)
  state.turnsBySession.set(sessionKey, list)

  if (cwdKey) {
    const cwdList = state.turnsByCwd.get(cwdKey) ?? []
    cwdList.push(turn)
    state.turnsByCwd.set(cwdKey, cwdList)
  }
}

export function ingestCursorTranscriptLine(
  line: string,
  state: CursorTranscriptParseState,
  observedAtMs: number
): void {
  const obj = safeJsonParse<Record<string, unknown>>(line)
  if (!obj) return

  state.messageCount += 1
  const msg = obj.message && typeof obj.message === 'object' ? (obj.message as Record<string, unknown>) : null
  const content = msg?.content

  if (typeof content === 'string') {
    state.totalChars += content.length
    return
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (typeof b.text === 'string') {
        state.totalChars += b.text.length
      }
      if (b.type === 'tool_use') {
        const name = readString(b.name) ?? 'tool'
        const prev = state.tools.get(name)
        state.tools.set(name, { name, count: (prev?.count ?? 0) + 1, lastAt: observedAtMs })
        if (b.input) {
          state.totalChars += JSON.stringify(b.input).length
        }
      }
    }
  }
}

export class CursorAdapter {
  private readonly hookTailer = new JsonlTailer<CursorHookParseState>()
  private readonly transcriptTailer = new JsonlTailer<CursorTranscriptParseState>()
  private readonly transcriptPathByAgentKey = new Map<string, string>()

  async collect(
    ctx: AdapterContext
  ): Promise<{ result: AdapterResult | null; lastHookEventAt: number | null }> {
    const transcript = await this.readTranscript(ctx)

    if (ctx.cursorHookEnabled) {
      const hookResult = await this.readHookSpool(ctx, transcript.tools)
      if (hookResult) {
        return hookResult
      }
    }

    if (transcript.path) {
      ctx.logger?.logOnce(
        `cursor-tx:${ctx.agent.key}`,
        'INFO',
        'cursor',
        `Using transcript: ${transcript.path}`
      )
      const estContext =
        transcript.totalChars > 0 ? Math.max(1, Math.round(transcript.totalChars / 3.8)) : null
      const limit = resolveContextWindow(null, 'cursor', ctx.modelOverrides)
      return {
        result: {
          source: 'cursor-transcript',
          sourceLabel: ctx.orcaSession ? 'Cursor Transcript + Orca' : 'Cursor Transcript (Est.)',
          logPath: transcript.path,
          model: null,
          contextUsed: estContext,
          contextLimit: limit,
          contextIsEstimated: estContext !== null,
          compactedDetected: false,
          tokensAvailable: (ctx.orcaSession?.totalTokens ?? 0) > 0,
          turns: [],
          cumulativeOverride: ctx.orcaSession
            ? {
                total: ctx.orcaSession.totalTokens,
                turnCount: ctx.orcaSession.messageCount || transcript.messageCount
              }
            : {
                turnCount: transcript.messageCount
              },
          recentTools: transcript.tools
        },
        lastHookEventAt: null
      }
    }

    return { result: null, lastHookEventAt: null }
  }

  private async readHookSpool(
    ctx: AdapterContext,
    tools: ToolCount[]
  ): Promise<{ result: AdapterResult | null; lastHookEventAt: number | null } | null> {
    const targetPaths = buildWorkspacePathSet(ctx.workspace)

    for (const root of ctx.homeRoots) {
      const spoolPath = path.join(root.homeWin, '.orca-telemetry', 'cursor-usage.jsonl')
      const res = await this.hookTailer.readIncremental(
        spoolPath,
        createCursorHookState,
        ingestCursorHookLine
      )
      if (!res.exists) continue

      const state = res.state
      const sid = ctx.agent.sessionId
      let turns: ParsedTurn[] = []
      if (sid && state.turnsBySession.has(sid)) {
        turns = state.turnsBySession.get(sid) ?? []
      } else {
        for (const wsPath of targetPaths) {
          const byCwd = state.turnsByCwd.get(wsPath)
          if (byCwd && byCwd.length > 0) {
            turns = byCwd
            break
          }
        }
        if (turns.length === 0 && !sid && state.turnsBySession.size > 0) {
          const allLists = [...state.turnsBySession.values()]
          turns = allLists[allLists.length - 1] ?? []
        }
      }

      if (turns.length === 0) {
        return { result: null, lastHookEventAt: state.lastEventAtMs }
      }

      const lastTurn = turns[turns.length - 1]
      const model = lastTurn.model ?? state.model
      const contextLimit = resolveContextWindow(model, 'cursor', ctx.modelOverrides)
      ctx.logger?.logOnce(`cursor-hook:${ctx.agent.key}`, 'INFO', 'cursor', `Using hook spool: ${spoolPath}`)

      return {
        result: {
          source: 'cursor-hook',
          sourceLabel: 'Cursor Hook',
          logPath: spoolPath,
          model,
          contextUsed: lastTurn.contextUsed,
          contextLimit,
          contextIsEstimated: false,
          compactedDetected: state.compactedDetected,
          turns,
          recentTools: tools
        },
        lastHookEventAt: state.lastEventAtMs
      }
    }

    return null
  }

  private async readTranscript(
    ctx: AdapterContext
  ): Promise<{ path: string | null; totalChars: number; messageCount: number; tools: ToolCount[] }> {
    const cacheKey = ctx.agent.key
    let targetPath: string | null = this.transcriptPathByAgentKey.get(cacheKey) ?? null
    if (targetPath && !(await fileExists(targetPath))) {
      this.transcriptPathByAgentKey.delete(cacheKey)
      targetPath = null
    }

    if (!targetPath) {
      let shouldCache = true
      const sid = ctx.agent.sessionId
      const slugHints = buildCursorSlugs([
        ctx.workspace.linuxPath,
        ctx.workspace.windowsPath,
        ctx.workspace.rawPath
      ])
      const promptHint = buildPromptSnippet(ctx.agent.prompt)
      const targetMs = agentActivityTimestamp(ctx.agent)

      for (const root of ctx.homeRoots) {
        const projectsDir = path.join(root.homeWin, '.cursor', 'projects')
        if (!(await fileExists(projectsDir))) continue

        for (const slug of slugHints) {
          if (sid) {
            const nested = path.join(projectsDir, slug, 'agent-transcripts', sid, `${sid}.jsonl`)
            if (await fileExists(nested)) {
              targetPath = nested
              break
            }
            const flat = path.join(projectsDir, slug, 'agent-transcripts', `${sid}.jsonl`)
            if (await fileExists(flat)) {
              targetPath = flat
              break
            }
          }

          const txDir = path.join(projectsDir, slug, 'agent-transcripts')
          if (await fileExists(txDir)) {
            const files = await findMatchingFiles(txDir, (name) => name.endsWith('.jsonl'), {
              maxDepth: 2,
              maxDirs: 60,
              descendingDirs: true
            })
            if (files.length > 0) {
              if (promptHint) {
                for (const f of files.slice(0, 15)) {
                  const head = await readHeadUtf8(f.path, 16_384)
                  if (head.includes(promptHint)) {
                    targetPath = f.path
                    break
                  }
                }
              }
              if (!targetPath) {
                const best = pickClosestFileByTimestamp(files, targetMs, 60 * 60_000, true)
                if (best) {
                  targetPath = best.path
                  shouldCache = targetMs <= 0 || Math.abs(best.mtimeMs - targetMs) <= 120_000
                }
              }
              if (targetPath) break
            }
          }
        }
        if (targetPath) break

        if (sid) {
          const matched = await findMatchingFiles(
            projectsDir,
            (name, fullPath) => name === `${sid}.jsonl` && fullPath.includes('agent-transcripts'),
            { maxDepth: 4, maxDirs: 80, descendingDirs: false }
          )
          if (matched[0]) {
            targetPath = matched[0].path
            shouldCache = true
            break
          }
        }
      }
      if (targetPath && shouldCache) this.transcriptPathByAgentKey.set(cacheKey, targetPath)
    }

    if (!targetPath) {
      return { path: null, totalChars: 0, messageCount: 0, tools: [] }
    }

    const res = await this.transcriptTailer.readIncremental(
      targetPath,
      createCursorTranscriptState,
      ingestCursorTranscriptLine
    )
    if (!res.exists) {
      this.transcriptPathByAgentKey.delete(cacheKey)
      return { path: null, totalChars: 0, messageCount: 0, tools: [] }
    }

    return {
      path: targetPath,
      totalChars: res.state.totalChars,
      messageCount: res.state.messageCount,
      tools: [...res.state.tools.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    }
  }
}

function buildCursorSlugs(paths: (string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    const clean = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!clean) continue
    const preserveCase = clean.replace(/^\/+/, '').replace(/[\\/:._ ]+/g, '-')
    if (preserveCase) out.add(preserveCase)
    const lower = preserveCase.toLowerCase()
    if (lower) out.add(lower)
  }
  return [...out]
}

function readString(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null
}

function readNumber(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : 0
}
