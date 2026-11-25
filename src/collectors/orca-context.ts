import type { OrcaWorkerApi } from 'orca/worker'
import type { TelemetryLogger } from '../logger'
import type { AgentOption, AgentState, WorkspaceEnv } from '../protocol'
import type { WslEnvironmentResolver } from './wsl-env'

export type OrcaSessionSummary = {
  sessionId: string
  agent: string
  title: string
  workspaceId: string | null
  hostId: string
  branch: string | null
  createdAt: number | null
  updatedAt: number
  messageCount: number
  totalTokens: number
  running: boolean
}

export type OrcaWorkspaceContext = {
  workspace: WorkspaceEnv
  branch: string | null
  agents: AgentOption[]
  sessions: OrcaSessionSummary[]
}

type CliEnvironment = {
  id: string
  name: string
}

type CliWorktreeAgent = {
  paneKey?: string
  address?: string
  orcaSessionId?: string | null
  state?: AgentState
  agentType?: string | null
  prompt?: string | null
  taskTitle?: string | null
  displayName?: string | null
  conversationName?: string | null
  stateStartedAt?: number
  updatedAt?: number
}

type CliWorktree = {
  worktreeId?: string
  worktreeInstanceId?: string
  repo?: string
  path?: string
  branch?: string
  displayName?: string
  isActive?: boolean
  lastActivityAt?: number
  agents?: CliWorktreeAgent[]
  environment?: { id?: string; name?: string }
}

export class OrcaContextCollector {
  private readonly logger?: TelemetryLogger
  private readonly enableCliFallback: boolean
  private sessionsCache: { key: string; at: number; items: OrcaSessionSummary[] } | null = null
  private envListCache: { at: number; items: CliEnvironment[] } | null = null
  private worktreePsCache = new Map<string, { at: number; items: CliWorktree[] }>()
  private readonly unsupportedWorkspaceIds = new Set<string>()

  constructor(options?: { logger?: TelemetryLogger; enableCliFallback?: boolean }) {
    this.logger = options?.logger
    this.enableCliFallback = options?.enableCliFallback ?? true
  }

