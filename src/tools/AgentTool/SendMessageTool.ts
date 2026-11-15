/**
 * SendMessage — continue a subagent that has finished, with its full context.
 * The Agent tool does the work; this reads which agent type to run back from
 * the subagent's transcript.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext, ToolDefinition } from '../../core/types.js'
import {
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { getTask } from '../../utils/task/framework.js'
import { readSidechain } from '../../session/sidechain.js'

const DESCRIPTION = `Send a follow-up message to a subagent that has finished, continuing it with everything it saw and did before.

- \`to\` is the agentId from the subagent's result (or from its launch message when it ran in the background).
- The agent runs in the foreground and returns its new report, like the ${AGENT_TOOL_NAME} tool.
- Use this instead of launching a new agent when the follow-up builds on the earlier agent's work.
- An agent still running in the background cannot receive messages; wait for its completion notification.`

type ExecuteOptions = { toolCallId?: string; abortSignal?: AbortSignal }
type AgentExecute = (input: unknown, options?: ExecuteOptions) => unknown

export function createSendMessageTool(): ToolDefinition {
  return {
    name: SEND_MESSAGE_TOOL_NAME,
    description: DESCRIPTION,
    isSubagent: true,
    isConcurrencySafe: () => false,
    outputSchema: z.object({ text: z.string() }).passthrough(),
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const text = (output as { text: string }).text
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: text,
        ...(text.startsWith('Error:') ? { is_error: true } : {}),
      }
    },
    create(cwd: string, context: ToolContext) {
      return tool({
        description: DESCRIPTION,
        inputSchema: z.object({
          to: z.string().min(1).describe('agentId of the subagent to continue'),
          message: z
            .string()
            .min(1)
            .describe('The follow-up instruction or question for the agent'),
        }),
        execute: async (
          { to, message }: { to: string; message: string },
          options?: ExecuteOptions,
        ) => {
          const sessionId = context.sessionId
          if (!sessionId) return 'Error: SendMessage needs a session.'
          const task = getTask(sessionId, to)
          if (task && !isTerminalTaskStatus(task.status)) {
            return `Error: agent '${to}' is still running; wait for its completion notification.`
          }
          const prior = readSidechain(sessionId, to)
          if (!prior) {
            return `Error: no transcript for agent '${to}'; it cannot be continued.`
          }
          const agent = context.registry
            ?.get(AGENT_TOOL_NAME)
            ?.create(cwd, context) as { execute?: AgentExecute } | undefined
          if (!agent?.execute) {
            return `Error: the ${AGENT_TOOL_NAME} tool is not available.`
          }
          return agent.execute(
            {
              subagent_type: prior.meta.agentType,
              description: prior.meta.description,
              prompt: message,
              resume: to,
            },
            options,
          )
        },
      })
    },
  }
}
