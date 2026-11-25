import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { toWslUncPath, type WslEnvironmentResolver } from '../collectors/wsl-env'
import type { CursorHookStatus, WorkspaceEnv } from '../protocol'

const HOOK_MARKER = '.orca-telemetry/cursor-hook.mjs'
const HOOK_MARKER_WIN = '.orca-telemetry\\cursor-hook.mjs'

/** Standalone zero-dependency hook script executed by Cursor on `beforeSubmitPrompt` and `stop`. */
export const CURSOR_HOOK_SCRIPT_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) {
      const payload = JSON.parse(raw);
      const outDir = path.join(os.homedir(), '.orca-telemetry');
      fs.mkdirSync(outDir, { recursive: true });
      const spoolPath = path.join(outDir, 'cursor-usage.jsonl');
      const record = JSON.stringify({ timestamp: Date.now(), ...payload }) + '\\n';
      fs.appendFileSync(spoolPath, record, 'utf8');
    }
  } catch {
    // Never fail Cursor's lifecycle hook.
  }
  process.stdout.write('{}');
});
process.stdin.resume();
`

type CursorHookEntry = {
  command?: string
  [key: string]: unknown
}

type CursorHooksFile = {
  version?: number
  hooks?: Record<string, CursorHookEntry[]>
  [key: string]: unknown
}

function isOurHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const cmd = (entry as { command?: unknown }).command
  return typeof cmd === 'string' && (cmd.includes(HOOK_MARKER) || cmd.includes(HOOK_MARKER_WIN))
}

/** Merge or remove Orca Telemetry hook entries inside `~/.cursor/hooks.json` without touching other hooks. */
export function mergeCursorHooksJson(
  existingRaw: string | null,
  commandToInstall: string | null
): string {
  let doc: CursorHooksFile = { version: 1, hooks: {} }
  if (existingRaw && existingRaw.trim()) {
    try {
      const parsed = JSON.parse(existingRaw) as CursorHooksFile
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = { ...parsed }
      }
    } catch {
      // Preserve clean base if existing file was invalid JSON.
    }
  }

  const hooks: Record<string, CursorHookEntry[]> =
    doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)
      ? { ...doc.hooks }
      : {}

  const events = ['beforeSubmitPrompt', 'stop'] as const
  for (const eventName of events) {
    const current = Array.isArray(hooks[eventName]) ? hooks[eventName].filter((e) => !isOurHookEntry(e)) : []
    if (commandToInstall) {
      current.push({ command: commandToInstall })
    }
    if (current.length > 0) {
      hooks[eventName] = current
    } else {
      delete hooks[eventName]
    }
  }

  doc.version = typeof doc.version === 'number' ? doc.version : 1
  doc.hooks = hooks
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function hasTelemetryHookInstalled(rawJson: string | null): boolean {
  if (!rawJson) return false
  try {
    const doc = JSON.parse(rawJson) as CursorHooksFile
    const stopList = doc.hooks?.stop
    return Array.isArray(stopList) && stopList.some(isOurHookEntry)
  } catch {
    return false
  }
}

export type HookTargetPaths = {
  targetEnv: 'wsl' | 'windows'
  distro: string | null
  homeWin: string
  homeLinux: string | null
  hooksJsonPath: string
  scriptPath: string
  spoolPath: string
}

export class CursorHookManager {
  async resolveTarget(
    workspace: WorkspaceEnv,
    wslEnv: WslEnvironmentResolver
  ): Promise<HookTargetPaths> {
    if (workspace.hostKind === 'wsl' && workspace.wslDistro) {
      const homeLinux = await wslEnv.getWslHome(workspace.wslDistro)
      if (homeLinux) {
        const homeWin = toWslUncPath(workspace.wslDistro, homeLinux)
        return {
          targetEnv: 'wsl',
          distro: workspace.wslDistro,
          homeWin,
          homeLinux,
          hooksJsonPath: path.join(homeWin, '.cursor', 'hooks.json'),
          scriptPath: path.join(homeWin, '.orca-telemetry', 'cursor-hook.mjs'),
          spoolPath: path.join(homeWin, '.orca-telemetry', 'cursor-usage.jsonl')
        }
      }
    }

    const homeWin = os.homedir()
    return {
      targetEnv: 'windows',
      distro: null,
      homeWin,
      homeLinux: null,
      hooksJsonPath: path.join(homeWin, '.cursor', 'hooks.json'),
      scriptPath: path.join(homeWin, '.orca-telemetry', 'cursor-hook.mjs'),
      spoolPath: path.join(homeWin, '.orca-telemetry', 'cursor-usage.jsonl')
    }
  }

  async inspectStatus(
    enabled: boolean,
    workspace: WorkspaceEnv,
    wslEnv: WslEnvironmentResolver,
    lastEventAt: number | null
  ): Promise<CursorHookStatus> {
    try {
      const target = await this.resolveTarget(workspace, wslEnv)
      const raw = await readOptionalText(target.hooksJsonPath)
      return {
        enabled,
        installed: hasTelemetryHookInstalled(raw),
        targetEnv: target.targetEnv,
        distro: target.distro,
        hooksJsonPath: target.hooksJsonPath,
        spoolPath: target.spoolPath,
        lastEventAt
      }
    } catch (error) {
      return {
        enabled,
        installed: false,
        targetEnv: workspace.hostKind === 'wsl' ? 'wsl' : 'windows',
        distro: workspace.wslDistro,
        hooksJsonPath: null,
        spoolPath: null,
        lastEventAt,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async applyToggle(
    enabled: boolean,
    workspace: WorkspaceEnv,
    wslEnv: WslEnvironmentResolver,
    lastEventAt: number | null
  ): Promise<CursorHookStatus> {
    const target = await this.resolveTarget(workspace, wslEnv)
    try {
      const existing = await readOptionalText(target.hooksJsonPath)
      if (enabled) {
        await fs.mkdir(path.dirname(target.scriptPath), { recursive: true })
        await fs.writeFile(target.scriptPath, CURSOR_HOOK_SCRIPT_SOURCE, 'utf8')
        await fs.mkdir(path.dirname(target.hooksJsonPath), { recursive: true })

        const command = await this.buildHookCommand(target, wslEnv)
        const nextJson = mergeCursorHooksJson(existing, command)
        await fs.writeFile(target.hooksJsonPath, nextJson, 'utf8')
      } else if (existing !== null) {
        const nextJson = mergeCursorHooksJson(existing, null)
        await fs.writeFile(target.hooksJsonPath, nextJson, 'utf8')
      }

      const verified = await readOptionalText(target.hooksJsonPath)
      return {
        enabled,
        installed: hasTelemetryHookInstalled(verified),
        targetEnv: target.targetEnv,
        distro: target.distro,
        hooksJsonPath: target.hooksJsonPath,
        spoolPath: target.spoolPath,
        lastEventAt
      }
    } catch (error) {
      return {
        enabled,
        installed: false,
        targetEnv: target.targetEnv,
        distro: target.distro,
        hooksJsonPath: target.hooksJsonPath,
        spoolPath: target.spoolPath,
        lastEventAt,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async buildHookCommand(
    target: HookTargetPaths,
    wslEnv: WslEnvironmentResolver
  ): Promise<string> {
    if (target.targetEnv === 'wsl' && target.distro && target.homeLinux) {
      const scriptPosix = `${target.homeLinux}/.orca-telemetry/cursor-hook.mjs`
      const nodeRes = await wslEnv.execInWsl(target.distro, ['bash', '-lc', 'command -v node'], {
        timeoutMs: 2500
      })
      const nodeLines = nodeRes.exitCode === 0 ? nodeRes.stdout.trim().split(/\r?\n/) : []
      const nodeBin = [...nodeLines].reverse().find((line) => line.trim().startsWith('/'))?.trim() ?? ''
      const runner = nodeBin && nodeBin.startsWith('/') ? `"${nodeBin}"` : 'node'
      return `${runner} "${scriptPosix}"`
    }

    const escaped = target.scriptPath.replace(/"/g, '\\"')
    return `node "${escaped}"`
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}