  async collect(
    orca: OrcaWorkerApi,
    wslEnv: WslEnvironmentResolver,
    options?: { forceSessions?: boolean; preferCachedCli?: boolean }
  ): Promise<OrcaWorkspaceContext> {
    const focused = await safeCall(orca, 'workspace.readContext', undefined, this.logger)
    if (focused) {
      this.logger?.logOnce(
        `focused:${focused.workspaceId ?? ''}:${focused.displayName}`,
        'INFO',
        'orca-context',
        `Focused context: id=${focused.workspaceId ?? 'none'} name="${focused.displayName}" terminals=${focused.terminals.length}`
      )
    }
    const listedWorkspaces = orca.host.has('workspace.list')
      ? await safeCall(orca, 'workspace.list', { includeStatus: true }, this.logger)
      : null

    const allWs = listedWorkspaces?.workspaces ?? []
    let matchedWs = focused?.workspaceId
      ? allWs.find((w) => w.id === focused.workspaceId)
      : undefined
    if (!matchedWs && focused) {
      matchedWs = allWs.find((w) => w.name === focused.displayName && w.branch === focused.branch)
    }
    if (!matchedWs && !focused && allWs.length > 0) {
      matchedWs = allWs[0]
    }

    const workspaceId = focused?.workspaceId ?? matchedWs?.id ?? null
    let displayName = focused?.displayName ?? matchedWs?.name ?? 'No Workspace'
    let branch = focused?.branch || matchedWs?.branch || null
    let rawPath: string | null = matchedWs?.path ?? null
    let hostId: string | null = matchedWs?.hostId ?? null

    // Read focused agents from Host API: try `{ workspaceId }`, fall back to `undefined` on `selector_not_found`.
    let rawAgents: {
      terminalId: string | null
      title: string | null
      agent: string | null
      state: AgentState
      stateStartedAt: number
      sessionId?: string | null
      task?: { title: string } | null
    }[] = []

    if (orca.host.has('agents.list')) {
      const canQueryByWs = Boolean(workspaceId && !this.unsupportedWorkspaceIds.has(workspaceId))
      let agentsRes = canQueryByWs
        ? await safeCall(orca, 'agents.list', { workspaceId: workspaceId! }, this.logger, true)
        : null
      if (!agentsRes && workspaceId && canQueryByWs) {
        this.unsupportedWorkspaceIds.add(workspaceId)
      }
      if (!agentsRes && (!workspaceId || !this.unsupportedWorkspaceIds.has(`focused:${workspaceId}`))) {
        agentsRes = await safeCall(orca, 'agents.list', undefined, this.logger, true)
        if (!agentsRes && workspaceId) {
          this.unsupportedWorkspaceIds.add(`focused:${workspaceId}`)
        }
      }
      rawAgents = agentsRes?.agents ?? []
    }

    const hostAgents: AgentOption[] = rawAgents.map((item, idx) => ({
      key: item.terminalId ?? item.sessionId ?? `${item.agent ?? 'agent'}:${idx}`,
      agent: item.agent ?? 'unknown',
      title: item.title ?? null,
      state: item.state,
      stateStartedAt: item.stateStartedAt,
      updatedAt: item.stateStartedAt,
      sessionId: item.sessionId ?? null,
      terminalId: item.terminalId ?? null,
      taskTitle: item.task?.title ?? null,
      prompt: null
    }))

    // Paired environments (like `--environment WSL`) are omitted from local `workspace.list`, and
    // Native Chat sessions (`structured-agent-session-...`) appear in `orca worktree ps --environment`.
    let envAgents: AgentOption[] = []
    let matchedEnvId: string | null = null

    if (this.enableCliFallback && focused && (!rawPath || hostAgents.length === 0)) {
      const envMatch = await this.findInPairedEnvironments(
        wslEnv,
        focused,
        options?.forceSessions ?? false,
        options?.preferCachedCli ?? false
      )
      if (envMatch) {
        matchedEnvId = envMatch.env.id
        if (!rawPath && envMatch.worktree.path) {
          rawPath = envMatch.worktree.path
          hostId = `environment:${envMatch.env.name}`
        }
        if (!branch && envMatch.worktree.branch) {
          branch = envMatch.worktree.branch
        }
        if (envMatch.worktree.displayName && displayName === 'No Workspace') {
          displayName = envMatch.worktree.displayName
        }
        envAgents = mapCliAgents(envMatch.worktree.agents ?? [])
        this.logger?.logOnce(
          `env-match:${envMatch.env.id}:${rawPath ?? ''}`,
          'INFO',
          'orca-context',
          `Matched paired environment "${envMatch.env.name}" worktree "${rawPath ?? displayName}" (${envAgents.length} agents)`
        )
      }
    }

    const agents = mergeAndSortAgents(hostAgents, envAgents)
    const workspace = await wslEnv.resolveWorkspaceEnv({
      workspaceId,
      displayName,
      rawPath,
      hostId
    })

    this.logger?.logOnce(
      `ws-resolved:${workspace.workspaceId ?? workspace.displayName}:${workspace.hostKind}:${workspace.wslDistro ?? ''}:${workspace.windowsPath ?? ''}`,
      'INFO',
      'orca-context',
      `Workspace "${workspace.displayName}" resolved as ${workspace.hostKind}${workspace.wslDistro ? ` (${workspace.wslDistro})` : ''}${matchedEnvId ? ` [env:${matchedEnvId}]` : ''}, path=${workspace.linuxPath ?? workspace.windowsPath ?? 'none'}, agents=${agents.length}`
    )

    const sessions = await this.readSessionsCached(
      orca,
      matchedWs?.id ?? null,
      options?.forceSessions ?? false
    )

    return { workspace, branch, agents, sessions }
  }

