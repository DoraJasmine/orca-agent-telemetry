import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TelemetryLogger } from '../logger'
import type { WorkspaceEnv } from '../protocol'

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

function decodeProcessBuffer(raw: string | Buffer): string {
  if (typeof raw === 'string') return raw.replace(/\0/g, '').replace(/^\uFEFF/, '')
  if (raw.length === 0) return ''
  // Windows `wsl.exe` emits UTF-16LE with interleaved null bytes unless WSL_UTF8=1 is honored.
  if (raw.includes(0)) {
    return raw.toString('utf16le').replace(/\0/g, '').replace(/^\uFEFF/, '')
  }
  return raw.toString('utf8').replace(/^\uFEFF/, '')
}

export function buildCleanChildEnv(
  extra?: Record<string, string | undefined>,
  deps?: { baseEnv?: Record<string, string | undefined>; homeDir?: string; platform?: string }
): Record<string, string | undefined> {
  const platform = deps?.platform ?? process.platform
  const childEnv: Record<string, string | undefined> = {
    ...(deps?.baseEnv ?? process.env),
    WSL_UTF8: '1',
    ...extra
  }
  // Orca `trusted-worker` processes scrub APPDATA/LOCALAPPDATA/USERPROFILE from `process.env`,
  // while `os.homedir()` still resolves via Windows user profile APIs. Reconstruct them when missing
  // so `resources/bin/orca.exe` can locate Orca's runtime metadata directory.
  if (platform === 'win32') {
    const home = deps?.homeDir ?? os.homedir()
    if (home) {
      if (!childEnv.USERPROFILE) childEnv.USERPROFILE = home
      if (!childEnv.HOME) childEnv.HOME = home
      if (!childEnv.APPDATA) childEnv.APPDATA = path.join(home, 'AppData', 'Roaming')
      if (!childEnv.LOCALAPPDATA) childEnv.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
    }
  }
  // Electron `trusted-worker` processes inherit ELECTRON_RUN_AS_NODE=1 and CLI wrapper vars;
  // strip them so `resources/bin/orca.exe` executes cleanly as a standalone CLI.
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE
  delete childEnv.ORCA_CLI_COMMAND
  delete childEnv.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER
  return childEnv
}

export const defaultCommandRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options?.cwd,
        timeout: options?.timeoutMs ?? 4500,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer',
        env: buildCleanChildEnv(options?.env)
      },
      (error, stdout, stderr) => {
        const cleanStdout = decodeProcessBuffer(stdout)
        const cleanStderr = decodeProcessBuffer(stderr)
        if (!error) {
          resolve({ stdout: cleanStdout, stderr: cleanStderr, exitCode: 0 })
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ stdout: cleanStdout, stderr: cleanStderr || error.message, exitCode: code })
      }
    )
  })

/** Parse `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` UNC paths. */
export function parseWslUncPath(rawPath: string): { distro: string; linuxPath: string } | null {
  const match = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i.exec(rawPath.trim())
  if (!match) return null
  const distro = match[1]
  const rest = match[2].replace(/\\/g, '/')
  const linuxPath = rest.length === 0 ? '/' : rest.startsWith('/') ? rest : `/${rest}`
  return { distro, linuxPath }
}

