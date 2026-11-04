/**
 * Startup / turn checkpoints — console output only, no analytics backend.
 *
 * Off unless AGENT_PROFILE_STARTUP=1, so non-profiling runs pay one boolean
 * per checkpoint. Answers "is the first turn slow in the worker, in prepare,
 * or at the model?" without guessing:
 *
 *   AGENT_PROFILE_STARTUP=1 npm start
 *   [profile] turn_execution_backend_end  +2143ms  (t=5210ms)
 */

const ENABLED = process.env.AGENT_PROFILE_STARTUP === '1'

const startedAt = Date.now()
let lastAt = startedAt

/** Record a named checkpoint with its delta from the previous one. */
export function profileCheckpoint(name: string): void {
  if (!ENABLED) return
  const now = Date.now()
  const delta = now - lastAt
  lastAt = now
  console.error(`[profile] ${name} +${delta}ms (t=${now - startedAt}ms)`)
}

export function isProfilingEnabled(): boolean {
  return ENABLED
}

export type TurnProfiler = {
  checkpoint(name: string, fields?: Record<string, string | number>): void
}

/** Request-scoped timeline for cold/warm first-turn investigations. */
export function createTurnProfiler(
  sessionId: string,
  turnStartedAt = Date.now(),
): TurnProfiler {
  let previous = turnStartedAt
  return {
    checkpoint(name, fields = {}) {
      if (!ENABLED) return
      const now = Date.now()
      const suffix = Object.entries(fields)
        .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
        .join('')
      console.error(
        `[turn-profile] session=${sessionId} turn=${turnStartedAt} phase=${name} +${now - previous}ms total=${now - turnStartedAt}ms${suffix}`,
      )
      previous = now
    },
  }
}

/** Checkpoint a span around `fn`, keeping the call site a one-liner. */
export async function profileSpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ENABLED) return fn()
  profileCheckpoint(`${name}_start`)
  try {
    return await fn()
  } finally {
    profileCheckpoint(`${name}_end`)
  }
}