  private async findInPairedEnvironments(
    wslEnv: WslEnvironmentResolver,
    focused: { workspaceId?: string; branch: string; displayName: string },
    force: boolean,
    preferCachedCli = false
  ): Promise<{ env: CliEnvironment; worktree: CliWorktree } | null> {
    const envs = await this.listEnvironmentsCached(wslEnv, force && !preferCachedCli)
    if (envs.length === 0) return null

    const candidates: { env: CliEnvironment; worktree: CliWorktree; score: number }[] = []

    for (const env of envs) {
      const worktrees = await this.readWorktreePsCached(
        wslEnv,
        env.id,
        force && !preferCachedCli,
        preferCachedCli
      )
      for (const wt of worktrees) {
        let score = 0
        const exactId =
          Boolean(focused.workspaceId && wt.worktreeId) &&
          (wt.worktreeId === focused.workspaceId || wt.worktreeInstanceId === focused.workspaceId)
        if (exactId) {
          score += 1000
        } else if (
          focused.workspaceId &&
          wt.worktreeId &&
          (wt.worktreeId.includes(focused.workspaceId) || focused.workspaceId.includes(wt.worktreeId))
        ) {
          // Only grant partial ID credit when display names don't point to a distinct workspace chat.
          score += !focused.displayName || wt.displayName === focused.displayName ? 120 : 20
        }
        if (focused.displayName) {
          if (wt.displayName === focused.displayName) score += 250
          else if (wt.repo === focused.displayName) score += 25
        }
        if (focused.branch && wt.branch && wt.branch === focused.branch) {
          score += 15
        }
        if (wt.isActive) score += 10
        if (score > 0) {
          candidates.push({ env, worktree: wt, score })
        }
      }
    }

    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.worktree.lastActivityAt ?? 0) - (a.worktree.lastActivityAt ?? 0)
    })
    return { env: candidates[0].env, worktree: candidates[0].worktree }
  }

  private async listEnvironmentsCached(
    wslEnv: WslEnvironmentResolver,
    force: boolean
  ): Promise<CliEnvironment[]> {
    const now = Date.now()
    // Paired environments rarely change; cache non-empty list for 5 minutes even across forced refreshes.
    if (this.envListCache && this.envListCache.items.length > 0 && now - this.envListCache.at < 300_000) {
      return this.envListCache.items
    }
    if (!force && this.envListCache && now - this.envListCache.at < 10_000) {
      return this.envListCache.items
    }
    const res = await wslEnv.execOrcaCli(['environment', 'list', '--json'], { timeoutMs: 5000 })
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      const detail = extractCliFailureDetail(res)
      if (detail) {
        this.logger?.logOnce('orca-env-list-err', 'WARN', 'orca-cli', `environment list failed: ${detail}`)
      }
      if (this.envListCache && this.envListCache.items.length > 0) {
        return this.envListCache.items
      }
      this.envListCache = { at: now, items: [] }
      return []
    }
    try {
      const parsed = JSON.parse(res.stdout) as {
        ok?: boolean
        result?: { environments?: CliEnvironment[] }
      }
      const items = parsed.ok && Array.isArray(parsed.result?.environments) ? parsed.result.environments : []
      this.envListCache = { at: now, items }
      return items
    } catch {
      return this.envListCache?.items ?? []
    }
  }

  private async readWorktreePsCached(
    wslEnv: WslEnvironmentResolver,
    envId: string,
    force: boolean,
    preferCached = false
  ): Promise<CliWorktree[]> {
    const now = Date.now()
    const cached = this.worktreePsCache.get(envId)
    const maxAgeMs = preferCached ? 15_000 : 2500
    if (!force && cached && now - cached.at < maxAgeMs) {
      return cached.items
    }
    const res = await wslEnv.execOrcaCli(['worktree', 'ps', '--environment', envId, '--json'], {
      timeoutMs: 7500
    })
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      const detail = extractCliFailureDetail(res)
      if (detail) {
        this.logger?.logOnce(`orca-wt-ps:${envId}`, 'WARN', 'orca-cli', `worktree ps failed (${envId}): ${detail}`)
      }
      return cached?.items ?? []
    }
    try {
      const parsed = JSON.parse(res.stdout) as {
        ok?: boolean
        result?: { worktrees?: CliWorktree[] }
      }
      const items = parsed.ok && Array.isArray(parsed.result?.worktrees) ? parsed.result.worktrees : []
      this.worktreePsCache.set(envId, { at: now, items })
      return items
    } catch {
      return cached?.items ?? []
    }
  }

  private async readSessionsCached(
    orca: OrcaWorkerApi,
    workspaceId: string | null,
    force: boolean
  ): Promise<OrcaSessionSummary[]> {
    if (!orca.host.has('agent.listSessions')) return []
    const now = Date.now()
    const cacheKey = workspaceId ?? '__all__'
    if (
      !force &&
      this.sessionsCache &&
      this.sessionsCache.key === cacheKey &&
      now - this.sessionsCache.at < 8_000
    ) {
      return this.sessionsCache.items
    }
    let res = workspaceId
      ? await safeCall(orca, 'agent.listSessions', { workspaceId, limit: 30 }, this.logger, true)
      : null
    if (!res) {
      res = await safeCall(orca, 'agent.listSessions', { limit: 30 }, this.logger)
    }
    const items = res?.sessions ?? []
    this.sessionsCache = { key: cacheKey, at: now, items }
    return items
  }
}

