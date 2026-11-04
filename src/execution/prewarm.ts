/**
 * Worker prewarm — guarded, fire-and-forget, swallows its own errors, never
 * blocks the caller.
 *
 * Spawning the Worker Runtime on the first `/chat` puts a process launch on
 * the critical path of the user's first message. `RuntimeBroker` keys runtimes
 * by `environmentId::cwd`, so a runtime opened here is reused verbatim by the
 * first turn — as long as we prewarm the cwd that turn will actually use.
 * A warmup that straddles `closeEnvironment` is discarded by the broker.
 */
import { getExecutionPlane } from './bootstrap.js'
import type { WorkspaceHandle } from './types.js'

function handleKey(handle: WorkspaceHandle): string {
  return `${handle.environmentId}::${handle.cwd}`
}

export class WorkspaceWarmupCoordinator {
  private inFlight = new Map<string, Promise<void>>()

  warm(handle: WorkspaceHandle): Promise<void> {
    const baseKey = handleKey(handle)
    const pending = this.inFlight.get(baseKey)
    if (pending) return pending

    const started = Date.now()
    const work = (async () => {
      try {
        const plane = getExecutionPlane()
        await plane.runtimes.getOrCreate(handle, 'prewarm')
        console.log(
          `[execution] prewarmed worker for ${baseKey} in ${Date.now() - started}ms`,
        )
      } catch (err) {
        console.warn(
          `[execution] worker prewarm failed for ${baseKey}: ` +
            `${err instanceof Error ? err.message : err}`,
        )
      }
    })()
    this.inFlight.set(baseKey, work)
    void work.finally(() => {
      if (this.inFlight.get(baseKey) === work) {
        this.inFlight.delete(baseKey)
      }
    })
    return work
  }

  invalidateEnvironment(environmentId: string): void {
    const prefix = `${environmentId}::`
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) this.inFlight.delete(key)
    }
  }
}

const coordinator = new WorkspaceWarmupCoordinator()

/** Awaitable warmup used when a caller wants to share the same cold start. */
export function warmRuntime(handle: WorkspaceHandle): Promise<void> {
  return coordinator.warm(handle)
}

/**
 * Open the Worker Runtime for `handle` in the background.
 * Repeated calls for the same workspace are collapsed.
 */
export function prewarmRuntime(handle: WorkspaceHandle): void {
  void warmRuntime(handle)
}

export function invalidatePrewarm(environmentId: string): void {
  coordinator.invalidateEnvironment(environmentId)
}

/** Prewarm the local Worker Runtime for `cwd`. */
export function prewarmLocalRuntime(cwd: string): void {
  prewarmRuntime({ environmentId: 'local', cwd })
}
