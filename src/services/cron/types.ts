import type { WorkspaceHandle } from '../../execution/types.js'

export const MAX_CRON_JOBS = 50
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MIN_REFIRE_GAP_MS = 2_000
export const MAX_TIMER_DELAY_MS = 60_000
export const RECURRING_JITTER_FRAC = 0.1
export const RECURRING_JITTER_CAP_MS = 15 * 60 * 1000

export type ScheduledTask = {
  id: string
  /** 5-field cron in local time. Mutually exclusive with `atMs`. */
  cron?: string
  /** One-shot absolute time (epoch ms). Mutually exclusive with `cron`. */
  atMs?: number
  prompt: string
  sessionId: string
  cwd: string
  /** Atomic workspace snapshot; absent on legacy tasks. */
  workspace?: WorkspaceHandle
  /** @deprecated Use workspace.environmentId. */
  environmentId?: string
  recurring: boolean
  createdAt: number
  lastFiredAt?: number
  nextRunAtMs: number
}

export type CronFile = { tasks: ScheduledTask[] }

export type FireResult =
  'fired' | 'busy' | 'missing' | 'disabled' | 'error' | 'quota'
