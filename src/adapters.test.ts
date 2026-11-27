import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import { AgyAdapter, createAgyState, ingestAgyLine } from './adapters/agy'
import { ClaudeAdapter, createClaudeState, ingestClaudeLine } from './adapters/claude'
import { CodexAdapter, createCodexState, ingestCodexLine } from './adapters/codex'
import {
  createCursorHookState,
  createCursorTranscriptState,
  CursorAdapter,
  ingestCursorHookLine,
  ingestCursorTranscriptLine
} from './adapters/cursor'
import { createKimiState, ingestKimiLine, KimiAdapter, parseKimiConfigToml } from './adapters/kimi'
import { resolveContextWindow } from './adapters/model-windows'
import { JsonlTailer } from './adapters/tailer'
import type { AdapterContext } from './adapters/types'
import { parseGitOutputs } from './collectors/git'
import {
  buildCleanChildEnv,
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
  const cleanEnv = buildCleanChildEnv({
    ELECTRON_RUN_AS_NODE: '1',
    ORCA_CLI_COMMAND: 'environment',
    ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1'
  })
  assert.equal('ELECTRON_RUN_AS_NODE' in cleanEnv, false)
  assert.equal('ORCA_CLI_COMMAND' in cleanEnv, false)
  assert.equal('ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER' in cleanEnv, false)
  assert.equal(cleanEnv.WSL_UTF8, '1')

  const restoredWinEnv = buildCleanChildEnv(undefined, {
    baseEnv: { SYSTEMROOT: 'C:\\Windows' },
    homeDir: 'C:\\Users\\alice',
    platform: 'win32'
  })
  assert.equal(restoredWinEnv.USERPROFILE, 'C:\\Users\\alice')
  assert.equal(restoredWinEnv.HOME, 'C:\\Users\\alice')
  assert.equal(restoredWinEnv.APPDATA, 'C:\\Users\\alice\\AppData\\Roaming')
  assert.equal(restoredWinEnv.LOCALAPPDATA, 'C:\\Users\\alice\\AppData\\Local')

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

test('resolves Orca CLI executable from execPath or homedir even when LOCALAPPDATA is unset', async () => {
  if (process.platform !== 'win32') return

  const siblingBin = 'C:\\Custom\\Orca\\resources\\bin\\orca.exe'
  const byExecPath = new WslEnvironmentResolver({
    execPath: 'C:\\Custom\\Orca\\Orca.exe',
    localAppData: null,
    homeDir: 'C:\\Users\\alice',
    pathExists: async (p) => path.normalize(p) === path.normalize(siblingBin)
  })
  assert.equal(await byExecPath.resolveOrcaExecutable(), path.normalize(siblingBin))

  const homeBin = 'C:\\Users\\alice\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'
  const byHomeDir = new WslEnvironmentResolver({
    execPath: 'C:\\Windows\\node.exe',
    localAppData: null,
    homeDir: 'C:\\Users\\alice',
    pathExists: async (p) => path.normalize(p) === path.normalize(homeBin)
  })
  assert.equal(await byHomeDir.resolveOrcaExecutable(), path.normalize(homeBin))
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

  const metrics = computeMetrics({
    adapter: {
      source: 'codex-jsonl',
      sourceLabel: 'Codex JSONL',
      logPath: 'rollout.jsonl',
      model: 'gpt-5-codex',
      contextUsed: state.lastContextUsed,
      contextLimit: state.contextWindow,
      contextIsEstimated: false,
      compactedDetected: false,
      reasoningIncludedInOutput: state.reasoningIncludedInOutput,
      turns: state.turns,
      recentTools: []
    },
    showEstimatedCost: true
  })
  // Reasoning (50) is already included inside `output_tokens` (500); must not be double-counted.
  assert.equal(metrics.tokens.total, 50_500)
  assert.equal(metrics.speed.turnTokPerSec, 100)
})

test('claude parser deduplicates streaming message fragments and respects 1M settings window', async () => {
  const cState = createClaudeState()
  ingestClaudeLine(
    JSON.stringify({
      type: 'user',
      timestamp: '2026-11-25T07:54:00Z',
      cwd: '/home/dora/lyfLearn/3dGS/compareExp'
    }),
    cState,
    Date.parse('2026-11-25T07:54:00Z')
  )
  const makeChunk = (blockType: string, outTokens: number, ts: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      cwd: '/home/dora/lyfLearn/3dGS/compareExp/scripts',
      message: {
        id: 'msg_01ABC',
        model: 'claude-fable-5-2',
        content: blockType === 'tool_use' ? [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] : [{ type: blockType }],
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 9_800,
          cache_read_input_tokens: 570_000,
          output_tokens: outTokens,
          output_tokens_details: { thinking_tokens: 95 }
        }
      }
    })

  ingestClaudeLine(makeChunk('thinking', 150, '2026-11-25T07:54:04Z'), cState, 1000)
  ingestClaudeLine(makeChunk('tool_use', 3_000, '2026-11-25T07:54:10Z'), cState, 2000)
  ingestClaudeLine(makeChunk('tool_use', 3_000, '2026-11-25T07:54:11Z'), cState, 3000)

  assert.equal(cState.turns.length, 1)
  assert.equal(cState.turns[0].output, 3_000)
  assert.equal(cState.turns[0].reasoningIncludedInOutput, true)
  assert.equal(cState.lastContextUsed, 583_000)
  assert.equal(cState.tools.get('Bash')?.count, 1)

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-claude-test-'))
  try {
    const claudeDir = path.join(homeDir, '.claude')
    const projDir = path.join(claudeDir, 'projects', '-home-dora-lyfLearn-3dGS-compareExp')
    await fs.mkdir(projDir, { recursive: true })
    await fs.writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } }),
      'utf8'
    )
    await fs.writeFile(
      path.join(projDir, 'claude-real-uuid.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-25T07:54:00Z',
          cwd: '/home/dora/lyfLearn/3dGS/compareExp/scripts'
        }),
        makeChunk('tool_use', 3_000, '2026-11-25T07:54:10Z')
      ].join('\n') + '\n',
      'utf8'
    )
    await fs.writeFile(
      path.join(claudeDir, 'history.jsonl'),
      JSON.stringify({
        display: '继续',
        timestamp: 1_795_592_962_368,
        project: '/home/dora/lyfLearn/3dGS/compareExp',
        sessionId: 'claude-real-uuid'
      }) + '\n',
      'utf8'
    )

    const res = await new ClaudeAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'claude-native',
        agent: 'claude',
        sessionId: 'orca-claude-sess',
        prompt: '继续'
      })
    )
    assert.ok(res)
    assert.equal(res.source, 'claude-jsonl')
    assert.equal(res.contextUsed, 583_000)
    assert.equal(res.contextLimit, 1_000_000)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('kimi parser handles real wire.jsonl time, profile.bind modelAlias, usageScope, and config.toml windows', () => {
  const state = createKimiState()
  ingestKimiLine(
    JSON.stringify({
      type: 'profile.bind',
      agentId: 'main',
      modelAlias: 'kimi-code/k3.1-pro',
      systemPrompt: 'You are Kimi Code CLI'
    }),
    state,
    1_793_085_359_000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'llm.request',
      time: 1_793_085_360_000,
      maxTokens: 1_048_576
    }),
    state,
    1_793_085_360_000
  )
  ingestKimiLine(
    JSON.stringify({
      type: 'usage.record',
      time: 1_793_085_364_000,
      model: 'kimi-code/k3.1-pro',
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
      type: 'token_counting.measured',
      agentId: 'main',
      tokens: 21_400,
      time: 1_793_085_364_005
    }),
    state,
    1_793_085_364_005
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
  assert.equal(state.model, 'kimi-code/k3.1-pro')
  assert.equal(state.contextWindow, 1_048_576)
  assert.equal(state.lastContextUsed, 21_400)
  assert.equal(state.turns[0].durationMs, 4_000)

  assert.equal(resolveContextWindow('kimi-code/k3.1-pro', 'kimi', {}), 1_048_576)
  assert.equal(resolveContextWindow('kimi-code/kimi-for-coding', 'kimi', {}), 1_048_576)
  assert.equal(resolveContextWindow('kimi-code/kimi-for-coding-highspeed', 'kimi', {}), 262_144)
  assert.equal(resolveContextWindow('kimi-code/k3-256k', 'kimi', {}), 262_144)

  const parsedToml = parseKimiConfigToml(`
default_model = "kimi-code/k3.1-pro"
[models."kimi-code/k3.1-pro"]
max_context_size = 1048576
[models."kimi-code/k3-256k"]
max_context_size = 262144
`)
  assert.equal(parsedToml.defaultModel, 'kimi-code/k3.1-pro')
  assert.equal(parsedToml.contextByModel.get('kimi-code/k3.1-pro'), 1_048_576)
  assert.equal(parsedToml.contextByModel.get('kimi-code/k3-256k'), 262_144)
})

