import { tool } from 'ai'
import { z } from 'zod'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { CRON_CREATE_TOOL_NAME } from '../../constants/tool_names.js'
// Import the leaf module: the cron barrel also exports the scheduler, whose
// fire path imports run-chat-turn -> tools.ts and creates an ESM cycle here.
import { scheduleCronTask } from '../../services/cron/schedule.js'
import { resolveWorkspaceContext } from '../../services/cloud-workspaces/turn-scope.js'
import { CRON_CREATE_DESCRIPTION, CRON_CREATE_PROMPT } from './prompt.js'

export const CronCreateOutputSchema = z.object({
  id: z.string(),
  humanSchedule: z.string(),
  recurring: z.boolean(),
  nextRunAtMs: z.number(),
  message: z.string(),
})

export type CronCreateOutput = z.infer<typeof CronCreateOutputSchema>

export const definition: ToolDefinition = {
  name: CRON_CREATE_TOOL_NAME,
  description: CRON_CREATE_DESCRIPTION,
  shouldDefer: true,
  isConcurrencySafe: () => false,
  outputSchema: CronCreateOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as CronCreateOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(cwd, context) {
    return tool({
      description: CRON_CREATE_PROMPT,
      inputSchema: z
        .object({
          cron: z
            .string()
            .optional()
            .describe(
              '5-field cron in local time: "M H DoM Mon DoW". Example: "*/5 * * * *" every 5 minutes.',
            ),
          at: z
            .string()
            .optional()
            .describe(
              'One-shot time: ISO-8601 or epoch milliseconds. Use instead of cron.',
            ),
          prompt: z
            .string()
            .describe('User message to run when the schedule fires.'),
          recurring: z
            .boolean()
            .optional()
            .describe(
              'true (default) = repeat until deleted or 7 days. false = fire once.',
            ),
        })
        .refine(
          data => Boolean(data.cron?.trim()) !== Boolean(data.at?.trim()),
          {
            message: 'Provide exactly one of cron or at.',
          },
        ),
      execute: async ({ cron, at, prompt, recurring }) => {
        const session = context.session
        if (!session?.id) {
          throw new Error('CronCreate requires an active session')
        }
        const workspaceContext = resolveWorkspaceContext(session.workspace, cwd)

        const result = scheduleCronTask({
          cwd: workspaceContext.cwd,
          settingsCwd: workspaceContext.settingsCwd,
          sessionId: session.id,
          prompt,
          cron,
          at,
          recurring,
          workspace: session.workspace,
          environmentId: session.workspace?.environmentId,
        })

        if (!result.ok) {
          throw new Error(result.message)
        }

        const data: CronCreateOutput = {
          id: result.task.id,
          humanSchedule: result.humanSchedule,
          recurring: result.task.recurring,
          nextRunAtMs: result.task.nextRunAtMs,
          message: result.task.recurring
            ? `Scheduled recurring job ${result.task.id} (${result.humanSchedule}). Next run ${new Date(result.task.nextRunAtMs).toISOString()}. Auto-expires after 7 days. Use CronDelete to cancel.`
            : `Scheduled one-shot ${result.task.id} (${result.humanSchedule}). It fires once then auto-deletes.`,
        }
        return { data } satisfies DualChannelToolResult<CronCreateOutput>
      },
    })
  },
}
