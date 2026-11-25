import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { AgyAdapter, createAgyState, ingestAgyLine } from './adapters/agy'
import { CodexAdapter, createCodexState, ingestCodexLine } from './adapters/codex'
import {
  createCursorHookState,
  createCursorTranscriptState,
  CursorAdapter,
  ingestCursorHookLine,
  ingestCursorTranscriptLine
} from './adapters/cursor'
import { createKimiState, ingestKimiLine, KimiAdapter } from './adapters/kimi'
import { JsonlTailer } from './adapters/tailer'
import type { AdapterContext } from './adapters/types'
import { parseGitOutputs } from './collectors/git'
import {
  parseWslUncPath,
  toWslUncPath,
  WslEnvironmentResolver
} from './collectors/wsl-env'
import { computeMetrics } from './engine/metrics'
import { hasTelemetryHookInstalled, mergeCursorHooksJson } from './helpers/cursor-hook'
import { TelemetryLogger } from './logger'
import type { AgentOption, WorkspaceEnv } from './protocol'

function makeAdapterCtx(homeDir: string, agent: Partial<AgentOption>, workspace?: Partial<WorkspaceEnv>): AdapterContext {
  const ws: WorkspaceEnv = {
    workspaceId: 'ws-1',
    displayName: 'compareExp',
    rawPath: '/home/dora/lyfLearn/3dGS/compareExp',
    hostKind: 'wsl',
    wslDistro: 'Ubuntu-22.04',
    linuxPath: '/home/dora/lyfLearn/3dGS/compareExp',
    windowsPath: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\dora\\lyfLearn\\3dGS\\compareExp',
    ...workspace
  }
  const fullAgent: AgentOption = {
    key: agent.key ?? 'agent-1',
    agent: agent.agent ?? 'codex',
    title: agent.title ?? null,
    state: agent.state ?? 'done',
    stateStartedAt: agent.stateStartedAt ?? 1_795_587_425_000,
    updatedAt: agent.updatedAt ?? 1_795_587_425_000,
    sessionId: agent.sessionId ?? 'orca-chat-uuid',
    terminalId: agent.terminalId ?? null,
    taskTitle: agent.taskTitle ?? null,
    prompt: agent.prompt ?? null
  }
  return {
    agent: fullAgent,
    workspace: ws,
    homeRoots: [{ env: 'windows', distro: null, homeWin: homeDir, homeLinux: '/home/dora' }],
    orcaSession: null,
    cursorHookEnabled: false,
    modelOverrides: {}
  }
}

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
  ingestCodexLine(tokenEvent, state, 3000)

  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].inputUncached, 5_000)
  assert.equal(state.turns[0].cacheRead, 45_000)
  assert.equal(state.turns[0].durationMs, 5_000)
  assert.equal(state.lastContextUsed, 50_500)
  assert.equal(state.contextWindow, 258_400)
})

test('kimi parser handles real wire.jsonl time, usageScope, and skips session records', () => {
  const state = createKimiState()
  ingestKimiLine(
    JSON.stringify({
      type: 'llm.request',
      time: 1_793_085_360_000,
      model: 'k3.1-pro'
    }),
    state,
    1_793_085_360_000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'usage.record',
      time: 1_793_085_364_000,
      model: 'k3.1-pro',
      usageScope: 'turn',
      usage: {
        inputOther: 2_000,
        output: 400,
        inputCacheRead: 18_000,
        inputCacheCreation: 1_000
      }
    }),
    state,
    1_793_085_364_000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'usage.record',
      time: 1_793_085_364_000,
      usageScope: 'session',
      usage: { inputOther: 99_999, output: 99_999 }
    }),
    state,
    1_793_085_364_000
  )

  assert.equal(state.turns.length, 1)
  assert.equal(state.model, 'k3.1-pro')
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

