/**
 * ExitPlanMode — end plan mode and request user approval before execution.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { DualChannelToolResult, ToolDefinition } from '../../core/types.js'
import { emitModeChanged, emitPlanReady } from '../../core/wire-internal.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../constants/tool_names.js'
import {
  handlePlanModeTransition,
  transitionPermissionMode,
} from '../../utils/permissions/permission-mode.js'
import { registerPlanApproval } from '../../core/brokers/plan-approval-broker.js'
import {
  getPlan,
  getPlanFilePath,
  planExists,
  writePlan,
} from '../../utils/plans.js'
import { buildPlanApprovedFollowUps } from '../../utils/attachments/plan-mode.js'

export type ExitPlanModeOutput = {
  message: string
  approved?: boolean
  filePath?: string
}

export const ExitPlanModeOutputSchema = z.object({
  message: z.string(),
  approved: z.boolean().optional(),
  filePath: z.string().optional(),
})

const DESCRIPTION =
  'Exit plan mode and submit the plan for user approval before implementation.'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function approvedToolResult(plan: string, filePath: string): string {
  return [
    'User has approved your plan. You can now start coding.',
    'Start with updating your todo list if applicable, then implement Phase 1 immediately using Write/Edit/Bash.',
    'Do NOT end your turn with only text — make at least one code change before stopping.',
    '',
    `Your plan has been saved to: ${filePath}`,
    '',
    '## Approved Plan:',
    plan,
  ].join('\n')
}

export const definition: ToolDefinition = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: DESCRIPTION,
  isConcurrencySafe: () => false,
  outputSchema: ExitPlanModeOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as ExitPlanModeOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },
  create(_cwd, context) {
    return tool({
      description: `${DESCRIPTION}

Call when your plan is complete and ready for review. The user will approve or reject before you can execute changes.
Read the plan from the plan file — do not pass the plan as a parameter.`,
      inputSchema: z.strictObject({}),
      execute: async (): Promise<
        DualChannelToolResult<ExitPlanModeOutput> | string
      > => {
        const session = context.session
        const cwd = context.cwd
        if (!session || !cwd) {
          return 'Error: missing session context for ExitPlanMode.'
        }

        if (session.permissionMode.mode !== 'plan') {
          return 'Error: ExitPlanMode is only available in plan mode.'
        }

        let plan = getPlan(session, cwd)
        const filePath = getPlanFilePath(session, cwd)

        if (!plan?.trim()) {
          return (
            'Error: No plan written yet. Write the plan to the plan file first, ' +
            `then call ${EXIT_PLAN_MODE_TOOL_NAME} again.`
          )
        }

        const requestId = randomUUID()

        context.wire.planApprovalRequest(requestId, plan)

        const approval = await registerPlanApproval(
          requestId,
          DEFAULT_TIMEOUT_MS,
        )

        if (!approval.approved) {
          const reason = approval.reason ?? 'rejected'
          const message = [
            `Plan not approved (${reason}).`,
            'Stay in plan mode: revise the plan file based on user feedback, then call ExitPlanMode again.',
            '',
            `Current plan file: ${filePath}`,
          ].join('\n')
          return {
            data: {
              message,
              approved: false,
              filePath,
            },
          } satisfies DualChannelToolResult<ExitPlanModeOutput>
        }

        if (approval.editedPlan?.trim()) {
          plan = approval.editedPlan
          writePlan(session, cwd, plan)
        }

        const targetMode = approval.targetMode ?? 'agent'
        handlePlanModeTransition('plan', targetMode, session)
        // Follow-ups are injected via tool result; skip duplicate exit attachment on mode_changed.
        session.needsPlanModeExitAttachment = false
        session.permissionMode = transitionPermissionMode(
          'plan',
          targetMode,
          session.permissionMode,
        )

        emitPlanReady(context.wire, context.eventBus, {
          plan,
          filePath,
          approved: true,
        })
        emitModeChanged(context.wire, context.eventBus, targetMode)

        return {
          data: {
            message: approvedToolResult(plan, filePath),
            approved: true,
            filePath,
          },
          newMessages: buildPlanApprovedFollowUps(
            filePath,
            planExists(session, cwd),
          ),
        } satisfies DualChannelToolResult<ExitPlanModeOutput>
      },
    })
  },
}
