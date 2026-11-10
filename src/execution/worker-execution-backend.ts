/**
 * ExecutionBackend over RuntimePort fs_op / lsp_op RPC (isomorphic Worker).
 */
import * as path from 'path'
import type { RuntimePort } from './types.js'
import type { WorkerFsOp, WorkerLspOp } from './runtime-protocol.js'
import type { ExecResult, ExecutionBackend } from './execution-backend.js'
import type { LspServerConfig } from '../core/types.js'
import type { ShellKind } from '../core/shell/spawn-shell.js'
import { registerPendingLSPDiagnostic } from '../services/lsp/LSPDiagnosticRegistry.js'
import { getLspWorkspaceKey } from '../services/lsp/manager.js'
import { WorkerChannelLostError } from './worker-channel-error.js'

/** Windows drive/UNC abs must not go through posix.join (treated as relative). */
function isWindowsAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/]/.test(p)
}

function posixJoin(cwd: string, filePath: string): string {
  if (filePath.startsWith('/')) return path.posix.normalize(filePath)
  // Keep Windows abs paths intact even when worker pathStyle is posix
  // (e.g. mis-tagged local) — posix.join would yield cwd/C:\Users\….
  if (isWindowsAbsolutePath(filePath)) return path.normalize(filePath)
  return path.posix.normalize(
    path.posix.join(cwd.replace(/\\/g, '/'), filePath),
  )
}

function posixInWorkspace(cwd: string, absPath: string): boolean {
  const root = path.posix.normalize(cwd.replace(/\\/g, '/')).replace(/\/$/, '')
  const target = path.posix.normalize(absPath.replace(/\\/g, '/'))
  if (target === root) return true
  const rel = path.posix.relative(root, target)
  // Empty rel means same path (Boolean('') would wrongly reject the root).
  if (!rel) return true
  return !rel.startsWith('..') && !path.posix.isAbsolute(rel)
}