test('kimi adapter prefers recent session_1* over older session_9* in session_index and large wd dirs', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-kimi-match-'))
  try {
    const kimiRoot = path.join(homeDir, '.kimi-code')
    const wdDir = path.join(kimiRoot, 'sessions', 'wd_compareexp_83d83afaf2cf')
    const oldDir = path.join(wdDir, 'session_9749b3e9-old')
    const newDir = path.join(wdDir, 'session_1bf33985-new')
    const delDir = path.join(wdDir, 'session_f9999999-del')
    for (const d of [oldDir, newDir, delDir]) {
      await fs.mkdir(path.join(d, 'agents', 'main'), { recursive: true })
    }
    await fs.writeFile(
      path.join(kimiRoot, 'config.toml'),
      'default_model = "kimi-code/k3.1-pro"\n[models."kimi-code/k3.1-pro"]\nmax_context_size = 1048576\n',
      'utf8'
    )

    const oldMs = 1_789_372_774_600
    const newMs = 1_795_602_233_858

    await fs.writeFile(
      path.join(oldDir, 'state.json'),
      JSON.stringify({
        id: 'session_9749b3e9-old',
        cwd: '/home/dora/lyfLearn/3dGS/compareExp',
        title: 'old question',
        updatedAt: oldMs
      }),
      'utf8'
    )
    const oldWire = path.join(oldDir, 'agents', 'main', 'wire.jsonl')
    await fs.writeFile(
      oldWire,
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/kimi-for-coding',
        usageScope: 'turn',
        usage: { inputOther: 25_000, output: 369, inputCacheRead: 0, inputCacheCreation: 0 },
        time: oldMs
      }) + '\n',
      'utf8'
    )
    await fs.utimes(oldWire, new Date(oldMs), new Date(oldMs))

    // Deliberately omit `updatedAt` in newDir state.json & bury user prompt past 4 KB.
    await fs.writeFile(
      path.join(newDir, 'state.json'),
      JSON.stringify({
        id: 'session_1bf33985-new',
        cwd: '/home/dora/lyfLearn/3dGS/compareExp',
        title: 'Continue work from the prior Orca session'
      }),
      'utf8'
    )
    const newWire = path.join(newDir, 'agents', 'main', 'wire.jsonl')
    await fs.writeFile(
      newWire,
      [
        JSON.stringify({
          type: 'profile.bind',
          agentId: 'main',
          modelAlias: 'kimi-code/k3.1-pro',
          systemPrompt: 's'.repeat(6_000)
        }),
        JSON.stringify({
          type: 'usage.record',
          model: 'kimi-code/k3.1-pro',
          usageScope: 'turn',
          usage: { inputOther: 13_383, output: 543, inputCacheRead: 58_368, inputCacheCreation: 0 },
          time: newMs
        }),
        JSON.stringify({
          type: 'token_counting.measured',
          tokens: 72_294,
          time: newMs
        })
      ].join('\n') + '\n',
      'utf8'
    )
    await fs.utimes(newWire, new Date(newMs), new Date(newMs))

    // session_index rows in production omit `updatedAt` & `title`, and deleted rows are tombstoned.
    const indexPath = path.join(kimiRoot, 'session_index.jsonl')
    await fs.writeFile(
      indexPath,
      [
        JSON.stringify({ sessionId: 'session_9749b3e9-old', sessionDir: oldDir, workDir: '/home/dora/lyfLearn/3dGS/compareExp' }),
        JSON.stringify({ sessionId: 'session_f9999999-del', sessionDir: delDir, workDir: '/home/dora/lyfLearn/3dGS/compareExp' }),
        JSON.stringify({ sessionId: 'session_f9999999-del', deleted: true }),
        JSON.stringify({ sessionId: 'session_1bf33985-new', sessionDir: newDir, workDir: '/home/dora/lyfLearn/3dGS/compareExp' })
      ].join('\n') + '\n',
      'utf8'
    )

    const ctx = makeAdapterCtx(homeDir, {
      key: 'kimi-active',
      agent: 'kimi',
      sessionId: 'orca-pane-uuid',
      stateStartedAt: newMs - 4_000,
      updatedAt: newMs,
      prompt: '当前已经做完了实验，你先等等'
    })
    const res1 = await new KimiAdapter().collect(ctx)
    assert.ok(res1)
    assert.equal(res1.model, 'kimi-code/k3.1-pro')
    assert.equal(res1.contextUsed, 72_294)
    assert.equal(res1.contextLimit, 1_048_576)

    // Also verify Tier-2/3 mtime scan without session_index.jsonl across >35 alphabetical dummy dirs.
    await fs.unlink(indexPath)
    for (let i = 0; i < 35; i++) {
      const dummyDir = path.join(wdDir, `session_z${String(i).padStart(2, '0')}`)
      await fs.mkdir(path.join(dummyDir, 'agents', 'main'), { recursive: true })
      const dw = path.join(dummyDir, 'agents', 'main', 'wire.jsonl')
      await fs.writeFile(dw, '{"type":"usage.record","usageScope":"turn","usage":{"inputOther":1}}\n', 'utf8')
      await fs.utimes(dw, new Date(oldMs - i * 1000), new Date(oldMs - i * 1000))
    }
    const res2 = await new KimiAdapter().collect(ctx)
    assert.ok(res2)
    assert.equal(res2.model, 'kimi-code/k3.1-pro')
    assert.equal(res2.contextUsed, 72_294)
    assert.equal(res2.contextLimit, 1_048_576)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('agy parser handles PLANNER_RESPONSE tokens, uncached inputs, compaction, and step completion timing', () => {
  const state = createAgyState()
  ingestAgyLine(
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-27T01:24:06Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 162_390,
      cache_read_tokens: 0,
      output_tokens: 611,
      tool_calls: [{ name: 'run_command', args: {} }]
    }),
    state,
    Date.parse('2026-11-27T01:24:20Z'),
    { isInitialRead: true }
  )
  ingestAgyLine(
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-27T01:24:14Z'
    }),
    state,
    Date.parse('2026-11-27T01:24:20Z'),
    { isInitialRead: true }
  )
  // Cached turn where `input_tokens` < `cache_read_tokens` must NOT zero out `inputUncached` or trigger `compactedDetected`.
  ingestAgyLine(
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-27T01:24:17Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 2_881,
      cache_read_tokens: 162_391,
      output_tokens: 49
    }),
    state,
    Date.parse('2026-11-27T01:24:20Z'),
    { isInitialRead: true }
  )
  // Subsequent user input later on must not attribute user idle time as generation duration.
  ingestAgyLine(
    JSON.stringify({
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-27T01:26:17Z'
    }),
    state,
    Date.parse('2026-11-27T01:26:20Z'),
    { isInitialRead: true }
  )
  // Real compaction: total context drops from 165,321 to 29,189 (< 60%).
  ingestAgyLine(
    JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-27T01:26:18Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 28_721,
      cache_read_tokens: 0,
      output_tokens: 468
    }),
    state,
    Date.parse('2026-11-27T01:26:23Z'),
    { isInitialRead: false }
  )

  assert.equal(state.turns.length, 3)
  assert.equal(state.turns[0].inputUncached, 162_390)
  assert.equal(state.turns[0].cacheRead, 0)
  assert.equal(state.turns[0].contextUsed, 163_001)
  assert.equal(state.turns[0].durationMs, 8_000)
  assert.equal(state.turns[1].inputUncached, 2_881)
  assert.equal(state.turns[1].cacheRead, 162_391)
  assert.equal(state.turns[1].contextUsed, 165_321)
  assert.equal(state.turns[1].durationMs, null)
  assert.equal(state.turns[2].contextUsed, 29_189)
  assert.equal(state.turns[2].durationMs, 5_000)
  assert.equal(state.compactedDetected, true)
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
  assert.ok(installed.includes('--event beforeSubmitPrompt'))
  assert.ok(installed.includes('--event stop'))

  const uninstalled = mergeCursorHooksJson(installed, null)
  assert.equal(hasTelemetryHookInstalled(uninstalled), false)
  assert.ok(uninstalled.includes('echo user-hook'))
  assert.equal(uninstalled.includes('--event beforeSubmitPrompt'), false)
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
          payload: {
            id: '01a21159',
            cwd: '/home/dora/lyfLearn/3dGS/compareExp',
            model: 'gpt-5-codex',
            // Large base_instructions (> 64 KB) ensures line-0 truncation still extracts `cwd`.
            base_instructions: { text: 'x'.repeat(70_000) }
          }
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
    assert.equal(agyRes.contextUsed, 13_250)

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

