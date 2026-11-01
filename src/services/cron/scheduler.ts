import {
  MAX_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
  type FireResult,
  type ScheduledTask,
} from './types.js'
import { isScheduledTaskEnabled } from './settings.js'
import { readCronTasks } from './store.js'

async function fireScheduledTaskLazy(
  task: ScheduledTask,
  nowMs: number,
): Promise<FireResult> {
  // fire.ts reaches run-chat-turn -> tools.ts. Keep that path out of scheduler
  // initialization so Cron tool definitions can safely import schedule.ts.
  const { fireScheduledTask } = await import('./fire.js')
  return fireScheduledTask(task, nowMs)
}

export type CronSchedulerDeps = {
  nowMs?: () => number
  fire?: (task: ScheduledTask, nowMs: number) => Promise<FireResult>
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  kick: () => void
  /** Process due tasks once. Used by tests and the timer callback. */
  tick: () => Promise<void>
}

export function createCronScheduler(
  deps: CronSchedulerDeps = {},
): CronScheduler {
  const nowMs = deps.nowMs ?? (() => Date.now())
  const fire = deps.fire ?? fireScheduledTaskLazy
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  const inFlight = new Set<string>()

  function arm() {
    if (timer) {
      clearTimeoutFn(timer)
      timer = null
    }
    if (stopped) return

    const now = nowMs()
    const all = readCronTasks()
    if (all.length === 0) return

    const tasks = all.filter(isScheduledTaskEnabled)
    let nextAt = Infinity
    for (const t of tasks) {
      if (inFlight.has(t.id)) continue
      if (t.nextRunAtMs < nextAt) nextAt = t.nextRunAtMs
    }

    const delay =
      nextAt === Infinity ? MAX_TIMER_DELAY_MS : Math.max(nextAt - now, 0)
    const floored = delay === 0 ? MIN_REFIRE_GAP_MS : delay
    const clamped = Math.min(floored, MAX_TIMER_DELAY_MS)

    timer = setTimeoutFn(() => {
      void tick().catch(err => {
        console.warn(
          `[cron] tick failed: ${err instanceof Error ? err.message : err}`,
        )
      })
    }, clamped)
  }

  async function tick() {
    if (stopped) return
    const now = nowMs()
    const due = readCronTasks().filter(
      t =>
        now >= t.nextRunAtMs &&
        !inFlight.has(t.id) &&
        isScheduledTaskEnabled(t),
    )

    const bySession = new Map<string, ScheduledTask[]>()
    for (const task of due) {
      const list = bySession.get(task.sessionId) ?? []
      list.push(task)
      bySession.set(task.sessionId, list)
    }

    await Promise.all(
      [...bySession.values()].map(async tasks => {
        for (const task of tasks) {
          if (stopped) break
          inFlight.add(task.id)
          try {
            await fire(task, now)
          } finally {
            inFlight.delete(task.id)
          }
        }
      }),
    )

    if (!stopped) arm()
  }

  return {
    start() {
      stopped = false
      arm()
    },
    stop() {
      stopped = true
      if (timer) {
        clearTimeoutFn(timer)
        timer = null
      }
    },
    kick() {
      if (stopped) return
      arm()
    },
    tick,
  }
}

let singleton: CronScheduler | null = null

export function startCronScheduler(): void {
  if (singleton) return
  singleton = createCronScheduler()
  singleton.start()
  console.log('[cron] scheduler started')
}

export function stopCronScheduler(): void {
  singleton?.stop()
  singleton = null
}

export function kickCronScheduler(): void {
  singleton?.kick()
}
