import type { GitFileChange, GitSnapshot, WorkspaceEnv } from '../protocol'
import type { WslEnvironmentResolver } from './wsl-env'

/** Parse `git status --porcelain=v2 --branch`, `git diff --numstat`, and `git log -1` output. */
export function parseGitOutputs(input: {
  porcelainV2: string
  unstagedNumstat: string
  stagedNumstat: string
  lastCommitLine: string
  source: GitSnapshot['source']
  fallbackBranch: string | null
}): GitSnapshot {
  let branch = input.fallbackBranch
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let modified = 0
  let added = 0
  let deleted = 0
  let untracked = 0

  const fileStatusMap = new Map<string, string>()

  for (const rawLine of input.porcelainV2.split(/\r?\n/)) {
    if (!rawLine) continue
    if (rawLine.startsWith('# branch.head ')) {
      const val = rawLine.slice('# branch.head '.length).trim()
      branch = val === '(detached)' ? 'HEAD (detached)' : val
    } else if (rawLine.startsWith('# branch.upstream ')) {
      upstream = rawLine.slice('# branch.upstream '.length).trim() || null
    } else if (rawLine.startsWith('# branch.ab ')) {
      const abMatch = /\+(\d+)\s+-(\d+)/.exec(rawLine)
      if (abMatch) {
        ahead = Number(abMatch[1])
        behind = Number(abMatch[2])
      }
    } else if (rawLine.startsWith('? ')) {
      untracked += 1
      const filePath = rawLine.slice(2).trim()
      if (filePath) fileStatusMap.set(filePath, '?')
    } else if (rawLine.startsWith('1 ') || rawLine.startsWith('2 ')) {
      const parts = rawLine.split(' ')
      const xy = parts[1] ?? '..'
      // Porcelain v2 `2` lines append `\torigPath` at the end; strip tab part first.
      const tabParts = rawLine.split('\t')
      const pathToken = tabParts[0].split(' ').slice(rawLine.startsWith('2 ') ? 9 : 8).join(' ')
      const filePath = pathToken.trim()

      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      if (x === 'A' || y === 'A') added += 1
      else if (x === 'D' || y === 'D') deleted += 1
      else modified += 1

      const badge = x !== '.' && y !== '.' ? `${x}${y}` : x !== '.' ? x : y
      if (filePath) fileStatusMap.set(filePath, badge)
    } else if (rawLine.startsWith('u ')) {
      modified += 1
      const filePath = rawLine.split(' ').slice(10).join(' ').trim()
      if (filePath) fileStatusMap.set(filePath, 'U')
    }
  }

  const lineStats = new Map<string, { added: number; deleted: number }>()
  const ingestNumstat = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const addNum = parts[0] === '-' ? 0 : Number(parts[0])
      const delNum = parts[1] === '-' ? 0 : Number(parts[1])
      const filePath = parts.slice(2).join('\t').trim()
      if (!filePath || Number.isNaN(addNum) || Number.isNaN(delNum)) continue
      const prev = lineStats.get(filePath) ?? { added: 0, deleted: 0 }
      lineStats.set(filePath, {
        added: prev.added + addNum,
        deleted: prev.deleted + delNum
      })
    }
  }
  ingestNumstat(input.unstagedNumstat)
  ingestNumstat(input.stagedNumstat)

  let linesAdded = 0
  let linesDeleted = 0
  for (const stat of lineStats.values()) {
    linesAdded += stat.added
    linesDeleted += stat.deleted
  }

  const files: GitFileChange[] = []
  for (const [filePath, status] of fileStatusMap.entries()) {
    const stat = lineStats.get(filePath)
    files.push({
      status,
      path: filePath,
      added: stat ? stat.added : null,
      deleted: stat ? stat.deleted : null
    })
  }
  for (const [filePath, stat] of lineStats.entries()) {
    if (!fileStatusMap.has(filePath)) {
      files.push({ status: 'M', path: filePath, added: stat.added, deleted: stat.deleted })
    }
  }

  let lastCommit: GitSnapshot['lastCommit'] = null
  const commitParts = input.lastCommitLine.trim().split('\x1f')
  if (commitParts.length >= 2 && commitParts[0]) {
    const epochSec = Number(commitParts[2])
    lastCommit = {
      hash: commitParts[0],
      subject: commitParts[1],
      authoredAtMs: Number.isFinite(epochSec) && epochSec > 0 ? epochSec * 1000 : null
    }
  }

  return {
    available: true,
    source: input.source,
    branch,
    upstream,
    ahead,
    behind,
    modified,
    added,
    deleted,
    untracked,
    linesAdded,
    linesDeleted,
    lastCommit,
    files: files.slice(0, 60)
  }
}