test('agy adapter ignores stale workspace history rows and matches Native Chat via title/prompt head+tail', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-agy-native-'))
  try {
    const agyBase = path.join(homeDir, '.gemini', 'antigravity-cli')
    const oldLogDir = path.join(agyBase, 'brain', '071667da-stale', '.system_generated', 'logs')
    const newLogDir = path.join(agyBase, 'brain', 'bb992ce8-active', '.system_generated', 'logs')
    await fs.mkdir(oldLogDir, { recursive: true })
    await fs.mkdir(newLogDir, { recursive: true })

    const nowMs = Date.now()
    const staleMs = nowMs - 3 * 24 * 3_600_000

    // Stale session present in `history.jsonl` for the same workspace.
    const staleTranscript = path.join(oldLogDir, 'transcript.jsonl')
    await fs.writeFile(
      staleTranscript,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: new Date(staleMs).toISOString(),
        model: 'gemini-4-hydrogen-high',
        input_tokens: 2_893,
        cache_read_tokens: 432_002,
        output_tokens: 1_660
      }) + '\n',
      'utf8'
    )
    await fs.utimes(staleTranscript, new Date(staleMs), new Date(staleMs))
    await fs.writeFile(
      path.join(agyBase, 'history.jsonl'),
      JSON.stringify({
        display: '老会话提示词',
        timestamp: staleMs,
        workspace: '/home/dora/lyfLearn/3dGS/compareExp',
        conversationId: '071667da-stale'
      }) + '\n',
      'utf8'
    )

    // Active Native Chat session absent from `history.jsonl`, with initial title in head and latest prompt in tail.
    const activeTranscript = path.join(newLogDir, 'transcript.jsonl')
    await fs.writeFile(
      activeTranscript,
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: new Date(nowMs - 60_000).toISOString(),
          content: '<USER_REQUEST>\n你看看Seq26手部模糊修复文件夹中的内容和最新实验方案与报告，熟悉本项目\n</USER_REQUEST>'
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: new Date(nowMs - 55_000).toISOString(),
          model: 'gemini-4-neon-xhigh',
          input_tokens: 506_939,
          cache_read_tokens: 0,
          output_tokens: 1_762,
          content: 'padding-' + 'x'.repeat(12_000)
        }),
        JSON.stringify({
          step_index: 2,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: new Date(nowMs - 15_000).toISOString(),
          content: '<USER_REQUEST>\n你先将路线A的详细实验方案文档写出来\n</USER_REQUEST>'
        }),
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: new Date(nowMs - 12_000).toISOString(),
          model: 'gemini-4-neon-xhigh',
          input_tokens: 2_181,
          cache_read_tokens: 506_725,
          output_tokens: 438
        })
      ].join('\n') + '\n',
      'utf8'
    )
    await fs.utimes(activeTranscript, new Date(nowMs - 5_000), new Date(nowMs - 5_000))

    const res = await new AgyAdapter().collect(
      makeAdapterCtx(homeDir, {
        key: 'agy-active-native',
        agent: 'antigravity',
        sessionId: '4692c8fe-orca-session',
        title: '你看看Seq26手部模糊修复文件夹中的内容和最新实验方案与报告…',
        prompt: '你先将路线A的详细实验方案文档写出来 [Image #1]',
        state: 'working',
        stateStartedAt: nowMs - 15_000,
        updatedAt: nowMs - 3_000
      })
    )
    assert.ok(res)
    assert.ok(res.logPath?.includes('bb992ce8-active'))
    assert.equal(res.model, 'gemini-4-neon-xhigh')
    assert.equal(res.contextUsed, 509_344)
    assert.equal(res.compactedDetected, false)
    const metrics = computeMetrics({ adapter: res, showEstimatedCost: true })
    assert.equal(metrics.tokens.inputUncached, 509_120)
    assert.equal(metrics.tokens.cacheRead, 506_725)
    assert.equal(metrics.tokens.output, 2_200)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
