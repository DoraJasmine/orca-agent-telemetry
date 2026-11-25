import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { OrcaContextCollector } from './collectors/orca-context'
import { WslEnvironmentResolver } from './collectors/wsl-env'
import { TelemetryLogger } from './logger'
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
          },
          {
            terminalId: 'term-2',
            title: 'codex',
            agent: 'codex',
            state: 'waiting',
            stateStartedAt: 1_699_999_900_000,
            sessionId: 'sess-codex-2',
            task: { title: 'Follow-up' }
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
    assert.equal(snap.pinnedAgentKey, null)
    assert.equal(snap.source, 'orca-session')
    assert.equal(snap.tokens.total, 12_345)
    assert.equal(snap.git.branch, 'main')
    assert.ok(snap.diagnostics.length > 0)

    const pinned = await worker.request('telemetry.selectAgent', { agentKey: 'term-2' })
    assert.equal(pinned.pinnedAgentKey, 'term-2')
    assert.equal(pinned.activeAgent?.agent, 'codex')

    const autoResumed = await worker.request('telemetry.selectAgent', { agentKey: '__auto__' })
    assert.equal(autoResumed.pinnedAgentKey, null)
    assert.equal(autoResumed.activeAgent?.key, 'term-1')

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

test('OrcaContextCollector falls back from selector_not_found and resolves paired WSL Native Chat', async () => {
  const logs: string[] = []
  const logger = new TelemetryLogger({ sink: (m) => logs.push(m), logFilePath: null })
  const collector = new OrcaContextCollector({ logger, enableCliFallback: true })

  const wslEnv = new WslEnvironmentResolver({
    runner: async (file, args) => {
      if (file === 'wsl.exe' && args.includes('--running')) {
        return { stdout: 'Ubuntu-22.04\r\n', stderr: '', exitCode: 0 }
      }
      if (args[0] === 'environment' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { environments: [{ id: 'env-wsl-1', name: 'WSL' }] }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      if (args[0] === 'worktree' && args[1] === 'ps') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'repo-1::/home/dora/compareExp',
                  repo: 'compareExp',
                  path: '/home/dora/compareExp',
                  branch: 'master',
                  displayName: 'compareExp',
                  lastActivityAt: 1_795_587_425_812,
                  agents: [
                    {
                      paneKey: 'structured-agent-session-older:1',
                      orcaSessionId: 'older-chat',
                      state: 'done',
                      agentType: 'kimi',
                      conversationName: 'Old Chat',
                      prompt: 'old task',
                      stateStartedAt: 1_795_500_000_000,
                      updatedAt: 1_795_500_000_000
                    },
                    {
                      paneKey: 'structured-agent-session-newer:2',
                      orcaSessionId: 'newer-chat',
                      state: 'done',
                      agentType: 'codex',
                      conversationName: 'Hello',
                      prompt: 'hello',
                      stateStartedAt: 1_795_587_425_787,
                      updatedAt: 1_795_587_425_791
                    }
                  ]
                }
              ]
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    },
    pathExists: async (p) => p === '\\\\wsl.localhost\\Ubuntu-22.04\\home\\dora\\compareExp'
  })

  // Simulate paired-environment workspace where `agents.list({ workspaceId })` throws `selector_not_found`.
  const fakeOrca = {
    host: {
      has: () => true,
      call: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'workspace.readContext') {
          return {
            workspaceId: 'env-ws-unknown',
            branch: '',
            displayName: 'compareExp',
            terminals: []
          }
        }
        if (method === 'workspace.list') {
          return { workspaces: [], truncated: false }
        }
        if (method === 'agents.list') {
          if (params && params.workspaceId) {
            throw hostError('action_failed', 'selector_not_found')
          }
          return { agents: [] }
        }
        if (method === 'agent.listSessions') {
          if (params && params.workspaceId) {
            throw hostError('action_failed', 'selector_not_found')
          }
          return { sessions: [], truncated: false }
        }
        return null
      }
    }
  } as unknown as OrcaWorkerApi

  const ctx = await collector.collect(fakeOrca, wslEnv)
  assert.equal(ctx.workspace.hostKind, 'wsl')
  assert.equal(ctx.workspace.wslDistro, 'Ubuntu-22.04')
  assert.equal(ctx.workspace.linuxPath, '/home/dora/compareExp')
  assert.equal(ctx.branch, 'master')
  assert.equal(ctx.agents.length, 2)
  // Sorted newest-first so `codex` ("Hello") comes before `kimi` ("Old Chat").
  assert.equal(ctx.agents[0].agent, 'codex')
  assert.equal(ctx.agents[0].title, 'Hello')
  assert.equal(ctx.agents[0].prompt, 'hello')
  assert.ok(logs.some((l) => l.includes('Matched paired environment "WSL"')))
})
