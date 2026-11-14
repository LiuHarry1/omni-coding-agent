/**
 * LocalAgentTask — a subagent running in the background
 * (Claude Code `tasks/LocalAgentTask/LocalAgentTask.tsx`).
 *
 * The Agent tool returns as soon as the task is registered. The agent keeps
 * working after the turn that launched it has ended, and reports back with
 * a task notification on the session's command queue.
 */
import {
  createTaskStateBase,
  generateTaskId,
  type Task,
  type TaskStateBase,
} from '../../Task.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  initTaskOutput,
  setTaskSessionId,
} from '../../utils/task/diskOutput.js'
import {
  getTask,
  registerTask,
  updateTaskState,
} from '../../utils/task/framework.js'

export type AgentProgress = {
  toolUseCount: number
  tokenCount: number
  /** What the agent did last, e.g. `Read src/core/query.ts`. */
  lastActivity?: string
}

export type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string
  prompt: string
  agentType: string
  sessionId: string
  abortController?: AbortController
  error?: string
  /** The final report, or what had been written when the agent was stopped. */
  result?: string
  progress?: AgentProgress
  isBackgrounded: boolean
}

export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type: string }).type === 'local_agent'
  )
}

function updateAgentTask(
  sessionId: string,
  taskId: string,
  updater: (task: LocalAgentTaskState) => LocalAgentTaskState,
): void {
  updateTaskState(sessionId, taskId, task =>
    isLocalAgentTask(task) ? updater(task) : task,
  )
}

/**
 * Register a background agent. Its abort controller is its own: stopping the
 * turn that launched it does not stop the agent.
 */
export function registerAsyncAgent(input: {
  sessionId: string
  description: string
  prompt: string
  agentType: string
  toolUseId?: string
  abortController?: AbortController
}): LocalAgentTaskState {
  const { sessionId, description, prompt, agentType, toolUseId } = input
  setTaskSessionId(sessionId)
  const agentId = generateTaskId('local_agent')
  initTaskOutput(agentId)

  const taskState: LocalAgentTaskState = {
    ...createTaskStateBase(agentId, 'local_agent', description, toolUseId),
    type: 'local_agent',
    status: 'running',
    agentId,
    prompt,
    agentType,
    sessionId,
    abortController: input.abortController ?? new AbortController(),
    isBackgrounded: true,
  }
  registerTask(sessionId, taskState)
  return taskState
}

export function updateAsyncAgentProgress(
  sessionId: string,
  taskId: string,
  progress: AgentProgress,
): void {
  updateAgentTask(sessionId, taskId, task =>
    task.status === 'running' ? { ...task, progress } : task,
  )
}

export function completeAsyncAgent(
  sessionId: string,
  taskId: string,
  result: string,
): void {
  updateAgentTask(sessionId, taskId, task =>
    task.status === 'running'
      ? {
          ...task,
          status: 'completed',
          result,
          endTime: Date.now(),
          abortController: undefined,
        }
      : task,
  )
}

export function failAsyncAgent(
  sessionId: string,
  taskId: string,
  error: string,
): void {
  updateAgentTask(sessionId, taskId, task =>
    task.status === 'running'
      ? {
          ...task,
          status: 'failed',
          error,
          endTime: Date.now(),
          abortController: undefined,
        }
      : task,
  )
}

/** Stop a running agent. Does nothing once it has finished. */
export function killAsyncAgent(
  sessionId: string,
  taskId: string,
  partialResult?: string,
): void {
  updateAgentTask(sessionId, taskId, task => {
    if (task.status !== 'running') {
      // The stop came first and the agent's loop has now unwound: keep what
      // it had written.
      return task.status === 'killed' && partialResult && !task.result
        ? { ...task, result: partialResult }
        : task
    }
    task.abortController?.abort()
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      abortController: undefined,
      ...(partialResult ? { result: partialResult } : {}),
    }
  })
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Tell the main agent a background agent is over. At most once per task: a
 * task already marked as notified is skipped.
 */
export function enqueueAgentNotification(input: {
  sessionId: string
  taskId: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  error?: string
  finalMessage?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  toolUseId?: string
}): void {
  const { sessionId, taskId, description, status, error } = input
  let shouldEnqueue = false
  updateTaskState(sessionId, taskId, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  const summary =
    status === 'completed'
      ? `Agent "${description}" completed`
      : status === 'failed'
        ? `Agent "${description}" failed: ${error || 'Unknown error'}`
        : `Agent "${description}" was stopped`

  const outputPath = getTask(sessionId, taskId)?.outputFile ?? ''
  const toolUseIdLine = input.toolUseId
    ? `\n<tool-use-id>${input.toolUseId}</tool-use-id>`
    : ''
  const resultSection = input.finalMessage
    ? `\n<result>${input.finalMessage}</result>`
    : ''
  const usageSection = input.usage
    ? `\n<usage><total_tokens>${input.usage.totalTokens}</total_tokens><tool_uses>${input.usage.toolUses}</tool_uses><duration_ms>${input.usage.durationMs}</duration_ms></usage>`
    : ''

  const message = `<task-notification>
<task-id>${taskId}</task-id>${toolUseIdLine}
<output-file>${outputPath}</output-file>
<status>${status}</status>
<summary>${escapeXml(summary)}</summary>${resultSection}${usageSection}
</task-notification>`

  enqueuePendingNotification(sessionId, {
    value: message,
    mode: 'task-notification',
  })
}

export const LocalAgentTask: Task = {
  name: 'LocalAgentTask',
  type: 'local_agent',
  kill(taskId, sessionId) {
    killAsyncAgent(sessionId, taskId)
  },
}
