/**
 * Plan mode attachments.
 */
import type { Message, ToolUseContext, UserMessage } from '../../core/types.js'
import { isAttachmentMessage } from '../../core/types.js'
import type { Attachment } from './types.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../constants/tool_names.js'
import { getPlanFilePath, planExists } from '../plans.js'
import { isSystemReminderContent } from '../system-reminder.js'

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

function isHumanUserTurn(message: Message): boolean {
  if (isAttachmentMessage(message)) return false
  if (message.role !== 'user') return false
  if (message.isMeta) return false
  const content =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('')
  return content.length > 0 && !isSystemReminderContent(content)
}

/**
 * Human turns since the latest reminder of a mode. A reminder from before
 * the mode was last left does not count: re-entering needs a fresh one.
 */
function getModeReminderTurnCount(
  messages: Message[],
  reminderTypes: ReadonlyArray<Attachment['type']>,
  exitType: Attachment['type'],
): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue

    if (isHumanUserTurn(message)) {
      turnsSinceLastAttachment++
    } else if (isAttachmentMessage(message)) {
      if (message.attachment.type === exitType) break
      if (reminderTypes.includes(message.attachment.type)) {
        return {
          turnCount: turnsSinceLastAttachment,
          foundPlanModeAttachment: true,
        }
      }
    }
  }

  return {
    turnCount: turnsSinceLastAttachment,
    foundPlanModeAttachment: false,
  }
}

function needsModeReminder(
  messages: Message[] | undefined,
  reminderTypes: ReadonlyArray<Attachment['type']>,
  exitType: Attachment['type'],
): boolean {
  if (!messages || messages.length === 0) return true
  const { turnCount, foundPlanModeAttachment } = getModeReminderTurnCount(
    messages,
    reminderTypes,
    exitType,
  )
  return (
    !foundPlanModeAttachment ||
    turnCount >= PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  )
}

function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isAttachmentMessage(message)) continue
    if (message.attachment.type === 'plan_mode_exit') break
    if (message.attachment.type === 'plan_mode') count++
  }
  return count
}

export function getPlanModeAttachments(
  messages: Message[] | undefined,
  ctx: ToolUseContext,
): Attachment[] {
  const mode = ctx.session.permissionMode.mode
  if (mode !== 'plan') return []
  if (
    !needsModeReminder(
      messages,
      ['plan_mode', 'plan_mode_reentry'],
      'plan_mode_exit',
    )
  ) {
    return []
  }

  const planFilePath = getPlanFilePath(ctx.session, ctx.cwd)
  const exists = planExists(ctx.session, ctx.cwd)
  const attachments: Attachment[] = []

  if (ctx.session.hasExitedPlanMode && exists) {
    ctx.session.hasExitedPlanMode = false
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
  }

  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  attachments.push({
    type: 'plan_mode',
    reminderType,
    planFilePath,
    planExists: exists,
  })

  return attachments
}

export function getPlanModeExitAttachment(ctx: ToolUseContext): Attachment[] {
  if (!ctx.session.needsPlanModeExitAttachment) return []
  if (ctx.session.permissionMode.mode === 'plan') {
    ctx.session.needsPlanModeExitAttachment = false
    return []
  }

  ctx.session.needsPlanModeExitAttachment = false
  const planFilePath = getPlanFilePath(ctx.session, ctx.cwd)
  return [
    {
      type: 'plan_mode_exit',
      planFilePath,
      planExists: planExists(ctx.session, ctx.cwd),
    },
  ]
}

/** Ask-mode rules while ask mode is active, at the plan-mode cadence. */
export function getAskModeAttachments(
  messages: Message[] | undefined,
  ctx: ToolUseContext,
): Attachment[] {
  if (ctx.session.permissionMode.mode !== 'ask') return []
  return needsModeReminder(messages, ['ask_mode'], 'ask_mode_exit')
    ? [{ type: 'ask_mode' }]
    : []
}

/** Says ask mode is over once the mode changed after an ask-mode reminder. */
export function getAskModeExitAttachment(
  messages: Message[] | undefined,
  ctx: ToolUseContext,
): Attachment[] {
  if (ctx.session.permissionMode.mode === 'ask' || !messages) return []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || !isAttachmentMessage(message)) continue
    if (message.attachment.type === 'ask_mode_exit') return []
    if (message.attachment.type === 'ask_mode') {
      return [{ type: 'ask_mode_exit' }]
    }
  }
  return []
}

function attachmentToMessage(text: string): UserMessage {
  return { role: 'user', content: text, isMeta: true }
}

/** Follow-up messages injected after ExitPlanMode approval (after tool result). */
export function buildPlanApprovedFollowUps(
  planFilePath: string,
  exists: boolean,
): Message[] {
  const planReference = exists
    ? ` The plan file is located at ${planFilePath} if you need to reference it.`
    : ''
  return [
    attachmentToMessage(`<system-reminder>
## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}
</system-reminder>`),
    attachmentToMessage(`<system-reminder>
## Plan Approved — Begin Implementation Now

The user clicked **Build** and approved your plan. You are in Agent mode with full tool access.

**Required in this turn:**
1. Call ${TODO_WRITE_TOOL_NAME} if the plan has multiple phases or steps.
2. Start implementing Phase 1 immediately — use ${WRITE_FILE_TOOL_NAME}, ${EDIT_FILE_TOOL_NAME}, and ${BASH_TOOL_NAME} to make real code changes.
3. Do NOT end your turn with only text. You must call at least one mutating tool before stopping.

Approved plan file: ${planFilePath}
</system-reminder>`),
  ]
}
