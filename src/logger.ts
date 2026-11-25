import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const MAX_LOG_FILE_BYTES = 512 * 1024
const MAX_RING_ENTRIES = 30
const DEDUP_WINDOW_MS = 60_000

/**
 * Dual-sink structured logger:
 * 1) Forwards concise INFO/WARN/ERROR lines to `orca.log(...)` (with dedup to avoid log spam)
 * 2) Persists rotating file logs at `~/.orca-telemetry/plugin.log` and keeps a recent ring buffer for UI diagnostics.
 */
export class TelemetryLogger {
  private readonly sink: (msg: string) => void
  private readonly logFilePath: string | null
  private readonly ring: string[] = []
  private readonly dedupMap = new Map<string, number>()
  private readonly infoByKey = new Map<string, string>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options?: { sink?: (msg: string) => void; logFilePath?: string | null }) {
    this.sink = options?.sink ?? (() => {})
    this.logFilePath =
      options?.logFilePath === undefined
        ? path.join(os.homedir(), '.orca-telemetry', 'plugin.log')
        : options.logFilePath
  }

  info(scope: string, message: string): void {
    this.log('INFO', scope, message)
  }

  warn(scope: string, message: string): void {
    this.log('WARN', scope, message)
  }

  error(scope: string, message: string): void {
    this.log('ERROR', scope, message)
  }

  debug(scope: string, message: string): void {
    this.log('DEBUG', scope, message)
  }

  /**
   * Log a message once per key/content:
   * - `INFO`/`DEBUG`: logged once until the message for `key` changes (prevents 60s poll spam).
   * - `WARN`/`ERROR`: re-logged at most once per 60s if unchanged.
   */
  logOnce(key: string, level: LogLevel, scope: string, message: string): void {
    const now = Date.now()
    if (level === 'INFO' || level === 'DEBUG') {
      const prevMsg = this.infoByKey.get(key)
      if (prevMsg === message) return
      this.infoByKey.set(key, message)
      if (this.infoByKey.size > 300) {
        const oldestKey = this.infoByKey.keys().next().value
        if (oldestKey) this.infoByKey.delete(oldestKey)
      }
      this.log(level, scope, message)
      return
    }

    const dedupKey = `${key}:${message}`
    const prev = this.dedupMap.get(dedupKey)
    if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
      return
    }
    this.dedupMap.set(dedupKey, now)
    if (this.dedupMap.size > 200) {
      const oldestKey = this.dedupMap.keys().next().value
      if (oldestKey) this.dedupMap.delete(oldestKey)
    }
    this.log(level, scope, message)
  }

  getRecent(limit = 15): string[] {
    return this.ring.slice(-limit)
  }

  getLogFilePath(): string | null {
    return this.logFilePath
  }

  private log(level: LogLevel, scope: string, message: string): void {
    const stamp = new Date().toISOString()
    const formatted = `[${stamp}] [${level}] [${scope}] ${message}`
    this.ring.push(formatted)
    if (this.ring.length > MAX_RING_ENTRIES) {
      this.ring.shift()
    }
    if (level !== 'DEBUG') {
      try {
        this.sink(`[${level}] [${scope}] ${message}`)
      } catch {
        // Ignore sink failure.
      }
    }
    if (this.logFilePath) {
      this.enqueueFileWrite(`${formatted}\n`)
    }
  }

  private enqueueFileWrite(line: string): void {
    const target = this.logFilePath
    if (!target) return
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          await fs.mkdir(path.dirname(target), { recursive: true })
          try {
            const st = await fs.stat(target)
            if (st.size >= MAX_LOG_FILE_BYTES) {
              await fs.rename(target, `${target}.1`).catch(() => {})
            }
          } catch {
            // File does not exist yet.
          }
          await fs.appendFile(target, line, 'utf8')
        } catch {
          // Never fail worker execution if log file is unwritable.
        }
      })
      .catch(() => {})
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }
}
