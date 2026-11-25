import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { createAgyState, ingestAgyLine } from './adapters/agy'
import { createCodexState, ingestCodexLine } from './adapters/codex'
import {
  createCursorHookState,
  createCursorTranscriptState,
  ingestCursorHookLine,
  ingestCursorTranscriptLine
} from './adapters/cursor'
import { createKimiState, ingestKimiLine } from './adapters/kimi'
import { JsonlTailer } from './adapters/tailer'
import { parseGitOutputs } from './collectors/git'
import {
  parseWslUncPath,
  toWslUncPath,
  WslEnvironmentResolver
} from './collectors/wsl-env'
import { computeMetrics } from './engine/metrics'
import { hasTelemetryHookInstalled, mergeCursorHooksJson } from './helpers/cursor-hook'

test('parses and resolves WSL UNC and experimental WSL host paths', async () => {
  assert.deepEqual(parseWslUncPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo'), {
    distro: 'Ubuntu-24.04',
    linuxPath: '/home/alice/repo'
  })
  assert.equal(
    toWslUncPath('Ubuntu-24.04', '/home/alice/repo'),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo'
  )

  const resolver = new WslEnvironmentResolver({
    runner: async (_file, args) => {
      if (args.includes('--running')) {
        return { stdout: 'Ubuntu-24.04\r\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    },
    pathExists: async (p) => p === '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo'
  })

  const resolved = await resolver.resolveWorkspaceEnv({
    workspaceId: 'ws-1',
    displayName: 'repo',
    rawPath: '/home/alice/repo',
    hostId: 'runtime:wsl:Ubuntu-24.04'
  })
  assert.equal(resolved.hostKind, 'wsl')
  assert.equal(resolved.wslDistro, 'Ubuntu-24.04')
  assert.equal(resolved.windowsPath, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo')
})

test('parses git porcelain v2, numstat, and last commit', () => {
  const snapshot = parseGitOutputs({
    porcelainV2: [
      '# branch.oid abcdef',
      '# branch.head feat/telemetry',
      '# branch.upstream origin/feat/telemetry',
      '# branch.ab +3 -1',
      '1 .M N... 100644 100644 100644 123 456 src/worker.ts',
      '1 A. N... 000000 100644 100644 000 111 src/new.ts',
      '2 R. N... 100644 100644 100644 222 333 R100 src/renamed.ts\tsrc/old.ts',
      '? untracked.txt'
    ].join('\n'),
    unstagedNumstat: '12\t3\tsrc/worker.ts\n',
    stagedNumstat: '20\t0\tsrc/new.ts\n',
    lastCommitLine: 'a1b2c3d\x1fInitial telemetry\x1f1700000000',
    source: 'wsl-git',
    fallbackBranch: 'main'
  })

  assert.equal(snapshot.branch, 'feat/telemetry')
  assert.equal(snapshot.ahead, 3)
  assert.equal(snapshot.behind, 1)
  assert.equal(snapshot.modified, 2)
  assert.equal(snapshot.added, 1)
  assert.equal(snapshot.untracked, 1)
  assert.equal(snapshot.linesAdded, 32)
  assert.equal(snapshot.linesDeleted, 3)
  assert.equal(snapshot.lastCommit?.hash, 'a1b2c3d')
  assert.equal(snapshot.files.length, 4)
})

test('codex parser deduplicates rate-limit token_count events and tracks context window', () => {
  const state = createCodexState()
  ingestCodexLine(
    JSON.stringify({
      timestamp: '2026-11-25T03:00:00Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex' }
    }),
    state,
    1000
  )
  const tokenEvent = JSON.stringify({
    timestamp: '2026-11-25T03:00:05Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 50_000,
          cached_input_tokens: 45_000,
          output_tokens: 500,
          reasoning_output_tokens: 50,
          total_tokens: 50_500
        },
        last_token_usage: {
          input_tokens: 50_000,
          cached_input_tokens: 45_000,
          output_tokens: 500,
          reasoning_output_tokens: 50,
          total_tokens: 50_500
        },
        model_context_window: 258_400
      }
    }
  })

  ingestCodexLine(tokenEvent, state, 2000)
  // Duplicate rate-limit refresh should be ignored.
  ingestCodexLine(tokenEvent, state, 3000)

  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].inputUncached, 5_000)
  assert.equal(state.turns[0].cacheRead, 45_000)
  assert.equal(state.turns[0].durationMs, 5_000)
  assert.equal(state.lastContextUsed, 50_500)
  assert.equal(state.contextWindow, 258_400)
})

