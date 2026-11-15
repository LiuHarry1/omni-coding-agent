/**
 * EnterPlanMode — model-initiated transition to plan mode.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { emitModeChanged } from '../../core/wire-internal.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../../constants/tool_names.js'
import {
  handlePlanModeTransition,
  prepareContextForPlanMode,
} from '../../utils/permissions/permission-mode.js'

export type EnterPlanModeOutput = { message: string }

export const EnterPlanModeOutputSchema = z.object({
  message: z.string(),
})

const DESCRIPTION =
  'Request to enter plan mode for designing an implementation before making changes.'

export const definition: ToolDefinition = {
  name: ENTER_PLAN_MODE_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => true,
  outputSchema: EnterPlanModeOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: (output as EnterPlanModeOutput).message,
    }
  },
  create(_cwd, context) {
    return tool({
      description: `${DESCRIPTION}

Use when the task is complex, ambiguous, or risky and you need to explore and design before executing.
Do NOT use for simple, obvious tasks — execute directly instead.`,
      inputSchema: z.strictObject({}),
      execute: async (): Promise<
        DualChannelToolResult<EnterPlanModeOutput>
      > => {
        const session = context.session
        if (!session) {
          return {
            data: { message: 'EnterPlanMode requires an active session.' },
          }
        }

        const from = session.permissionMode.mode
        if (from === 'plan') {
          return { data: { message: 'Already in plan mode.' } }
        }

        handlePlanModeTransition(from, 'plan', session)
        session.permissionMode = prepareContextForPlanMode(
          session.permissionMode,
        )

        emitModeChanged(context.wire, context.eventBus, 'plan')

        return {
          data: {
            message:
              'Entered plan mode. Follow the 5-phase workflow: Explore agents → Plan agents → Review/Ask → write plan file → ExitPlanMode for approval.',
          },
        }
      },
    })
  },
}
