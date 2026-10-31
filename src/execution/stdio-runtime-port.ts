/**
 * RuntimePort backed by a child process (or SSH) stdio NDJSON channel.
 */
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { Readable, Writable } from 'stream'
import type { RuntimePort, WorkspaceHandle } from './types.js'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'
import { onNdjsonLines, writeNdjson } from './stdio-framing.js'
import { WorkerChannelLostError } from './worker-channel-error.js'

export type StdioRuntimePortOptions = {
  workspace: WorkspaceHandle
  stdin: Writable
  stdout: Readable
  /** Optional stderr logging */
  stderr?: Readable
  child?: ChildProcess
  /** Kill/cleanup when port closes */
  onClose?: () => void | Promise<void>
  workerVersion?: string
}

export class StdioRuntimePort implements RuntimePort {
  readonly workspace: WorkspaceHandle
  private ee = new EventEmitter()
  private closed = false
  private stdin: Writable
  private stdout: Readable
  private child?: ChildProcess
  private onCloseHook?: () => void | Promise<void>
  private unsub: () => void
  private ready = false
  private readyWaiters: Array<{
    resolve: () => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }> = []
  /** Last transport failure, used to explain an unmet `ready`. */
  private lastError: string | null = null

  constructor(opts: StdioRuntimePortOptions) {
    this.workspace = opts.workspace
    this.stdin = opts.stdin
    this.stdout = opts.stdout
    this.child = opts.child
    this.onCloseHook = opts.onClose

    this.unsub = onNdjsonLines(
      opts.stdout,
      msg => {
        const m = msg as RuntimeServerMessage
        if (m.type === 'ready') {
          this.ready = true
          const waiters = this.readyWaiters
          this.readyWaiters = []
          for (const w of waiters) {
            clearTimeout(w.timer)
            w.resolve()
          }
        }
        this.ee.emit('message', m)
      },
      err => {
        this.signalFailure(`Worker protocol error: ${err.message}`)
      },
    )

    this.stdin.on('error', this.onStreamError)
    this.stdout.on('error', this.onStreamError)
    this.stdout.on('end', this.onStdoutEnd)

    opts.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8').trim()
      if (text)
        console.error(`[worker:${this.workspace.environmentId}] ${text}`)
    })

    // Spawn failures (ENOENT, EACCES) emit 'error' and may never emit 'exit'.
    this.child?.on('error', err => {
      this.signalFailure(`Worker spawn failed: ${err.message}`)
    })

    this.child?.on('exit', (code, signal) => {
      this.signalFailure(`Worker exited (code=${code}, signal=${signal})`)
    })
  }

  private onStreamError = (err: Error): void => {
    this.signalFailure(`Worker stdio failed: ${err.message}`)
  }

  private onStdoutEnd = (): void => {
    this.signalFailure('Worker stdout closed')
  }

  private signalFailure(message: string): void {
    if (this.closed) return
    this.lastError = message
    this.ee.emit('message', {
      type: 'error',
      message,
    } satisfies RuntimeServerMessage)
    void this.close()
  }

  /**
   * Wait until Worker sends `ready` (after bind). Rejects as soon as the
   * child dies — waiting out the full timeout on a dead worker would stall
   * every turn that resolves an execution backend.
   */
  waitUntilReady(timeoutMs = 60_000): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.closed) {
      return Promise.reject(new Error(this.readyFailureMessage()))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter(w => w.timer !== timer)
        reject(new Error(`Worker ready timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.readyWaiters.push({ resolve, reject, timer })
    })
  }

  private readyFailureMessage(): string {
    return this.lastError
      ? `Worker closed before ready: ${this.lastError}`
      : 'Worker closed before ready'
  }

  send(msg: RuntimeClientMessage): void {
    if (this.closed || this.stdin.destroyed || this.stdin.writableEnded) {
      throw new WorkerChannelLostError(
        this.lastError ?? 'Worker channel is closed',
      )
    }
    try {
      writeNdjson(this.stdin, msg)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.signalFailure(message)
      throw new WorkerChannelLostError(message, {
        cause: err,
      })
    }
  }

  onMessage(handler: (msg: RuntimeServerMessage) => void): () => void {
    this.ee.on('message', handler)
    return () => this.ee.off('message', handler)
  }

  interrupt(): void {
    this.send({ type: 'interrupt', runId: '*' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (
        !this.lastError &&
        !this.stdin.destroyed &&
        !this.stdin.writableEnded
      ) {
        writeNdjson(this.stdin, { type: 'shutdown' })
      }
    } catch {
      /* ignore */
    }
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.reject(new Error(this.readyFailureMessage()))
    }
    this.unsub()
    // Keep the error listeners attached until the owned streams die. A
    // write can report EPIPE asynchronously after close() returns.
    this.stdout.off('end', this.onStdoutEnd)
    this.ee.removeAllListeners()
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
    await this.onCloseHook?.()
  }

  async health(): Promise<'ok' | 'dead'> {
    if (this.closed) return 'dead'
    return new Promise(resolve => {
      const id = `h-${Date.now()}`
      const timer = setTimeout(() => {
        off()
        resolve('dead')
      }, 5_000)
      const off = this.onMessage(msg => {
        if (msg.type === 'pong' && msg.id === id) {
          clearTimeout(timer)
          off()
          resolve('ok')
        } else if (msg.type === 'error') {
          clearTimeout(timer)
          off()
          resolve('dead')
        }
      })
      try {
        this.send({ type: 'ping', id })
      } catch {
        clearTimeout(timer)
        off()
        resolve('dead')
      }
    })
  }
}

/** Open RuntimePort: send bind and wait for ready. */
export async function bindStdioRuntime(
  port: StdioRuntimePort,
  workspace: WorkspaceHandle,
  timeoutMs = 60_000,
): Promise<void> {
  const wait = port.waitUntilReady(timeoutMs)
  port.send({ type: 'bind', workspace })
  await wait
}
