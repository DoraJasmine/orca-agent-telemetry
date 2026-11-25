import * as fs from 'node:fs/promises'
import * as path from 'node:path'

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
