import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { TelemetrySnapshot } from './protocol'

function makeSnapshot(overrides?: Partial<TelemetrySnapshot>): TelemetrySnapshot {
  const base: TelemetrySnapshot = {
    updatedAt: 1_700_000_000_000,
    workspace: {
      workspaceId: 'ws-1',
      displayName: 'compareExp',
      rawPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\compareExp',
      hostKind: 'wsl',
      wslDistro: 'Ubuntu',
      linuxPath: '/home/alice/compareExp',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\compareExp'
    },
    agents: [
      {
        key: 't-1',
        agent: 'codex',
        title: 'codex',
        state: 'working',
        stateStartedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        sessionId: 's-1',
        terminalId: 't-1',
        taskTitle: 'Fix telemetry',
        prompt: 'Fix telemetry'
      },
      {
        key: 't-2',
        agent: 'cursor',
        title: 'cursor',
        state: 'waiting',
        stateStartedAt: 1_699_999_950_000,
        updatedAt: 1_699_999_950_000,
        sessionId: 's-2',
        terminalId: 't-2',
        taskTitle: null,
        prompt: null
      }
    ],
    selectedAgentKey: 't-1',
    activeAgent: {
      key: 't-1',
      agent: 'codex',
      title: 'codex',
      state: 'working',
      stateStartedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      sessionId: 's-1',
      terminalId: 't-1',
      taskTitle: 'Fix telemetry',
      prompt: 'Fix telemetry'
    },
    source: 'codex-jsonl',
    sourceLabel: 'Codex JSONL',
    logPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\sessions\\rollout.jsonl',
    context: {
      usedTokens: 100_000,
      limitTokens: 258_400,
      percent: 38.7,
      isEstimated: false,
      compactedDetected: false,
      model: 'gpt-5-codex'
    },
    tokens: {
      inputUncached: 12_000,
      inputTotal: 96_000,
      output: 4_000,
      reasoning: 500,
      cacheRead: 84_000,
      cacheWrite: 0,
      total: 100_500,
      cacheHitRatePct: 87.5,
      estimatedCostUsd: 0.0706,
      turnCount: 6
    },
    speed: {
      turnTokPerSec: 72.4,
      rollingTokPerSec: 65.1,
      sessionAvgTokPerSec: 59.8,
      lastTurnOutputTokens: 820,
      lastTurnDurationMs: 11_325
    },
    recentTools: [{ name: 'shell', count: 4, lastAt: 1_700_000_000_000 }],
    git: {
      available: true,
      source: 'wsl-git',
      branch: 'feat/wsl-telemetry',
      upstream: 'origin/feat/wsl-telemetry',
      ahead: 2,
      behind: 0,
      modified: 3,
      added: 1,
      deleted: 0,
      untracked: 2,
      linesAdded: 145,
      linesDeleted: 28,
      lastCommit: {
        hash: 'a1b2c3d',
        subject: 'Add WSL adapter',
        authoredAtMs: 1_699_999_000_000
      },
      files: [{ status: 'M', path: 'src/worker.ts', added: 42, deleted: 5 }]
    },
    cursorHook: {
      enabled: false,
      installed: false,
      targetEnv: 'wsl',
      distro: 'Ubuntu',
      hooksJsonPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.cursor\\hooks.json',
      spoolPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.orca-telemetry\\cursor-usage.jsonl',
      lastEventAt: null
    },
    settings: {
      showStatusBar: true,
      showEstimatedCost: true,
      cursorHookEnabled: false
    },
    diagnostics: ['[INFO] [worker] Activated']
  }
  return { ...base, ...overrides }
}

test('renders WSL context, speed, git telemetry and toggles Cursor hook', async () => {
  let snap = makeSnapshot()
  const host = mockHost({
    requests: {
      'telemetry.setPanelVisible': () => ({ ok: true }),
      'telemetry.getSnapshot': () => snap,
      'telemetry.selectAgent': ({ agentKey }) => {
        const nextAgent = snap.agents.find((a) => a.key === agentKey) ?? snap.activeAgent
        snap = makeSnapshot({
          selectedAgentKey: agentKey,
          activeAgent: nextAgent,
          source: 'cursor-transcript',
          sourceLabel: 'Cursor Transcript + Orca'
        })
        return snap
      },
      'telemetry.toggleCursorHook': ({ enabled }) => {
        snap = makeSnapshot({
          cursorHook: { ...snap.cursorHook, enabled, installed: enabled },
          settings: { ...snap.settings, cursorHookEnabled: enabled }
        })
        return snap
      },
      'telemetry.updateSettings': (patch) => {
        snap = makeSnapshot({
          settings: { ...snap.settings, ...patch }
        })
        return snap
      }
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'WSL · Ubuntu' }))
  assert.ok(view.find({ text: '38.7%' }))
  assert.ok(view.find({ text: '72.4' }))
  assert.ok(view.find({ text: 'feat/wsl-telemetry' }))
  assert.ok(view.find({ text: '+145 / -28' }))

  await view.select({ label: 'Active Agent' }, 't-2')
  assert.ok(view.find({ text: 'Cursor Transcript + Orca' }))

  await view.toggle({ label: 'Cursor Hook 精确统计' })
  assert.equal(view.valueOf({ label: 'Cursor Hook 精确统计' }), true)
  assert.ok(view.find({ text: /WSL \(Ubuntu\) 已挂载/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
