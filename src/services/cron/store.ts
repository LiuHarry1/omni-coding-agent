import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getProcessAppDir } from '../../core/session-paths.js'
import {
  MAX_CRON_JOBS,
  RECURRING_JITTER_CAP_MS,
  RECURRING_JITTER_FRAC,
  RECURRING_MAX_AGE_MS,
  type CronFile,
  type ScheduledTask,
} from './types.js'
import { nextCronRunMs } from './parse.js'

let storePathOverride: string | undefined

export class CronStoreCorruptError extends Error {
  constructor(filePath: string, detail: string) {
    super(`Corrupt scheduled-task store (${filePath}): ${detail}`)
    this.name = 'CronStoreCorruptError'
  }
}

export function getCronStorePath(): string {
  return (
    storePathOverride ?? path.join(getProcessAppDir(), 'scheduled_tasks.json')
  )
}

export function _setCronStorePathForTest(p: string | null): void {
  storePathOverride = p ?? undefined
}

function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

export function computeNextRunAtMs(
  task: Pick<ScheduledTask, 'cron' | 'atMs' | 'recurring' | 'id'>,
  fromMs: number,
): number | null {
  if (typeof task.atMs === 'number' && Number.isFinite(task.atMs)) {
    return task.atMs > fromMs ? task.atMs : null
  }
  if (!task.cron) return null
  const t1 = nextCronRunMs(task.cron, fromMs)
  if (t1 === null) return null
  if (!task.recurring) return t1
  const t2 = nextCronRunMs(task.cron, t1)
  if (t2 === null) return t1
  const jitter = Math.min(
    jitterFrac(task.id) * RECURRING_JITTER_FRAC * (t2 - t1),
    RECURRING_JITTER_CAP_MS,
  )
  return t1 + jitter
}

export function isRecurringTaskAged(
  task: ScheduledTask,
  nowMs: number,
): boolean {
  return Boolean(
    task.recurring && nowMs - task.createdAt >= RECURRING_MAX_AGE_MS,
  )
}

function parseTask(t: unknown): ScheduledTask | null {
  if (!t || typeof t !== 'object') return null
  const row = t as Partial<ScheduledTask>
  if (
    typeof row.id !== 'string' ||
    typeof row.prompt !== 'string' ||
    typeof row.sessionId !== 'string' ||
    typeof row.cwd !== 'string' ||
    typeof row.createdAt !== 'number' ||
    typeof row.nextRunAtMs !== 'number'
  ) {
    return null
  }
  if (!row.cron && typeof row.atMs !== 'number') return null
  return {
    id: row.id,
    prompt: row.prompt,
    sessionId: row.sessionId,
    cwd: row.cwd,
    createdAt: row.createdAt,
    nextRunAtMs: row.nextRunAtMs,
    recurring: Boolean(row.recurring),
    ...(typeof row.cron === 'string' ? { cron: row.cron } : {}),
    ...(typeof row.atMs === 'number' ? { atMs: row.atMs } : {}),
    ...(typeof row.environmentId === 'string'
      ? { environmentId: row.environmentId }
      : {}),
    ...(typeof row.lastFiredAt === 'number'
      ? { lastFiredAt: row.lastFiredAt }
      : {}),
  }
}

export function readCronTasks(): ScheduledTask[] {
  const filePath = getCronStorePath()
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CronStoreCorruptError(filePath, 'invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CronStoreCorruptError(filePath, 'root is not an object')
  }
  const tasks = (parsed as Partial<CronFile>).tasks
  if (!Array.isArray(tasks)) {
    throw new CronStoreCorruptError(filePath, 'missing tasks array')
  }
  const out: ScheduledTask[] = []
  for (const t of tasks) {
    const parsedTask = parseTask(t)
    if (parsedTask) out.push(parsedTask)
  }
  return out
}

function atomicWriteFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, contents, 'utf-8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    fs.copyFileSync(tmp, filePath)
    fs.rmSync(tmp, { force: true })
  }
}

export function writeCronTasks(tasks: ScheduledTask[]): void {
  const filePath = getCronStorePath()
  const body: CronFile = { tasks }
  atomicWriteFile(filePath, JSON.stringify(body, null, 2) + '\n')
}

function allocateTaskId(existing: Set<string>): string {
  for (let i = 0; i < 16; i++) {
    const id = randomUUID().slice(0, 8)
    if (!existing.has(id)) return id
  }
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

export function addCronTask(
  input: Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAtMs'> & {
    nextRunAtMs?: number
  },
  nowMs = Date.now(),
): ScheduledTask {
  const tasks = readCronTasks()
  if (tasks.length >= MAX_CRON_JOBS) {
    throw new Error(`Too many scheduled jobs (max ${MAX_CRON_JOBS})`)
  }
  const id = allocateTaskId(new Set(tasks.map(t => t.id)))
  const draft: ScheduledTask = {
    ...input,
    id,
    createdAt: nowMs,
    nextRunAtMs: 0,
  }
  const next = computeNextRunAtMs(draft, nowMs)
  if (next === null) {
    throw new Error('Schedule does not match any time in the next year')
  }
  draft.nextRunAtMs = next
  tasks.push(draft)
  writeCronTasks(tasks)
  return draft
}

export function removeCronTasks(ids: string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const tasks = readCronTasks()
  const remaining = tasks.filter(t => !idSet.has(t.id))
  const removed = tasks.length - remaining.length
  if (removed > 0) writeCronTasks(remaining)
  return removed
}

export function removeTasksForSession(sessionId: string): number {
  const tasks = readCronTasks()
  const remaining = tasks.filter(t => t.sessionId !== sessionId)
  const removed = tasks.length - remaining.length
  if (removed > 0) writeCronTasks(remaining)
  return removed
}

export function removeTasksForSessions(
  sessionIds: Iterable<string>,
  workspace?: string,
): number {
  const ids = new Set(sessionIds)
  const root = workspace ? path.resolve(workspace) : null
  if (ids.size === 0 && !root) return 0
  const tasks = readCronTasks()
  const remaining = tasks.filter(task => {
    if (ids.has(task.sessionId)) return false
    if (!root) return true
    const cwd = path.resolve(task.cwd)
    return cwd !== root && !cwd.startsWith(root + path.sep)
  })
  const removed = tasks.length - remaining.length
  if (removed > 0) writeCronTasks(remaining)
  return removed
}

export function updateCronTask(
  id: string,
  patch: Partial<ScheduledTask>,
): ScheduledTask | null {
  const tasks = readCronTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx < 0) return null
  const next = { ...tasks[idx]!, ...patch, id }
  tasks[idx] = next
  writeCronTasks(tasks)
  return next
}

export function listCronTasksForSession(sessionId: string): ScheduledTask[] {
  return readCronTasks().filter(t => t.sessionId === sessionId)
}
