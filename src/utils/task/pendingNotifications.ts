/**
 * Pending `<task-notification>` queue — drained into attachments each agent step.
 */
export type TaskNotificationPayload = {
  taskId: string
  outputFile: string
  status: 'completed' | 'failed' | 'killed' | 'unknown'
  summary: string
  toolUseId?: string
  rawXml: string
}

const queues = new Map<string, TaskNotificationPayload[]>()

export function enqueueTaskNotification(
  sessionId: string,
  payload: TaskNotificationPayload,
): void {
  const q = queues.get(sessionId) ?? []
  q.push(payload)
  queues.set(sessionId, q)
}

export function drainTaskNotifications(
  sessionId: string,
): TaskNotificationPayload[] {
  const q = queues.get(sessionId) ?? []
  queues.set(sessionId, [])
  return q
}

export function peekTaskNotificationCount(sessionId: string): number {
  return queues.get(sessionId)?.length ?? 0
}
