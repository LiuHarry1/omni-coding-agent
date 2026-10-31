/**
 * LocalShellTask — explicit background shell tasks only.
 */
import type { ExecutionBackend } from '../../execution/execution-backend.js'
import {
  createTaskStateBase,
  generateTaskId,
  type LocalShellSpawnInput,
  type Task,
  type TaskHandle,
} from '../../Task.js'
import {
  getTaskOutputPath,
  initTaskOutput,
  setTaskSessionId,
  evictTaskOutput,
} from '../../utils/task/diskOutput.js'
import {
  registerTask,
  updateTaskState,
  getTask,
} from '../../utils/task/framework.js'
import { enqueueTaskNotification } from '../../utils/task/pendingNotifications.js'
import {
  spawnInProcessBackground,
  pollInProcessBackground,
} from '../../utils/ShellCommand.js'
import type { LocalShellTaskState } from './guards.js'
import { isLocalShellTask } from './guards.js'
import { killTask } from './killShellTasks.js'
import { isWorkerChannelLostError } from '../../execution/worker-channel-error.js'

export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '

export const LocalShellTask: Task = {
  name: 'LocalShellTask',
  type: 'local_bash',
  kill(taskId, sessionId, execution) {
    killTask(sessionId, taskId, execution)
  },
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function enqueueShellNotification(
  sessionId: string,
  taskId: string,
  description: string,
  status: 'completed' | 'failed' | 'killed' | 'unknown',
  exitCode: number | null | undefined,
  toolUseId?: string,
): void {
  let shouldEnqueue = false
  updateTaskState(sessionId, taskId, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  let summary: string
  switch (status) {
    case 'completed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${exitCode !== undefined && exitCode !== null ? ` (exit code ${exitCode})` : ''}`
      break
    case 'failed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" failed${exitCode !== undefined && exitCode !== null ? ` with exit code ${exitCode}` : ''}`
      break
    case 'killed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`
      break
    case 'unknown':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" has an unknown outcome because the Worker disconnected; inspect its effects before retrying`
      break
  }

  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<tool-use-id>${toolUseId}</tool-use-id>`
    : ''
  const rawXml = `<task-notification>
<task-id>${taskId}</task-id>${toolUseIdLine}
<output-file>${outputPath}</output-file>
<status>${status}</status>
<summary>${escapeXml(summary)}</summary>
</task-notification>`

  enqueueTaskNotification(sessionId, {
    taskId,
    outputFile: outputPath,
    status,
    summary,
    toolUseId,
    rawXml,
  })
}

async function watchUntilDone(opts: {
  sessionId: string
  taskId: string
  description: string
  toolUseId?: string
  execution?: ExecutionBackend
}): Promise<void> {
  const { sessionId, taskId, description, toolUseId, execution } = opts
  const pollMs = 400

  for (;;) {
    await new Promise(r => setTimeout(r, pollMs))
    let done = false
    let exitCode: number | null = null
    let killed = false

    if (execution?.execBgPoll) {
      try {
        const p = await execution.execBgPoll(taskId)
        done = p.done
        exitCode = p.exitCode
        killed = !!p.killed
      } catch (err) {
        if (isWorkerChannelLostError(err)) {
          updateTaskState(sessionId, taskId, task => ({
            ...task,
            status: 'unknown',
            endTime: Date.now(),
            result: {
              code: null,
              interrupted: true,
              reason: 'worker_lost',
            },
          }))
          enqueueShellNotification(
            sessionId,
            taskId,
            description,
            'unknown',
            null,
            toolUseId,
          )
          void evictTaskOutput(taskId)
          return
        }
        continue
      }
    } else {
      const p = pollInProcessBackground(taskId)
      if (!p) {
        return
      }
      done = p.done
      exitCode = p.exitCode
      killed = !!p.killed
    }

    if (!done) continue

    const cur = getTask(sessionId, taskId)
    if (cur && isLocalShellTask(cur) && cur.status === 'killed') {
      enqueueShellNotification(
        sessionId,
        taskId,
        description,
        'killed',
        exitCode,
        toolUseId,
      )
      void evictTaskOutput(taskId)
      return
    }

    const status =
      killed || (cur && cur.status === 'killed')
        ? 'killed'
        : exitCode === 0
          ? 'completed'
          : 'failed'

    updateTaskState(sessionId, taskId, task => {
      if (task.status === 'killed') return task
      return {
        ...task,
        status,
        endTime: Date.now(),
        result: { code: exitCode, interrupted: killed },
      }
    })

    enqueueShellNotification(
      sessionId,
      taskId,
      description,
      status === 'killed' ? 'killed' : status,
      exitCode,
      toolUseId,
    )
    void evictTaskOutput(taskId)
    return
  }
}

export type SpawnShellTaskContext = {
  execution?: ExecutionBackend
}

/**
 * Start a background shell task. Returns immediately with taskId.
 */
export async function spawnShellTask(
  input: LocalShellSpawnInput,
  context: SpawnShellTaskContext = {},
): Promise<TaskHandle> {
  const sessionId = input.sessionId ?? 'default'
  setTaskSessionId(sessionId)

  const taskId = generateTaskId('local_bash')
  const shell = input.shell ?? 'bash'
  const description =
    input.description?.trim() ||
    (input.command.length > 60
      ? input.command.slice(0, 57) + '...'
      : input.command)

  initTaskOutput(taskId)
  const outputPath = getTaskOutputPath(taskId)

  const taskState: LocalShellTaskState = {
    ...createTaskStateBase(taskId, 'local_bash', description, input.toolUseId),
    type: 'local_bash',
    status: 'running',
    command: input.command,
    completionStatusSentInAttachment: false,
    shell,
    sessionId,
    cwd: input.cwd,
    isBackgrounded: true,
    kind: 'bash',
  }
  taskState.outputFile = outputPath
  registerTask(sessionId, taskState)

  const { execution } = context
  if (execution?.execBgStart) {
    const started = await execution.execBgStart({
      taskId,
      command: input.command,
      cwd: input.cwd,
      outputPath,
      shell,
    })
    updateTaskState(sessionId, taskId, t => ({
      ...t,
      pid: started.pid,
    }))
  } else {
    const local = spawnInProcessBackground({
      taskId,
      command: input.command,
      cwd: input.cwd,
      shell,
    })
    updateTaskState(sessionId, taskId, t => ({
      ...t,
      pid: local.child.pid ?? undefined,
    }))
  }

  void watchUntilDone({
    sessionId,
    taskId,
    description,
    toolUseId: input.toolUseId,
    execution,
  })

  return {
    taskId,
    cleanup: () => killTask(sessionId, taskId, execution),
  }
}

export { killTask }