function mapCliAgents(raw: CliWorktreeAgent[]): AgentOption[] {
  return raw.map((item, idx) => {
    const terminalId = item.address?.startsWith('term_') ? item.address : null
    const sessionId = item.orcaSessionId ?? null
    const key = item.paneKey ?? terminalId ?? sessionId ?? `${item.agentType ?? 'agent'}:${idx}`
    const title = item.conversationName ?? item.displayName ?? item.taskTitle ?? null
    const state: AgentState = item.state ?? 'waiting'
    const stateStartedAt = item.stateStartedAt ?? 0
    return {
      key,
      agent: item.agentType ?? 'unknown',
      title,
      state,
      stateStartedAt,
      updatedAt: item.updatedAt ?? stateStartedAt,
      sessionId,
      terminalId,
      taskTitle: item.taskTitle ?? null,
      prompt: item.prompt ? item.prompt.slice(0, 160) : null
    }
  })
}

function mergeAndSortAgents(hostAgents: AgentOption[], envAgents: AgentOption[]): AgentOption[] {
  const merged: AgentOption[] = []

  const findMatchIndex = (candidate: AgentOption): number =>
    merged.findIndex(
      (existing) =>
        (candidate.sessionId && existing.sessionId === candidate.sessionId) ||
        (candidate.terminalId && existing.terminalId === candidate.terminalId) ||
        existing.key === candidate.key
    )

  for (const a of [...envAgents, ...hostAgents]) {
    const idx = findMatchIndex(a)
    if (idx < 0) {
      merged.push(a)
    } else {
      const existing = merged[idx]
      merged[idx] = {
        ...existing,
        ...a,
        sessionId: a.sessionId ?? existing.sessionId,
        terminalId: a.terminalId ?? existing.terminalId,
        title: a.title ?? existing.title,
        prompt: a.prompt ?? existing.prompt,
        taskTitle: a.taskTitle ?? existing.taskTitle,
        updatedAt: Math.max(a.updatedAt ?? 0, existing.updatedAt ?? 0) || null
      }
    }
  }

  return merged.sort((a, b) => {
    const aTime = Math.max(a.updatedAt ?? 0, a.stateStartedAt)
    const bTime = Math.max(b.updatedAt ?? 0, b.stateStartedAt)
    return bTime - aTime
  })
}

async function safeCall<M extends Parameters<OrcaWorkerApi['host']['call']>[0]>(
  orca: OrcaWorkerApi,
  method: M,
  params: Parameters<OrcaWorkerApi['host']['call']>[1],
  logger?: TelemetryLogger,
  quietSelectorError = false
): Promise<Awaited<ReturnType<OrcaWorkerApi['host']['call']>> | null> {
  try {
    // @ts-expect-error Union call signature forwarding across host methods.
    return await orca.host.call(method, params)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      !(
        quietSelectorError &&
        (msg.includes('selector_not_found') || msg.includes('no workspace has this id'))
      )
    ) {
      logger?.logOnce(`host-call:${String(method)}:${msg}`, 'WARN', 'orca-host', `${String(method)} failed: ${msg}`)
    }
    return null
  }
}

function extractCliFailureDetail(res: { stdout: string; stderr: string }): string {
  const out = res.stdout.trim()
  if (out.startsWith('{')) {
    try {
      const parsed = JSON.parse(out) as { error?: { code?: string; message?: string } }
      if (parsed.error?.message) {
        return parsed.error.code
          ? `${parsed.error.code}: ${parsed.error.message}`
          : parsed.error.message
      }
    } catch {
      // Fall through to raw stderr/stdout.
    }
  }
  return res.stderr.trim() || out
}
