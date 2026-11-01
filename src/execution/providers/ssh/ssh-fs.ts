import type { ChildProcess } from 'child_process'
import {
  ShellFsPort,
  type ShellResult,
  type ShellRunOptions,
} from '../../shell-fs.js'
import { sshSpawn } from './ssh-exec.js'
import type { ParsedSshHost } from './ssh-config.js'

export { remotePathShell } from '../../shell-fs.js'

/**
 * Remote filesystem via `ssh` + shell helpers (no ssh2 dependency).
 */
export class SshFsPort extends ShellFsPort {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly pendingReads = new Map<string, Promise<unknown>>()

  constructor(
    host: ParsedSshHost,
    private readonly maxConcurrency = 4,
  ) {
    super({ spawn: script => sshSpawn(host, script) })
  }

  private async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.waiters.shift()?.()
    }
  }

  private async withSlot<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private coalesce<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pendingReads.get(key) as Promise<T> | undefined
    if (existing) return existing
    const pending = operation().finally(() => {
      if (this.pendingReads.get(key) === pending) this.pendingReads.delete(key)
    })
    this.pendingReads.set(key, pending)
    return pending
  }

  override run(script: string, opts?: ShellRunOptions): Promise<ShellResult> {
    return this.withSlot(() => super.run(script, opts))
  }

  override async spawn(script: string): Promise<ChildProcess> {
    const release = await this.acquire()
    try {
      const child = await super.spawn(script)
      child.once('close', release)
      child.once('error', release)
      return child
    } catch (error) {
      release()
      throw error
    }
  }

  override listResolved(dirPath: string) {
    return this.coalesce(`list\0${dirPath}`, () => super.listResolved(dirPath))
  }

  override stat(filePath: string) {
    return this.coalesce(`stat\0${filePath}`, () => super.stat(filePath))
  }

  override inspectPath(filePath: string) {
    return this.coalesce(`inspect\0${filePath}`, () =>
      super.inspectPath(filePath),
    )
  }

  override readHead(filePath: string, maxBytes: number) {
    return this.coalesce(`head\0${maxBytes}\0${filePath}`, () =>
      super.readHead(filePath, maxBytes),
    )
  }

  override realpath(filePath: string) {
    return this.coalesce(`realpath\0${filePath}`, () =>
      super.realpath(filePath),
    )
  }
}