/** Build a Windows `\\wsl.localhost\<distro>\...` UNC path from a Linux POSIX path. */
export function toWslUncPath(distro: string, linuxPath: string): string {
  const cleaned = linuxPath.replace(/^\/+/, '').replace(/\//g, '\\')
  return cleaned.length > 0 ? `\\\\wsl.localhost\\${distro}\\${cleaned}` : `\\\\wsl.localhost\\${distro}`
}

/** Extract an explicit WSL distro name if embedded in Orca's `hostId` (e.g. `wsl:Ubuntu` or `runtime:wsl:Ubuntu`). */
export function extractDistroFromHostId(hostId: string | null | undefined): string | null {
  if (!hostId) return null
  const wslMatch = /(?:^|:)wsl:([^:]+)$/i.exec(hostId.trim())
  return wslMatch ? wslMatch[1] : null
}

export type HomeRoot = {
  env: 'wsl' | 'windows'
  distro: string | null
  homeWin: string
  homeLinux: string | null
}

export class WslEnvironmentResolver {
  private readonly runner: CommandRunner
  private readonly pathExists: (p: string) => Promise<boolean>
  private readonly logger?: TelemetryLogger
  private readonly execPathOverride?: string | null
  private readonly localAppDataOverride?: string | null
  private readonly homeDirOverride?: string
  private runningDistrosCache: { at: number; distros: string[] } | null = null
  private readonly wslHomeCache = new Map<string, string>()
  private orcaBinCache: string | null | undefined = undefined

  constructor(deps?: {
    runner?: CommandRunner
    pathExists?: (p: string) => Promise<boolean>
    logger?: TelemetryLogger
    execPath?: string | null
    localAppData?: string | null
    homeDir?: string
  }) {
    this.runner = deps?.runner ?? defaultCommandRunner
    this.logger = deps?.logger
    this.execPathOverride = deps?.execPath
    this.localAppDataOverride = deps?.localAppData
    this.homeDirOverride = deps?.homeDir
    this.pathExists =
      deps?.pathExists ??
      (async (p: string) => {
        try {
          await fs.stat(p)
          return true
        } catch {
          return false
        }
      })
  }

  async resolveOrcaExecutable(): Promise<string> {
    if (this.orcaBinCache !== undefined && this.orcaBinCache !== null) {
      return this.orcaBinCache
    }
    if (process.platform === 'win32') {
      const execPath =
        this.execPathOverride === undefined ? process.execPath : this.execPathOverride
      const localAppData =
        this.localAppDataOverride === undefined
          ? process.env.LOCALAPPDATA
          : this.localAppDataOverride
      const homeDir = this.homeDirOverride ?? os.homedir()
      const candidates: string[] = []
      const addCandidate = (p: string | null | undefined): void => {
        if (!p) return
        const normalized = path.normalize(p)
        if (!candidates.includes(normalized)) candidates.push(normalized)
      }

      if (execPath) {
        addCandidate(path.join(path.dirname(execPath), 'resources', 'bin', 'orca.exe'))
      }
      if (localAppData) {
        addCandidate(path.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'))
      }
      if (homeDir) {
        addCandidate(
          path.join(homeDir, 'AppData', 'Local', 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
        )
      }

      for (const candidate of candidates) {
        if (await this.pathExists(candidate)) {
          this.orcaBinCache = candidate
          this.logger?.logOnce('orca-bin', 'INFO', 'orca-cli', `Resolved Orca CLI binary: ${candidate}`)
          return candidate
        }
      }

      this.logger?.logOnce(
        'orca-bin-fallback',
        'WARN',
        'orca-cli',
        `Falling back to bare "orca" command because packaged resources/bin/orca.exe was not found (${candidates.join(', ')})`
      )
    }
    this.orcaBinCache = 'orca'
    return 'orca'
  }

  async execOrcaCli(
    args: readonly string[],
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const bin = await this.resolveOrcaExecutable()
    return this.runner(bin, args, { timeoutMs: options?.timeoutMs ?? 4500 })
  }

  /** List only already-running WSL distros so sleeping VMs are never woken accidentally. */
  async listRunningDistros(force = false): Promise<string[]> {
    if (process.platform !== 'win32') return []
    const now = Date.now()
    const maxAge = this.runningDistrosCache?.distros.length ? 60_000 : 10_000
    if (!force && this.runningDistrosCache && now - this.runningDistrosCache.at < maxAge) {
      return this.runningDistrosCache.distros
    }
    const res = await this.runner('wsl.exe', ['-l', '--running', '-q'], { timeoutMs: 3000 })
    if (res.exitCode !== 0) {
      if (res.stderr.trim()) {
        this.logger?.logOnce('wsl-list', 'WARN', 'wsl', `wsl.exe -l --running failed: ${res.stderr.trim()}`)
      }
      this.runningDistrosCache = { at: now, distros: [] }
      return []
    }
    const distros = res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    this.runningDistrosCache = { at: now, distros }
    if (distros.length > 0) {
      this.logger?.logOnce('wsl-running', 'INFO', 'wsl', `Running WSL distros: ${distros.join(', ')}`)
    }
    return distros
  }

  async getWslHome(distro: string): Promise<string | null> {
    const cached = this.wslHomeCache.get(distro)
    if (cached) return cached
    const res = await this.runner('wsl.exe', ['-d', distro, '-e', 'sh', '-c', 'printf %s "$HOME"'], {
      timeoutMs: 3500
    })
    const home = res.exitCode === 0 ? res.stdout.trim() : ''
    if (!home.startsWith('/')) {
      this.logger?.logOnce(
        `wsl-home:${distro}`,
        'WARN',
        'wsl',
        `Failed to resolve $HOME for distro "${distro}": ${res.stderr.trim() || 'empty output'}`
      )
      return null
    }
    this.wslHomeCache.set(distro, home)
    return home
  }

  async execInWsl(
    distro: string,
    args: readonly string[],
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.runner('wsl.exe', ['-d', distro, '--', ...args], {
      timeoutMs: options?.timeoutMs ?? 4500
    })
  }

  async execLocal(
    file: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.runner(file, args, options)
  }

  /** Resolve workspace path & host kind across Windows UNC paths, WSL host bridges, and local folders. */
  async resolveWorkspaceEnv(input: {
    workspaceId: string | null
    displayName: string
    rawPath: string | null
    hostId: string | null
  }): Promise<WorkspaceEnv> {
    const rawPath = input.rawPath ?? null
    if (!rawPath) {
      return {
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        rawPath: null,
        hostKind: input.hostId?.startsWith('ssh:') ? 'remote' : 'unknown',
        wslDistro: null,
        linuxPath: null,
        windowsPath: null
      }
    }

    const unc = parseWslUncPath(rawPath)
    if (unc) {
      return {
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        rawPath,
        hostKind: 'wsl',
        wslDistro: unc.distro,
        linuxPath: unc.linuxPath,
        windowsPath: rawPath
      }
    }

    if (rawPath.startsWith('/')) {
      if (input.hostId?.startsWith('ssh:')) {
        return {
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          rawPath,
          hostKind: 'remote',
          wslDistro: null,
          linuxPath: rawPath,
          windowsPath: null
        }
      }

      if (process.platform === 'win32') {
        const running = await this.listRunningDistros()
        const hinted = extractDistroFromHostId(input.hostId)
        const candidates = hinted ? [hinted, ...running.filter((d) => d !== hinted)] : running

        for (const distro of candidates) {
          const uncCandidate = toWslUncPath(distro, rawPath)
          if (await this.pathExists(uncCandidate)) {
            return {
              workspaceId: input.workspaceId,
              displayName: input.displayName,
              rawPath,
              hostKind: 'wsl',
              wslDistro: distro,
              linuxPath: rawPath,
              windowsPath: uncCandidate
            }
          }
        }
      }

      return {
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        rawPath,
        hostKind: 'unknown',
        wslDistro: null,
        linuxPath: rawPath,
        windowsPath: null
      }
    }

    if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
      return {
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        rawPath,
        hostKind: 'local',
        wslDistro: null,
        linuxPath: null,
        windowsPath: rawPath
      }
    }

    return {
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      rawPath,
      hostKind: 'unknown',
      wslDistro: null,
      linuxPath: null,
      windowsPath: null
    }
  }

  /** Ordered search roots for agent session logs: active WSL distro home first, then Windows home. */
  async getHomeSearchRoots(workspace: WorkspaceEnv): Promise<HomeRoot[]> {
    if (workspace.hostKind === 'remote') {
      return []
    }

    const roots: HomeRoot[] = []
    const seen = new Set<string>()

    const addWslRoot = async (distro: string) => {
      const homeLinux = await this.getWslHome(distro)
      if (!homeLinux) return
      const homeWin = toWslUncPath(distro, homeLinux)
      const key = `wsl:${distro}:${homeLinux}`
      if (seen.has(key)) return
      seen.add(key)
      roots.push({ env: 'wsl', distro, homeWin, homeLinux })
    }

    if (workspace.wslDistro) {
      await addWslRoot(workspace.wslDistro)
    }

    const winHome = os.homedir()
    if (winHome) {
      const key = `win:${path.normalize(winHome).toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        roots.push({ env: 'windows', distro: null, homeWin: winHome, homeLinux: null })
      }
    }

    if (!workspace.wslDistro && workspace.hostKind === 'unknown' && process.platform === 'win32') {
      const running = await this.listRunningDistros()
      for (const distro of running) {
        await addWslRoot(distro)
      }
    }

    return roots
  }
}