test('kimi parser handles turn usage.record and skips session summary records', () => {
  const state = createKimiState()
  ingestKimiLine(
    JSON.stringify({
      type: 'llm.request',
      timestamp: '2026-11-25T03:00:00Z',
      payload: { model: 'kimi-for-coding' }
    }),
    state,
    1000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'usage.record',
      timestamp: '2026-11-25T03:00:04Z',
      payload: {
        scope: 'turn',
        usage: {
          inputOther: 2_000,
          output: 400,
          inputCacheRead: 18_000,
          inputCacheCreation: 1_000
        }
      }
    }),
    state,
    5000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'usage.record',
      timestamp: '2026-11-25T03:00:04Z',
      payload: {
        scope: 'session',
        usage: { inputOther: 99_999, output: 99_999 }
      }
    }),
    state,
    5000
  )

  assert.equal(state.turns.length, 1)
  assert.equal(state.lastContextUsed, 21_400)
  assert.equal(state.turns[0].durationMs, 4_000)
})

test('agy parser handles PLANNER_RESPONSE tokens and step completion timing', () => {
  const state = createAgyState()
  ingestAgyLine(
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-25T03:26:58Z',
      model: 'gemini-4-hydrogen-high',
      input_tokens: 16_016,
      cache_read_tokens: 8_000,
      output_tokens: 300,
      tool_calls: [{ name: 'run_command', args: {} }]
    }),
    state,
    Date.parse('2026-11-25T03:26:58Z')
  )
  ingestAgyLine(
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T03:27:01Z'
    }),
    state,
    Date.parse('2026-11-25T03:27:01Z')
  )

  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].inputUncached, 8_016)
  assert.equal(state.turns[0].cacheRead, 8_000)
  assert.equal(state.turns[0].durationMs, 3_000)
  assert.equal(state.tools.get('run_command')?.count, 1)
})

test('cursor hook & transcript parsers deduplicate generations and merge hooks.json safely', () => {
  const hookState = createCursorHookState()
  ingestCursorHookLine(
    JSON.stringify({
      hook_event_name: 'beforeSubmitPrompt',
      session_id: 'cur-1',
      timestamp: 1_700_000_010_000
    }),
    hookState,
    1_700_000_010_000
  )
  const stopPayload = JSON.stringify({
    hook_event_name: 'stop',
    session_id: 'cur-1',
    generation_id: 'gen-1',
    model: 'cursor-grok-4.6-high-fast',
    input_tokens: 23_666,
    output_tokens: 500,
    cache_read_tokens: 20_000,
    cache_write_tokens: 1_000,
    timestamp: 1_700_000_015_000
  })
  ingestCursorHookLine(stopPayload, hookState, 1_700_000_015_000)
  ingestCursorHookLine(
    stopPayload.replace('"stop"', '"afterAgentResponse"'),
    hookState,
    1_700_000_015_050
  )

  const turns = hookState.turnsBySession.get('cur-1') ?? []
  assert.equal(turns.length, 1)
  assert.equal(turns[0].inputUncached, 2_666)
  assert.equal(turns[0].durationMs, 5_000)

  const metrics = computeMetrics({
    adapter: {
      source: 'cursor-hook',
      sourceLabel: 'Cursor Hook',
      logPath: 'spool.jsonl',
      model: 'cursor-grok-4.6-high-fast',
      contextUsed: 24_166,
      contextLimit: 256_000,
      contextIsEstimated: false,
      compactedDetected: false,
      turns,
      recentTools: []
    },
    showEstimatedCost: true
  })
  assert.equal(metrics.speed.turnTokPerSec, 100)
  assert.equal(metrics.context.percent, 9.4)

  const txState = createCursorTranscriptState()
  ingestCursorTranscriptLine(
    JSON.stringify({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Checking files...' },
          { type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }
        ]
      }
    }),
    txState,
    1000
  )
  assert.equal(txState.tools.get('read_file')?.count, 1)
  assert.ok(txState.totalChars > 17)

  const existingHooks = JSON.stringify({
    version: 1,
    hooks: {
      stop: [{ command: 'echo user-hook' }]
    }
  })
  const installed = mergeCursorHooksJson(existingHooks, 'node "/home/u/.orca-telemetry/cursor-hook.mjs"')
  assert.equal(hasTelemetryHookInstalled(installed), true)
  assert.ok(installed.includes('echo user-hook'))

  const uninstalled = mergeCursorHooksJson(installed, null)
  assert.equal(hasTelemetryHookInstalled(uninstalled), false)
  assert.ok(uninstalled.includes('echo user-hook'))
})

test('incremental tailer reads appended UTF-8 lines without duplicating prior bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-tailer-'))
  const file = path.join(dir, 'log.jsonl')
  try {
    await fs.writeFile(file, '{"n":1,"msg":"中文"}\n{"n":2', 'utf8')
    const tailer = new JsonlTailer<number[]>()
    const first = await tailer.readIncremental(file, () => [], (line, s) => {
      const obj = JSON.parse(line) as { n: number }
      s.push(obj.n)
    })
    assert.deepEqual(first.state, [1])

    await fs.appendFile(file, '}\n{"n":3}\n', 'utf8')
    const second = await tailer.readIncremental(file, () => [], (line, s) => {
      const obj = JSON.parse(line) as { n: number }
      s.push(obj.n)
    })
    assert.deepEqual(second.state, [1, 2, 3])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
