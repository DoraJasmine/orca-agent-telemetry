// Minimal Node built-in declarations so `tsc` checks without requiring `npm install @types/node`.
declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}

declare class Buffer {
  readonly length: number
  static alloc(size: number): Buffer
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer
  static from(data: string | Uint8Array, encoding?: string): Buffer
  includes(value: number): boolean
  subarray(start?: number, end?: number): Buffer
  toString(encoding?: string, start?: number, end?: number): string
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...paths: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, suffix?: string): string
  export function resolve(...paths: string[]): string
  export const sep: string
  export const win32: {
    join(...paths: string[]): string
  }
  export const posix: {
    join(...paths: string[]): string
  }
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
    isFile(): boolean
  }
  export interface Stats {
    readonly size: number
    readonly mtimeMs: number
    isDirectory(): boolean
    isFile(): boolean
  }
}

declare module 'node:fs/promises' {
  import type { Dirent, Stats } from 'node:fs'

  export interface FileHandle {
    read(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null
    ): Promise<{ bytesRead: number; buffer: Uint8Array }>
    close(): Promise<void>
  }

  export function stat(path: string): Promise<Stats>
  export function open(path: string, flags: string): Promise<FileHandle>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readFile(path: string): Promise<Buffer>
  export function writeFile(path: string, data: string, encoding?: 'utf8'): Promise<void>
  export function appendFile(path: string, data: string, encoding?: 'utf8'): Promise<void>
  export function rename(oldPath: string, newPath: string): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function mkdtemp(prefix: string): Promise<string>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function readdir(path: string): Promise<string[]>
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
}

declare module 'node:child_process' {
  export type ExecFileOptions = {
    cwd?: string
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
    encoding?: 'utf8' | 'buffer'
    env?: Record<string, string | undefined>
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (
      error: (Error & { code?: number | string }) | null,
      stdout: string | Buffer,
      stderr: string | Buffer
    ) => void
  ): void
}