function localInWorkspace(cwd: string, absPath: string): boolean {
  const root = path.resolve(cwd)
  const target = path.resolve(absPath)
  if (root === target) return true
  const rel = path.relative(root, target)
  // path.relative(root, root) === '' — must allow workspace root itself
  // (Grep/Glob with path omitted resolve to cwd).
  if (!rel) return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * One slow request only fails itself; this many timeouts with no Worker
 * response in between means the Worker is hung and the channel is recycled.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 3

export class WorkerExecutionBackend implements ExecutionBackend {
  readonly kind = 'worker' as const
  private seq = 0
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
    }
  >()
  private unsub: () => void
  private workspaceKey: string
  private channelFailure: WorkerChannelLostError | undefined
  private consecutiveTimeouts = 0

  constructor(
    readonly environmentId: string,
    private runtime: RuntimePort,
    private pathStyle: 'posix' | 'local' = environmentId === 'local'
      ? 'local'
      : 'posix',
    private cwd: string = '',
    private lspServers?: Record<string, LspServerConfig>,
    /** Read on every check: approvals can add directories mid-turn. */
    private additionalRoots: () => readonly string[] = () => [],
  ) {
    this.workspaceKey = getLspWorkspaceKey(this.cwd, this.lspServers)
    this.unsub = runtime.onMessage(msg => {
      if (msg.type === 'error') {
        this.failChannel(msg.message)
        return
      }
      if (msg.type === 'lsp_event' && msg.event === 'diagnostics') {
        const count = msg.files.reduce((n, f) => n + f.diagnostics.length, 0)
        console.error(
          `[lsp:diagnostics:verify] cp recv lsp_event env=${this.environmentId} server=${msg.serverName} files=${msg.files.length} diagnostics=${count} workspaceKey=${this.workspaceKey ? this.workspaceKey.slice(0, 12) + '…' : '(empty)'}`,
        )
        if (!this.workspaceKey) {
          console.error(
            '[lsp:diagnostics:verify] cp drop: workspaceKey empty (pass cwd to WorkerExecutionBackend)',
          )
          return
        }
        registerPendingLSPDiagnostic(this.workspaceKey, {
          serverName: msg.serverName,
          files: msg.files,
        })
        return
      }
      if (msg.type !== 'fs_op_result' && msg.type !== 'lsp_op_result') return
      this.consecutiveTimeouts = 0
      const p = this.pending.get(msg.requestId)
      if (!p) return
      this.pending.delete(msg.requestId)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error))
    })
  }

  private failChannel(message: string): WorkerChannelLostError {
    if (this.channelFailure) return this.channelFailure
    const error = new WorkerChannelLostError(message)
    this.channelFailure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    return error
  }

  private timeOutRequest(requestId: string, message: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    this.pending.delete(requestId)
    pending.reject(new Error(message))
    this.consecutiveTimeouts += 1
    if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      this.failChannel(
        `Worker unresponsive after ${this.consecutiveTimeouts} consecutive timeouts`,
      )
      void this.runtime.close().catch(() => {})
    }
  }

  private sendExecCancel(targetRequestId: string): void {
    try {
      this.runtime.send({
        type: 'fs_op',
        requestId: `fs-${++this.seq}-${Date.now()}`,
        op: { op: 'exec_cancel', targetRequestId },
      })
    } catch (err) {
      this.failChannel(err instanceof Error ? err.message : String(err))
      void this.runtime.close().catch(() => {})
    }
  }

  private requestFs<T>(
    op: WorkerFsOp,
    timeoutMs = 180_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestId = `fs-${++this.seq}-${Date.now()}`
    return new Promise<T>((resolve, reject) => {
      if (this.channelFailure) {
        reject(this.channelFailure)
        return
      }
      let cancellationTimer: ReturnType<typeof setTimeout> | undefined
      let sent = false
      const cleanup = () => {
        clearTimeout(timer)
        if (cancellationTimer) clearTimeout(cancellationTimer)
        signal?.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        if (sent && op.op === 'exec' && !cancellationTimer) {
          this.sendExecCancel(requestId)
        }
        this.timeOutRequest(requestId, `Worker fs_op timed out: ${op.op}`)
      }, timeoutMs)
      const onAbort = () => {
        if (!sent || op.op !== 'exec' || !this.pending.has(requestId)) return
        if (cancellationTimer) return
        cancellationTimer = setTimeout(() => {
          this.timeOutRequest(requestId, 'Worker exec cancellation timed out')
        }, 5_000)
        cancellationTimer.unref?.()
        this.sendExecCancel(requestId)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        resolve: v => {
          cleanup()
          resolve(v as T)
        },
        reject: e => {
          cleanup()
          reject(e)
        },
      })
      try {
        this.runtime.send({ type: 'fs_op', requestId, op })
        sent = true
        if (signal?.aborted) onAbort()
      } catch (err) {
        this.pending.delete(requestId)
        const error = this.failChannel(
          err instanceof Error ? err.message : String(err),
        )
        cleanup()
        reject(error)
      }
    })
  }

  private requestLsp<T>(op: WorkerLspOp, timeoutMs = 180_000): Promise<T> {
    const requestId = `lsp-${++this.seq}-${Date.now()}`
    return new Promise<T>((resolve, reject) => {
      if (this.channelFailure) {
        reject(this.channelFailure)
        return
      }
      const timer = setTimeout(() => {
        this.timeOutRequest(requestId, `Worker lsp_op timed out: ${op.op}`)
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.runtime.send({ type: 'lsp_op', requestId, op })
      } catch (err) {
        this.pending.delete(requestId)
        const error = this.failChannel(
          err instanceof Error ? err.message : String(err),
        )
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  resolve(cwd: string, filePath: string): string {
    this.assertExecutionCwd(cwd)
    if (this.pathStyle === 'posix') return posixJoin(cwd, filePath)
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(cwd, filePath)
  }

  assertInWorkspace(
    cwd: string,
    absPath: string,
    _access: 'read' | 'write',
  ): void {
    this.assertExecutionCwd(cwd)
    if (!this.isInAllowedRoots(absPath)) {
      throw new Error(
        `Refused: "${absPath}" is outside the workspace root "${this.cwd}".`,
      )
    }
  }

  private isInAllowedRoots(target: string): boolean {
    const inRoot =
      this.pathStyle === 'posix' ? posixInWorkspace : localInWorkspace
    return [this.cwd, ...this.additionalRoots()].some(root =>
      inRoot(root, target),
    )
  }

  private assertExecutionCwd(cwd: string): void {
    if (!this.isInAllowedRoots(cwd)) {
      throw new Error(
        `Workspace context mismatch: execution cwd "${cwd}" is outside ` +
          `the Worker workspace root "${this.cwd}" (${this.environmentId}).`,
      )
    }
  }

  async readText(absPath: string): Promise<string> {
    return this.requestFs<string>({ op: 'readText', path: absPath })
  }

  async readBytes(absPath: string, maxBytes: number): Promise<Buffer> {
    const data = await this.requestFs<{ base64: string }>({
      op: 'readBytes',
      path: absPath,
      maxBytes,
    })
    return Buffer.from(data.base64, 'base64')
  }

  async writeText(absPath: string, content: string): Promise<void> {
    await this.requestFs<null>({ op: 'writeText', path: absPath, content })
  }

  async mkdirp(dirPath: string): Promise<void> {
    await this.requestFs<null>({ op: 'mkdirp', path: dirPath })
  }

  async exists(absPath: string): Promise<boolean> {
    return this.requestFs<boolean>({ op: 'exists', path: absPath })
  }

  async isDirectory(absPath: string): Promise<boolean> {
    return this.requestFs<boolean>({ op: 'isDirectory', path: absPath })
  }

  async exec(
    command: string,
    opts: {
      cwd: string
      timeoutMs?: number
      shell?: ShellKind
      signal?: AbortSignal
    },
  ): Promise<ExecResult & { cwdAfter?: string }> {
    this.assertExecutionCwd(opts.cwd)
    if (opts.signal?.aborted) {
      return {
        stdout: '',
        stderr: '',
        code: null,
        interrupted: true,
      }
    }
    const result = await this.requestFs<ExecResult & { cwdAfter?: string }>(
      {
        op: 'exec',
        command,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        shell: opts.shell,
      },
      (opts.timeoutMs ?? 120_000) + 10_000,
      opts.signal,
    )
    // A command may temporarily enter AgentHome to inspect or execute a Skill.
    // Do not persist that external directory as the next shell call's cwd,
    // and tell the model so its view of the cwd stays accurate.
    if (result.cwdAfter && !this.isInAllowedRoots(result.cwdAfter)) {
      const notice = `Shell cwd was reset to ${opts.cwd}`
      return {
        ...result,
        stderr: result.stderr ? `${result.stderr.trimEnd()}\n${notice}` : notice,
        cwdAfter: opts.cwd,
      }
    }
    return result
  }

  async execBgStart(opts: {
    taskId: string
    command: string
    cwd: string
    outputPath: string
    shell?: ShellKind
  }): Promise<{ pid: number }> {
    this.assertExecutionCwd(opts.cwd)
    return this.requestFs(
      {
        op: 'exec_bg_start',
        taskId: opts.taskId,
        command: opts.command,
        cwd: opts.cwd,
        outputPath: opts.outputPath,
        shell: opts.shell,
      },
      30_000,
    )
  }

  async execBgPoll(taskId: string): Promise<{
    done: boolean
    exitCode: number | null
    killed?: boolean
    unknown?: boolean
  }> {
    return this.requestFs({ op: 'exec_bg_poll', taskId }, 15_000)
  }

  async execBgKill(taskId: string): Promise<void> {
    await this.requestFs({ op: 'exec_bg_kill', taskId }, 15_000)
  }

  async rg(
    args: string[],
    target: string,
    opts?: { timeoutMs?: number },
  ): Promise<string[]> {
    const timeoutMs = opts?.timeoutMs ?? 20_000
    const result = await this.requestFs<{ lines: string[] }>(
      { op: 'rg', args, target, timeoutMs },
      timeoutMs + 10_000,
    )
    return result.lines
  }

  async configureLsp(servers: Record<string, LspServerConfig>): Promise<void> {
    this.lspServers = servers
    this.workspaceKey = getLspWorkspaceKey(this.cwd, servers)
    await this.requestLsp({ op: 'configure', servers })
  }

  async lspHasServerForFile(filePath: string): Promise<boolean> {
    return this.requestLsp<boolean>({
      op: 'hasServerForFile',
      filePath,
    })
  }

  async lspEnsure(filePath: string): Promise<unknown> {
    return this.requestLsp({ op: 'ensure', filePath }, 180_000)
  }

  async lspRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    return this.requestLsp<T | undefined>(
      { op: 'request', filePath, method, params },
      180_000,
    )
  }

  async lspOpenFile(filePath: string, content: string): Promise<void> {
    await this.requestLsp({ op: 'openFile', filePath, content })
  }

  async lspChangeFile(filePath: string, content: string): Promise<void> {
    await this.requestLsp({ op: 'changeFile', filePath, content })
  }

  async lspSaveFile(filePath: string): Promise<void> {
    await this.requestLsp({ op: 'saveFile', filePath })
  }

  async lspIsFileOpen(filePath: string): Promise<boolean> {
    return this.requestLsp<boolean>({ op: 'isFileOpen', filePath })
  }

  async lspListStatus(): Promise<
    Array<{
      name: string
      state: string
      command: string
      args: string[]
      extensions: string[]
      languages: string[]
      error?: string
    }>
  > {
    const data = await this.requestLsp<{ servers?: unknown }>(
      { op: 'listStatus' },
      8_000,
    )
    return Array.isArray(data?.servers)
      ? (data.servers as Array<{
          name: string
          state: string
          command: string
          args: string[]
          extensions: string[]
          languages: string[]
          error?: string
        }>)
      : []
  }

  dispose(): void {
    this.unsub()
    this.failChannel('WorkerExecutionBackend disposed with pending RPCs')
  }
}

export function isWorkerExecutionBackend(
  v: ExecutionBackend | undefined,
): v is WorkerExecutionBackend {
  return Boolean(v && v.kind === 'worker' && 'configureLsp' in v)
}
