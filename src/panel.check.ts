import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {
    results: {
      'workspace.readContext': null,
      'workspace.list': { workspaces: [], truncated: false },
      'agents.list': { agents: [] },
      'agent.listSessions': { sessions: [], truncated: false }
    }
  },
  wslActive: {
    settings: {
      cursorHookEnabled: true,
      showStatusBar: true,
      showEstimatedCost: true
    },
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'feat/telemetry',
        displayName: 'compareExp',
        terminals: [{ id: 't-1', title: 'codex' }]
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'compareExp',
            path: '/home/dev/compareExp',
            branch: 'feat/telemetry',
            hostId: 'ssh:devbox'
          }
        ],
        truncated: false
      },
      'agents.list': {
        agents: [
          {
            terminalId: 't-1',
            title: 'codex',
            agent: 'codex',
            state: 'working',
            stateStartedAt: Date.now() - 12_000,
            sessionId: 'sess-demo',
            task: { title: 'Implement telemetry sidebar' }
          }
        ]
      },
      'agent.listSessions': {
        sessions: [
          {
            sessionId: 'sess-demo',
            agent: 'codex',
            title: 'Implement telemetry sidebar',
            workspaceId: 'ws-1',
            hostId: 'local',
            branch: 'feat/telemetry',
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now(),
            messageCount: 8,
            totalTokens: 42_500,
            running: true
          }
        ],
        truncated: false
      }
    }
  }
})
