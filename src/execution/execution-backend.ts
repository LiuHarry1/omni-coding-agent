/**
 * Unified tool execution surface — always backed by Agent Worker (RuntimePort).
 */
import type { EnvironmentId, FsPort } from './types.js'
import type { ShellKind } from '../core/shell/spawn-shell.js'

export type ExecResult = {
  stdout: string
  stderr: string
  code: number | null
  /** Set when the shell was killed after timeout (file-fd path). */
  timedOut?: boolean
  interrupted?: boolean
}

export interface ExecutionBackend {
  /** Always `worker` after isomorphic cut. */
  readonly kind: 'worker'
  readonly environmentId: EnvironmentId
  resolve(cwd: string, filePath: string): string
  assertInWorkspace(
    cwd: string,
    absPath: string,
    access: 'read' | 'write',
  ): void
  readText(absPath: string): Promise<string>
  writeText(absPath: string, content: string): Promise<void>
  mkdirp(dirPath: string): Promise<void>
  exists(absPath: string): Promise<boolean>
  isDirectory(absPath: string): Promise<boolean>
  exec(
    command: string,
    opts: {
      cwd: string
      timeoutMs?: number
      /** Default `bash` (Git Bash on Windows). */
      shell?: ShellKind
      signal?: AbortSignal
    },
  ): Promise<ExecResult & { cwdAfter?: string }>
  /** Start background shell; output appended to outputPath on the Worker. */
  execBgStart?(opts: {
    taskId: string
    command: string
    cwd: string
    outputPath: string
    shell?: ShellKind
  }): Promise<{ pid: number }>
  execBgPoll?(taskId: string): Promise<{
    done: boolean
    exitCode: number | null
    killed?: boolean
  }>
  execBgKill?(taskId: string): Promise<void>
  /**
   * Ripgrep: argv spawn on the Worker.
   * Exit codes 0 and 1 both succeed (1 = no matches → empty lines).
   */
  rg(
    args: string[],
    target: string,
    opts?: { timeoutMs?: number },
  ): Promise<string[]>
  fsPort?: FsPort
  /** Release per-consumer runtime listeners; does not stop the shared worker. */
  dispose?(): void
}
