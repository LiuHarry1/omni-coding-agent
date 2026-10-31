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

  constructor(
    private registry: EnvironmentRegistry,
    private credentials: CredentialBroker,
  ) {}

  async getOrCreate(
    handle: WorkspaceHandle,
    sessionId: string,
  ): Promise<RuntimePort> {
    const key = handleKey(handle)
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

    const opened = this.open(handle, sessionId, key)
    this.opening.set(key, opened)
    try {
      return await opened
    } finally {
      this.opening.delete(key)
    }
  }

  private async open(
    handle: WorkspaceHandle,
    sessionId: string,
    key: string,
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

  async closeAll(): Promise<void> {
    const all = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.all(all.map(r => r.close().catch(() => {})))
  }
}
