import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('worker answers telemetry requests, passes hooks, and updates settings', async () => {
  const host = mockHost({
    settings: {
      cursorHookEnabled: false,
      showStatusBar: true,
      showEstimatedCost: true
    },
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-1',
        branch: 'main',
        displayName: 'demo-repo',
        terminals: [{ id: 'term-1', title: 'kimi' }]
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'demo-repo',
            path: 'ssh:invalid-path',
            branch: 'main',
            hostId: 'ssh:devbox'
          }
        ],
        truncated: false
      },
      'agents.list': {
        agents: [
          {
            terminalId: 'term-1',
            title: 'kimi',
            agent: 'kimi',
            state: 'working',
            stateStartedAt: 1_700_000_000_000,
            sessionId: 'sess-kimi-1',
            task: { title: 'Test task' }
          }
        ]
      },
      'agent.listSessions': {
        sessions: [
          {
            sessionId: 'sess-kimi-1',
            agent: 'kimi',
            title: 'Test task',
            workspaceId: 'ws-1',
            hostId: 'ssh:devbox',
            branch: 'main',
            createdAt: 1_699_999_900_000,
            updatedAt: 1_700_000_000_000,
            messageCount: 4,
            totalTokens: 12_345,
            running: true
          }
        ],
        truncated: false
      },
      'statusBar.update': { ok: true }
    }
  })

  const worker = await mountWorker(main, { host })
  try {
    const snap = await worker.request('telemetry.getSnapshot', { forceRefresh: true })
    assert.equal(snap.workspace.displayName, 'demo-repo')
    assert.equal(snap.activeAgent?.agent, 'kimi')
    assert.equal(snap.source, 'orca-session')
    assert.equal(snap.tokens.total, 12_345)
    assert.equal(snap.git.branch, 'main')

    const hookDecision = await worker.hooks.fire('agent.prompt.before', {
      agent: 'kimi',
      terminalId: 'term-1',
      prompt: 'hello',
      inputKind: 'driving'
    })
    assert.equal(hookDecision.kind, 'continue')

    const updated = await worker.request('telemetry.updateSettings', {
      showStatusBar: false,
      showEstimatedCost: false
    })
    assert.equal(updated.settings.showStatusBar, false)
    assert.equal(updated.settings.showEstimatedCost, false)

    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})