test('adapters locate Native Chat logs via cwd, index, history, and prompt hints when UUIDs differ', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-native-chat-'))
  try {
    // 1. Codex rollout matched via `session_meta.payload.cwd` + `prompt`
    const codexDir = path.join(homeDir, '.codex', 'sessions', '2026', '11', '25')
    await fs.mkdir(codexDir, { recursive: true })
    const codexFile = path.join(codexDir, 'rollout-2026-11-25T14-17-00-01a21159.jsonl')
    await fs.writeFile(
      codexFile,
      [
        JSON.stringify({
          timestamp: '2026-11-25T06:17:00Z',
          type: 'session_meta',
          payload: { id: '01a21159', cwd: '/home/dora/lyfLearn/3dGS/compareExp', model: 'gpt-5-codex' }
        }),
        JSON.stringify({
          timestamp: '2026-11-25T06:17:03Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'hello codex native' }
        }),
        JSON.stringify({
          timestamp: '2026-11-25T06:17:05Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 12_000,
                cached_input_tokens: 8_000,
                output_tokens: 200,
                reasoning_output_tokens: 20,
                total_tokens: 12_200
              },
              last_token_usage: {
                input_tokens: 12_000,
                cached_input_tokens: 8_000,
                output_tokens: 200,
                reasoning_output_tokens: 20,
                total_tokens: 12_200
              },
              model_context_window: 258_400
            }
          }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    const codexRes = await new CodexAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'codex-native',
        agent: 'codex',
        sessionId: 'd01d6030-orca-chat-id',
        prompt: 'hello codex native'
      })
    )
    assert.ok(codexRes)
    assert.equal(codexRes.contextUsed, 12_200)
    assert.equal(codexRes.model, 'gpt-5-codex')

    // 2. Kimi matched via `state.json` (`cwd`, `lastPrompt`, `updatedAt`) inside `wd_compareexp_*`
    const kimiRoot = path.join(homeDir, '.kimi-code')
    const kimiSessionDir = path.join(kimiRoot, 'sessions', 'wd_compareexp_83d83afaf2cf', 'session_999')
    await fs.mkdir(path.join(kimiSessionDir, 'agents', 'main'), { recursive: true })
    await fs.writeFile(
      path.join(kimiSessionDir, 'state.json'),
      JSON.stringify({
        id: 'session_999',
        cwd: '/home/dora/lyfLearn/3dGS/compareExp',
        title: '改进方向',
        lastPrompt: '写到文档中',
        updatedAt: 1_795_587_425_000
      }),
      'utf8'
    )
    await fs.writeFile(
      path.join(kimiSessionDir, 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'llm.request', time: 1_795_587_420_000, model: 'k3.1-pro' }),
        JSON.stringify({
          type: 'usage.record',
          time: 1_795_587_422_000,
          model: 'k3.1-pro',
          usageScope: 'turn',
          usage: { inputOther: 500, output: 100, inputCacheRead: 1500, inputCacheCreation: 0 }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    const kimiRes = await new KimiAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'kimi-native',
        agent: 'kimi',
        sessionId: 'f9581d68-orca-chat-id',
        prompt: '写到文档中'
      })
    )
    assert.ok(kimiRes)
    assert.equal(kimiRes.contextUsed, 2100)
    assert.equal(kimiRes.model, 'k3.1-pro')

    // 3. AGY matched via `~/.gemini/antigravity-cli/history.jsonl` -> `brain/<conversationId>`
    const agyBase = path.join(homeDir, '.gemini', 'antigravity-cli')
    const agyLogDir = path.join(agyBase, 'brain', 'conv-agy-777', '.system_generated', 'logs')
    await fs.mkdir(agyLogDir, { recursive: true })
    await fs.writeFile(
      path.join(agyLogDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T06:12:00Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 9_000,
        cache_read_tokens: 4_000,
        output_tokens: 250
      }) + '\n',
      'utf8'
    )
    await fs.writeFile(
      path.join(agyBase, 'history.jsonl'),
      JSON.stringify({
        display: '现在，你先好好调研一下',
        timestamp: 1_795_587_425_000,
        workspace: '/home/dora/lyfLearn/3dGS/compareExp',
        conversationId: 'conv-agy-777'
      }) + '\n',
      'utf8'
    )
    const agyRes = await new AgyAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'agy-native',
        agent: 'antigravity',
        sessionId: '1d305492-orca-chat-id',
        prompt: '现在，你先好好调研一下'
      })
    )
    assert.ok(agyRes)
    assert.equal(agyRes.contextUsed, 9_250)

    // 4. Cursor matched via case-preserving WSL slug + prompt hint
    const cursorTxDir = path.join(
      homeDir,
      '.cursor',
      'projects',
      'home-dora-lyfLearn-3dGS-compareExp',
      'agent-transcripts',
      'cursor-real-uuid'
    )
    await fs.mkdir(cursorTxDir, { recursive: true })
    await fs.writeFile(
      path.join(cursorTxDir, 'cursor-real-uuid.jsonl'),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>梳理项目交接文档</user_query>' }] }
      }) + '\n',
      'utf8'
    )
    const cursorRes = await new CursorAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'cursor-native',
        agent: 'cursor',
        sessionId: '310f3347-orca-chat-id',
        prompt: '梳理项目交接文档'
      })
    )
    assert.ok(cursorRes.result)
    assert.equal(cursorRes.result.source, 'cursor-transcript')
    assert.ok((cursorRes.result.contextUsed ?? 0) > 0)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('TelemetryLogger deduplicates repeated keys, keeps ring buffer, and writes log file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-logger-'))
  const logFile = path.join(dir, 'plugin.log')
  try {
    const forwarded: string[] = []
    const logger = new TelemetryLogger({
      sink: (m) => forwarded.push(m),
      logFilePath: logFile
    })
    logger.logOnce('k1', 'INFO', 'test', 'same message')
    logger.logOnce('k1', 'INFO', 'test', 'same message')
    logger.warn('git', 'warning line')
    await logger.flush()

    assert.equal(forwarded.length, 2)
    assert.equal(logger.getRecent(10).length, 2)
    const disk = await fs.readFile(logFile, 'utf8')
    assert.ok(disk.includes('[INFO] [test] same message'))
    assert.ok(disk.includes('[WARN] [git] warning line'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
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