export class GitCollector {
  private cache: { key: string; at: number; snapshot: GitSnapshot } | null = null

  async collect(
    workspace: WorkspaceEnv,
    fallbackBranch: string | null,
    wslEnv: WslEnvironmentResolver,
    force = false
  ): Promise<GitSnapshot> {
    const cacheKey = `${workspace.hostKind}:${workspace.wslDistro ?? ''}:${workspace.linuxPath ?? workspace.windowsPath ?? ''}:${fallbackBranch ?? ''}`
    const now = Date.now()
    if (!force && this.cache && this.cache.key === cacheKey && now - this.cache.at < 3500) {
      return this.cache.snapshot
    }

    const snapshot = await this.collectUncached(workspace, fallbackBranch, wslEnv)
    this.cache = { key: cacheKey, at: now, snapshot }
    return snapshot
  }

  private async collectUncached(
    workspace: WorkspaceEnv,
    fallbackBranch: string | null,
    wslEnv: WslEnvironmentResolver
  ): Promise<GitSnapshot> {
    const runGit = async (gitArgs: readonly string[]) => {
      if (workspace.hostKind === 'wsl' && workspace.wslDistro && workspace.linuxPath) {
        return wslEnv.execInWsl(workspace.wslDistro, ['git', '-C', workspace.linuxPath, ...gitArgs])
      }
      if (workspace.hostKind === 'local' && workspace.windowsPath) {
        return wslEnv.execLocal('git', ['-C', workspace.windowsPath, ...gitArgs])
      }
      return null
    }

    const source: GitSnapshot['source'] =
      workspace.hostKind === 'wsl' && workspace.wslDistro && workspace.linuxPath
        ? 'wsl-git'
        : workspace.hostKind === 'local' && workspace.windowsPath
          ? 'local-git'
          : fallbackBranch
            ? 'orca-branch'
            : 'unavailable'

    if (source === 'orca-branch' || source === 'unavailable') {
      return emptyGitSnapshot(source, fallbackBranch)
    }

    const statusRes = await runGit(['status', '--porcelain=v2', '--branch'])
    if (!statusRes || statusRes.exitCode !== 0) {
      return emptyGitSnapshot(
        fallbackBranch ? 'orca-branch' : 'unavailable',
        fallbackBranch,
        statusRes?.stderr?.trim() || undefined
      )
    }

    const [unstagedRes, stagedRes, logRes] = await Promise.all([
      runGit(['diff', '--numstat']),
      runGit(['diff', '--cached', '--numstat']),
      runGit(['log', '-1', '--format=%h%x1f%s%x1f%ct'])
    ])

    return parseGitOutputs({
      porcelainV2: statusRes.stdout,
      unstagedNumstat: unstagedRes?.exitCode === 0 ? unstagedRes.stdout : '',
      stagedNumstat: stagedRes?.exitCode === 0 ? stagedRes.stdout : '',
      lastCommitLine: logRes?.exitCode === 0 ? logRes.stdout : '',
      source,
      fallbackBranch
    })
  }
}

function emptyGitSnapshot(
  source: GitSnapshot['source'],
  branch: string | null,
  error?: string
): GitSnapshot {
  return {
    available: branch !== null,
    source,
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    linesAdded: 0,
    linesDeleted: 0,
    lastCommit: null,
    files: [],
    ...(error ? { error } : {})
  }
}
