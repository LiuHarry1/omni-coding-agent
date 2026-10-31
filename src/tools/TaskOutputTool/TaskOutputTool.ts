/**
 * TaskOutput — retrieve output from a background shell task.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolContext,
} from '../../core/types.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../constants/tool_names.js'
import { getTask, markTaskNotified } from '../../utils/task/framework.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { getTaskOutput } from '../../utils/task/diskOutput.js'
import { formatTaskOutput } from '../../utils/task/outputFormatting.js'
import { setTaskSessionId } from '../../utils/task/diskOutput.js'

export type TaskOutputToolResult = {
  text: string
  task_id: string
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  /** Raw shell output for UI (no XML envelope). */
  output: string
  task_status?: string
}

export const TaskOutputToolResultSchema = z.object({
  text: z.string(),
  task_id: z.string(),
  retrieval_status: z.enum(['success', 'timeout', 'not_ready']),
  output: z.string(),
  task_status: z.string().optional(),
})

const DESCRIPTION = `DEPRECATED: Prefer using the Read tool on the task's output file path instead. Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes — Read that file directly (session task output paths are allowed even when outside the project cwd).

- Retrieves output from a running or completed background shell task
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion — never for long-lived processes (dev servers, watchers)
- Use block=false for a non-blocking check of current status / startup logs
- If waiting for a background task you started with run_in_background, you will be notified when it completes — do not poll`

async function waitForTaskCompletion(
  sessionId: string,
  taskId: string,
  timeoutMs: number,
): Promise<'success' | 'timeout' | 'not_ready'> {
  const start = Date.now()
  for (;;) {
    const task = getTask(sessionId, taskId)
    if (!task) return 'not_ready'
    if (isTerminalTaskStatus(task.status)) return 'success'
    if (Date.now() - start >= timeoutMs) return 'timeout'
    await new Promise(r => setTimeout(r, 100))
  }
}

export const definition: ToolDefinition = {
  name: TASK_OUTPUT_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => true,
  outputSchema: TaskOutputToolResultSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as TaskOutputToolResult
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.text,
      ...(o.task_status === 'unknown' ? { is_error: true } : {}),
    }
  },
  create(_cwd: string, context: ToolContext) {
    return tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        task_id: z.string().describe('The task ID to get output from'),
        block: z
          .boolean()
          .optional()
          .describe('Whether to wait for completion'),
        timeout: z
          .number()
          .min(0)
          .max(600_000)
          .optional()
          .describe('Max wait time in ms'),
      }),
      execute: async (args: {
        task_id: string
        block?: boolean
        timeout?: number
      }): Promise<DualChannelToolResult<TaskOutputToolResult> | string> => {
        const sessionId = context.sessionId ?? 'default'
        setTaskSessionId(sessionId)
        const taskId = args.task_id
        const block = args.block !== false
        const timeoutMs = args.timeout ?? 30_000

        const task = getTask(sessionId, taskId)
        if (!task || !isLocalShellTask(task)) {
          return `Error: no background task with id ${taskId}`
        }

        let retrieval_status: 'success' | 'timeout' | 'not_ready' = 'success'
        if (block && !isTerminalTaskStatus(task.status)) {
          retrieval_status = await waitForTaskCompletion(
            sessionId,
            taskId,
            timeoutMs,
          )
        } else if (!isTerminalTaskStatus(task.status)) {
          retrieval_status = 'not_ready'
        }

        if (retrieval_status === 'success') {
          markTaskNotified(sessionId, taskId)
        }

        const raw = getTaskOutput(taskId)
        const { content } = formatTaskOutput(raw || '(no output yet)', taskId)
        const taskStatus = getTask(sessionId, taskId)?.status ?? 'unknown'
        const statusLine = `<retrieval_status>${retrieval_status}</retrieval_status>\n<task_id>${taskId}</task_id>\n<status>${taskStatus}</status>\n`
        const text = `${statusLine}<output>\n${content}\n</output>`

        return {
          data: {
            text,
            task_id: taskId,
            retrieval_status,
            output: content,
            task_status: String(taskStatus),
          },
        }
      },
    })
  },
}
