import {
  cronToHuman,
  nextCronRunMs,
  parseAbsoluteTimeMs,
  parseCronExpression,
} from './parse.js'
import { kickCronScheduler } from './scheduler.js'
import { isScheduledTasksEnabled } from './settings.js'
import {
  addCronTask,
  listCronTasksForSession,
  removeCronTasks,
} from './store.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import type { ScheduledTask } from './types.js'

export const SCHEDULED_TASKS_DISABLED_MESSAGE =
  'Scheduled tasks are disabled. Set scheduledTasks.enabled=true in .ai-agent/settings.json (project, user, or local) and retry.'

export type PublicCronTask = {
  id: string
  prompt: string
  recurring: boolean
  cron: string | null
  atMs: number | null
  nextRunAtMs: number
  schedule: string
}

export type ScheduleCronInput = {
  cwd: string
  settingsCwd?: string
  sessionId: string
  prompt: string
  cron?: string
  at?: string
  recurring?: boolean
  workspace?: WorkspaceHandle
  environmentId?: string
}

export type ScheduleCronOk = {
  ok: true
  task: ScheduledTask
  humanSchedule: string
}

export type ScheduleCronErr = {
  ok: false
  code: 'disabled' | 'invalid'
  message: string
}

export function toPublicCronTask(task: ScheduledTask): PublicCronTask {
  return {
    id: task.id,
    prompt: task.prompt,
    recurring: task.recurring,
    cron: task.cron ?? null,
    atMs: typeof task.atMs === 'number' ? task.atMs : null,
    nextRunAtMs: task.nextRunAtMs,
    schedule: task.cron
      ? cronToHuman(task.cron)
      : new Date(task.atMs!).toLocaleString(),
  }
}

export function listPublicCronTasks(sessionId: string): PublicCronTask[] {
  return listCronTasksForSession(sessionId).map(toPublicCronTask)
}

export function cancelCronTask(
  sessionId: string,
  id: string,
): { removed: boolean } {
  const owned = listCronTasksForSession(sessionId).some(t => t.id === id)
  if (!owned) return { removed: false }
  removeCronTasks([id])
  kickCronScheduler()
  return { removed: true }
}

export function scheduleCronTask(
  input: ScheduleCronInput,
): ScheduleCronOk | ScheduleCronErr {
  if (!isScheduledTasksEnabled(input.settingsCwd ?? input.cwd)) {
    return {
      ok: false,
      code: 'disabled',
      message: SCHEDULED_TASKS_DISABLED_MESSAGE,
    }
  }

  const prompt = input.prompt.trim()
  if (!prompt) {
    return { ok: false, code: 'invalid', message: 'prompt is required' }
  }

  const cron = input.cron?.trim() || undefined
  const at = input.at?.trim() || undefined
  if (Boolean(cron) === Boolean(at)) {
    return {
      ok: false,
      code: 'invalid',
      message: 'Provide exactly one of cron or at.',
    }
  }

  const storeInput: Parameters<typeof addCronTask>[0] = {
    prompt,
    sessionId: input.sessionId,
    cwd: input.cwd,
    recurring: input.recurring !== false && !at,
    workspace: input.workspace,
    environmentId: input.environmentId,
  }

  let humanSchedule: string
  if (cron) {
    if (!parseCronExpression(cron)) {
      return {
        ok: false,
        code: 'invalid',
        message: `Invalid cron '${cron}'. Expected 5 fields: M H DoM Mon DoW.`,
      }
    }
    if (nextCronRunMs(cron, Date.now()) === null) {
      return {
        ok: false,
        code: 'invalid',
        message: `Cron '${cron}' does not match any date in the next year.`,
      }
    }
    storeInput.cron = cron
    humanSchedule = cronToHuman(cron)
  } else {
    const atMs = parseAbsoluteTimeMs(at!)
    if (atMs === null) {
      return { ok: false, code: 'invalid', message: `Invalid at time '${at}'` }
    }
    if (atMs <= Date.now()) {
      return {
        ok: false,
        code: 'invalid',
        message: 'at time must be in the future',
      }
    }
    storeInput.atMs = atMs
    storeInput.recurring = false
    humanSchedule = new Date(atMs).toLocaleString()
  }

  try {
    const task = addCronTask(storeInput)
    kickCronScheduler()
    return { ok: true, task, humanSchedule }
  } catch (err) {
    return {
      ok: false,
      code: 'invalid',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
