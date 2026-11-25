import type { OrcaWorkerApi } from 'orca/worker'
import type { AgentOption, WorkspaceEnv } from '../protocol'
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

export class OrcaContextCollector {
  private sessionsCache: { workspaceId: string | null; at: number; items: OrcaSessionSummary[] } | null = null

  async collect(
    orca: OrcaWorkerApi,
    wslEnv: WslEnvironmentResolver,
    options?: { forceSessions?: boolean }
  ): Promise<OrcaWorkspaceContext> {
    const focused = await safeCall(orca, 'workspace.readContext', undefined)
    const listedWorkspaces = orca.host.has('workspace.list')
      ? await safeCall(orca, 'workspace.list', { includeStatus: false })
      : null

    const allWs = listedWorkspaces?.workspaces ?? []
    const matchedWs = focused?.workspaceId
      ? allWs.find((w) => w.id === focused.workspaceId)
      : focused
        ? allWs.find((w) => w.name === focused.displayName && w.branch === focused.branch)
        : allWs[0]

    const workspaceId = focused?.workspaceId ?? matchedWs?.id ?? null
    const displayName = focused?.displayName ?? matchedWs?.name ?? 'No Workspace'
    const branch = focused?.branch ?? matchedWs?.branch ?? null

    const workspace = await wslEnv.resolveWorkspaceEnv({
      workspaceId,
      displayName,
      rawPath: matchedWs?.path ?? null,
      hostId: matchedWs?.hostId ?? null
    })

    let rawAgents: {
      terminalId: string | null
      title: string | null
      agent: string | null
      state: 'working' | 'blocked' | 'waiting' | 'done'
      stateStartedAt: number
      sessionId?: string | null
      task?: { title: string } | null
    }[] = []

    if (orca.host.has('agents.list')) {
      const agentsRes = workspaceId
        ? await safeCall(orca, 'agents.list', { workspaceId })
        : await safeCall(orca, 'agents.list', undefined)
      rawAgents = agentsRes?.agents ?? []
    }

    const agents: AgentOption[] = rawAgents.map((item, idx) => ({
      key: item.terminalId ?? item.sessionId ?? `${item.agent ?? 'agent'}:${idx}`,
      agent: item.agent ?? 'unknown',
      title: item.title ?? null,
      state: item.state,
      stateStartedAt: item.stateStartedAt,
      sessionId: item.sessionId ?? null,
      terminalId: item.terminalId ?? null,
      taskTitle: item.task?.title ?? null
    }))

    const sessions = await this.readSessionsCached(orca, workspaceId, options?.forceSessions ?? false)
    return { workspace, branch, agents, sessions }
  }

  private async readSessionsCached(
    orca: OrcaWorkerApi,
    workspaceId: string | null,
    force: boolean
  ): Promise<OrcaSessionSummary[]> {
    if (!orca.host.has('agent.listSessions')) return []
    const now = Date.now()
    if (
      !force &&
      this.sessionsCache &&
      this.sessionsCache.workspaceId === workspaceId &&
      now - this.sessionsCache.at < 8_000
    ) {
      return this.sessionsCache.items
    }
    const res = await safeCall(
      orca,
      'agent.listSessions',
      workspaceId ? { workspaceId, limit: 30 } : { limit: 30 }
    )
    const items = res?.sessions ?? []
    this.sessionsCache = { workspaceId, at: now, items }
    return items
  }
}

async function safeCall<M extends Parameters<OrcaWorkerApi['host']['call']>[0]>(
  orca: OrcaWorkerApi,
  method: M,
  params: Parameters<OrcaWorkerApi['host']['call']>[1]
): Promise<Awaited<ReturnType<OrcaWorkerApi['host']['call']>> | null> {
  try {
    // @ts-expect-error Union call signature forwarding across host methods.
    return await orca.host.call(method, params)
  } catch {
    return null
  }
}
