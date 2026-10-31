/**
 * stopTask — kill a running task by id and report the outcome.
 */
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { getTaskByType } from '../tasks.js'
import { getTask } from '../utils/task/framework.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from './LocalShellTask/LocalShellTask.js'

export async function stopTask(
  sessionId: string,
  taskId: string,
  execution?: ExecutionBackend,
): Promise<{ message: string }> {
  const task = getTask(sessionId, taskId)
  if (!task) {
    throw new Error(`No task found with ID: ${taskId}`)
  }
  if (!isLocalShellTask(task)) {
    throw new Error(`Task ${taskId} is not a local_bash task`)
  }
  if (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'killed' ||
    task.status === 'unknown'
  ) {
    return { message: `Task ${taskId} already finished (${task.status}).` }
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new Error(`Unsupported task type: ${task.type}`)
  }
  await taskImpl.kill(taskId, sessionId, execution)

  return {
    message: `${BACKGROUND_BASH_SUMMARY_PREFIX}"${task.description}" was stopped`,
  }
}
