/**
 * Kill helpers for local shell tasks.
 */
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import { removeByFilter } from '../../utils/messageQueueManager.js'
import {
  getTask,
  listRunningTasks,
  updateTaskState,
} from '../../utils/task/framework.js'
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

/**
 * A subagent is exiting: stop the background shells it started and drop
 * what is still queued for it, since its loop will not read it any more
 * (Claude Code `killShellTasksForAgent`).
 */
export function killShellTasksForAgent(
  sessionId: string,
  agentId: string,
  execution?: ExecutionBackend,
): void {
  for (const task of listRunningTasks(sessionId)) {
    if (isLocalShellTask(task) && task.agentId === agentId) {
      console.log(
        `[tasks] stopping shell task ${task.id}: agent ${agentId} is exiting`,
      )
      killTask(sessionId, task.id, execution)
    }
  }
  removeByFilter(sessionId, cmd => cmd.agentId === agentId)
}
