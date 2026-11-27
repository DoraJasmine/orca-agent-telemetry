import * as fs from 'node:fs/promises'

type FileEntry<S> = {
  offset: number
  mtimeMs: number
  size: number
  state: S
}

const MAX_READ_BYTES_PER_PASS = 8 * 1024 * 1024

/**
 * Byte-offset incremental JSONL tailer.
 * Uses `stat + open/read` polling instead of `fs.watch` so `\\wsl.localhost` 9P paths work reliably.
 */
export class JsonlTailer<S> {
  private readonly entries = new Map<string, FileEntry<S>>()

  /** Read newly appended complete newline-terminated lines and update per-file state. */
  async readIncremental(
    filePath: string,
    createInitialState: () => S,
    onLine: (
      line: string,
      state: S,
      observedAtMs: number,
      meta?: { isInitialRead: boolean }
    ) => void
  ): Promise<{ state: S; updated: boolean; exists: boolean }> {
    let statResult: { size: number; mtimeMs: number }
    try {
      statResult = await fs.stat(filePath)
    } catch {
      this.entries.delete(filePath)
      return { state: createInitialState(), updated: false, exists: false }
    }

    let entry = this.entries.get(filePath)
    if (!entry || statResult.size < entry.offset) {
      entry = {
        offset: 0,
        mtimeMs: 0,
        size: 0,
        state: createInitialState()
      }
      this.entries.set(filePath, entry)
    }

    if (statResult.size === entry.offset && statResult.mtimeMs === entry.mtimeMs) {
      return { state: entry.state, updated: false, exists: true }
    }

    if (statResult.size <= entry.offset) {
      entry.mtimeMs = statResult.mtimeMs
      entry.size = statResult.size
      return { state: entry.state, updated: false, exists: true }
    }

    const isInitialRead = entry.offset === 0
    const bytesAvailable = statResult.size - entry.offset
    const toRead = Math.min(bytesAvailable, MAX_READ_BYTES_PER_PASS)
    const buffer = Buffer.alloc(toRead)

    let bytesRead = 0
    const handle = await fs.open(filePath, 'r')
    try {
      const readRes = await handle.read(buffer, 0, toRead, entry.offset)
      bytesRead = readRes.bytesRead
    } finally {
      await handle.close()
    }

    if (bytesRead <= 0) {
      entry.mtimeMs = statResult.mtimeMs
      entry.size = statResult.size
      return { state: entry.state, updated: false, exists: true }
    }

    const slice = buffer.subarray(0, bytesRead)
    const lastNewline = lastIndexOfByte(slice, 0x0a)
    const observedAtMs = Date.now()
    let consumedBytes = 0

    if (lastNewline >= 0) {
      consumedBytes = lastNewline + 1
      const chunkText = slice.subarray(0, consumedBytes).toString('utf8')
      for (const rawLine of chunkText.split(/\r?\n/)) {
        const trimmed = rawLine.trim()
        if (trimmed) onLine(trimmed, entry.state, observedAtMs, { isInitialRead })
      }
    } else if (entry.offset + bytesRead === statResult.size) {
      // Handle a single complete JSON line written without a trailing newline.
      const candidate = slice.toString('utf8').trim()
      if (candidate.startsWith('{') && candidate.endsWith('}')) {
        try {
          JSON.parse(candidate)
          onLine(candidate, entry.state, observedAtMs, { isInitialRead })
          consumedBytes = bytesRead
        } catch {
          // Wait until the full line finishes flushing.
        }
      }
    }

    entry.offset += consumedBytes
    entry.mtimeMs = statResult.mtimeMs
    entry.size = statResult.size
    return { state: entry.state, updated: consumedBytes > 0, exists: true }
  }

  clear(filePath?: string): void {
    if (filePath) {
      this.entries.delete(filePath)
    } else {
      this.entries.clear()
    }
  }
}

function lastIndexOfByte(buf: Uint8Array, byte: number): number {
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    if (buf[i] === byte) return i
  }
  return -1
}

export function safeJsonParse<T = Record<string, unknown>>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}

export function parseIsoTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
