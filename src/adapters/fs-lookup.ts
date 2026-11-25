import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentOption, WorkspaceEnv } from '../protocol'

export type FoundFile = {
  path: string
  mtimeMs: number
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

export async function readHeadUtf8(filePath: string, maxBytes = 4096): Promise<string> {
  try {
    const handle = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

export async function readTailUtf8(filePath: string, maxBytes = 128 * 1024): Promise<string> {
  try {
    const st = await fs.stat(filePath)
    if (st.size === 0) return ''
    const start = Math.max(0, st.size - maxBytes)
    const length = st.size - start
    const handle = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, start)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        return firstNewline >= 0 ? text.slice(firstNewline + 1) : text
      }
      return text
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/**
 * Bounded directory walk that optionally traverses subdirectories in descending name order
 * (useful for date-partitioned folders like `~/.codex/sessions/YYYY/MM/DD`).
 */
export async function findMatchingFiles(
  rootDir: string,
  predicate: (fileName: string, fullPath: string) => boolean,
  options?: { maxDepth?: number; maxDirs?: number; descendingDirs?: boolean }
): Promise<FoundFile[]> {
  const maxDepth = options?.maxDepth ?? 4
  const maxDirs = options?.maxDirs ?? 120
  const descending = options?.descendingDirs ?? true

  const results: FoundFile[] = []
  let visitedDirs = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (visitedDirs >= maxDirs || depth > maxDepth) return
    visitedDirs += 1

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    const subdirs: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) subdirs.push(entry.name)
      } else if (entry.isFile() && predicate(entry.name, fullPath)) {
        try {
          const st = await fs.stat(fullPath)
          results.push({ path: fullPath, mtimeMs: st.mtimeMs })
        } catch {
          // Ignore disappeared temp files.
        }
      }
    }

    if (descending) {
      subdirs.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    }
    for (const sub of subdirs) {
      if (visitedDirs >= maxDirs) break
      await walk(path.join(dir, sub), depth + 1)
    }
  }

  await walk(rootDir, 0)
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return results
}

export function normalizePathForCompare(p: string | null | undefined): string {
  if (!p) return ''
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function buildWorkspacePathSet(workspace: WorkspaceEnv): Set<string> {
  return new Set(
    [workspace.linuxPath, workspace.windowsPath, workspace.rawPath]
      .map(normalizePathForCompare)
      .filter(Boolean)
  )
}

export function buildPromptSnippet(prompt: string | null | undefined): string | null {
  if (!prompt) return null
  const firstLine = prompt.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (firstLine.length < 3) return null
  return firstLine.slice(0, 60)
}

export function agentActivityTimestamp(agent: AgentOption): number {
  return Math.max(agent.updatedAt ?? 0, agent.stateStartedAt || 0)
}

export function pickClosestFileByTimestamp(
  files: readonly FoundFile[],
  targetMs: number,
  maxDeltaMs = 24 * 60 * 60_000
): FoundFile | null {
  if (files.length === 0) return null
  if (targetMs <= 0) return files[0]

  let best: FoundFile | null = null
  let bestDelta = Infinity
  for (const f of files) {
    const delta = Math.abs(f.mtimeMs - targetMs)
    if (delta <= maxDeltaMs && delta < bestDelta) {
      bestDelta = delta
      best = f
    }
  }
  return best ?? files[0]
}
