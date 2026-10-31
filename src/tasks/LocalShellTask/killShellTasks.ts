/**
 * Kill helpers for local shell tasks.
 */
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { getTask, updateTaskState } from '../../utils/task/framework.js'
import { killInProcessBackground } from '../../utils/ShellCommand.js'
import { isLocalShellTask } from './guards.js'

export function killTask(
  sessionId: string,
  taskId: string,
  execution?: ExecutionBackend,
): void {
  const task = getTask(sessionId, taskId)
  if (!task || !isLocalShellTask(task)) return
  if (
    task.status === 'killed' ||
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'unknown'
  ) {
    return
  }

  if (execution?.execBgKill) {
    void execution.execBgKill(taskId).catch(() => {})
  } else {
    killInProcessBackground(taskId)
  }

  updateTaskState(sessionId, taskId, t => {
    if (!isLocalShellTask(t)) return t
    return {
      ...t,
      status: 'killed',
      endTime: Date.now(),
      result: {
        code: t.result?.code ?? null,
        interrupted: true,
      },
      notified: true, // suppress duplicate completion XML after an explicit stop
    }
  })
}
