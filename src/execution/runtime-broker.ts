import type { CredentialBroker } from './credential-broker.js'
import type { EnvironmentRegistry } from './environment-registry.js'
import type { RuntimePort, WorkspaceHandle } from './types.js'
import { readWorkerVersion } from './worker-paths.js'

function handleKey(h: WorkspaceHandle): string {
  return `${h.environmentId}::${h.cwd}`
}

/**
 * Owns open RuntimePort instances keyed by WorkspaceHandle.
 */
export class RuntimeBroker {
  private runtimes = new Map<string, RuntimePort>()
  /** Opens in progress, so concurrent callers share one worker per key. */
  private opening = new Map<string, Promise<RuntimePort>>()
  /** Bumped by closeEnvironment; an open that straddles a close is discarded. */
  private closeEpochs = new Map<string, number>()

  constructor(
    private registry: EnvironmentRegistry,
    private credentials: CredentialBroker,
  ) {}

  async getOrCreate(
    handle: WorkspaceHandle,
    sessionId: string,
  ): Promise<RuntimePort> {
    const key = handleKey(handle)
    const epoch = this.closeEpoch(handle.environmentId)
    const existing = this.runtimes.get(key)
    if (existing) {
      const health = await existing.health()
      if (health === 'ok') return existing
      await existing.close().catch(() => {})
      this.runtimes.delete(key)
    }

    // A prewarm and the first turn typically arrive together; without this the
    // turn would spawn a second worker and orphan whichever lost the race.
    const inFlight = this.opening.get(key)
    if (inFlight) return inFlight

    const opened = this.open(handle, sessionId, key, epoch)
    this.opening.set(key, opened)
    try {
      return await opened
    } finally {
      if (this.opening.get(key) === opened) this.opening.delete(key)
    }
  }

  private closeEpoch(environmentId: string): number {
    return this.closeEpochs.get(environmentId) ?? 0
  }

  private async open(
    handle: WorkspaceHandle,
    sessionId: string,
    key: string,
    epoch: number,
  ): Promise<RuntimePort> {
    let conn = this.registry.getConnectionForEnv(handle.environmentId)
    if (!conn) {
      conn = await this.registry.connect(handle.environmentId, {
        preferredCwd: handle.cwd,
      })
    }

    const version = readWorkerVersion()
    await conn.ensureWorker(version)

    const auth = this.credentials.issueRuntimeAuth(
      sessionId,
      handle.environmentId,
    )
    const runtime = await conn.openRuntime(handle.cwd, auth)
    if (this.closeEpoch(handle.environmentId) !== epoch) {
      await runtime.close().catch(() => {})
      throw new Error(
        `environment ${handle.environmentId} was closed while its runtime was opening`,
      )
    }
    this.runtimes.set(key, runtime)
    let offFailure: () => void = () => {}
    offFailure = runtime.onMessage(message => {
      if (message.type !== 'error') return
      if (this.runtimes.get(key) === runtime) this.runtimes.delete(key)
      offFailure()
      queueMicrotask(() => void runtime.close().catch(() => {}))
    })
    return runtime
  }

  get(handle: WorkspaceHandle): RuntimePort | undefined {
    return this.runtimes.get(handleKey(handle))
  }

  /** Find an open Worker runtime whose cwd matches (local or remote). */
  findByCwd(
    cwd: string,
  ): { handle: WorkspaceHandle; runtime: RuntimePort } | undefined {
    const want = cwd.replace(/\\/g, '/').replace(/\/$/, '')
    for (const [key, runtime] of this.runtimes) {
      const sep = key.indexOf('::')
      if (sep < 0) continue
      const environmentId = key.slice(0, sep)
      const rtCwd = key.slice(sep + 2)
      const got = rtCwd.replace(/\\/g, '/').replace(/\/$/, '')
      if (got === want) {
        return {
          handle: { environmentId, cwd: rtCwd },
          runtime,
        }
      }
    }
    return undefined
  }

  async close(handle: WorkspaceHandle): Promise<void> {
    const key = handleKey(handle)
    const rt = this.runtimes.get(key)
    if (!rt) return
    this.runtimes.delete(key)
    await rt.close().catch(() => {})
  }

  /** Close cached and currently-opening runtimes for one environment. */
  async closeEnvironment(environmentId: string): Promise<void> {
    const prefix = `${environmentId}::`
    this.closeEpochs.set(environmentId, this.closeEpoch(environmentId) + 1)
    const closeCached = async () => {
      const matches = [...this.runtimes].filter(([key]) =>
        key.startsWith(prefix),
      )
      for (const [key, runtime] of matches) {
        this.runtimes.delete(key)
        await runtime.close().catch(() => {})
      }
    }

    await closeCached()
    const opening = [...this.opening]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, promise]) => promise)
    if (opening.length > 0) await Promise.allSettled(opening)
    await closeCached()
  }

  async closeAll(): Promise<void> {
    const all = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.all(all.map(r => r.close().catch(() => {})))
  }
}
