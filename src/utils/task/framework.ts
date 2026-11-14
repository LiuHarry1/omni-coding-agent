/**
 * Session-scoped task map — one Map per session rather than global app state.
 */
import type { TaskStateBase, TaskStatus, TaskType } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'

export type AnyTaskState =
  LocalShellTaskState | LocalAgentTaskState | TaskStateBase

const bySession = new Map<string, Map<string, AnyTaskState>>()

function sessionMap(sessionId: string): Map<string, AnyTaskState> {
  let m = bySession.get(sessionId)
  if (!m) {
    m = new Map()
    bySession.set(sessionId, m)
  }
  return m
}

export function registerTask(sessionId: string, task: AnyTaskState): void {
  sessionMap(sessionId).set(task.id, task)
}

export function getTask(
  sessionId: string,
  taskId: string,
): AnyTaskState | undefined {
  return sessionMap(sessionId).get(taskId)
}

export function updateTaskState(
  sessionId: string,
  taskId: string,
  updater: (task: AnyTaskState) => AnyTaskState,
): AnyTaskState | undefined {
  const m = sessionMap(sessionId)
  const cur = m.get(taskId)
  if (!cur) return undefined
  const next = updater(cur)
  m.set(taskId, next)
  return next
}

export function getTasksByType(
  sessionId: string,
  type: TaskType,
): AnyTaskState[] {
  return [...sessionMap(sessionId).values()].filter(t => t.type === type)
}

export function markTaskNotified(sessionId: string, taskId: string): void {
  updateTaskState(sessionId, taskId, t =>
    t.notified ? t : { ...t, notified: true },
  )
}

export function listRunningTasks(sessionId: string): AnyTaskState[] {
  return [...sessionMap(sessionId).values()].filter(
    t => !isTerminalTaskStatus(t.status as TaskStatus),
  )
}

/** All tasks for a session (running + terminal) — for UI /tasks listing. */
export function listSessionTasks(sessionId: string): AnyTaskState[] {
  return [...sessionMap(sessionId).values()]
}

/** Test / session teardown. */
export function clearSessionTasks(sessionId: string): void {
  bySession.delete(sessionId)
}
