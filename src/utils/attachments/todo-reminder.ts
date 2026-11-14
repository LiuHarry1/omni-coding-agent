/**
 * Remind the model about the todo tool when it has gone unused for a while.
 */
import {
  isAttachmentMessage,
  isRoleMessage,
  type Message,
  type ToolUseContext,
} from '../../core/types.js'
import { TODO_WRITE_TOOL_NAME } from '../../constants/tool_names.js'
import type { Attachment } from './types.js'

export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

/**
 * Assistant turns since the last TodoWrite call and since the last reminder.
 * A turn that carries only reasoning is not counted.
 */
export function getTodoReminderTurnCounts(messages: readonly Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let foundTodoWrite = false
  let foundReminder = false
  let turnsSinceLastTodoWrite = 0
  let turnsSinceLastReminder = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!

    if (isRoleMessage(message) && message.role === 'assistant') {
      if (message.content.every(part => part.type === 'reasoning')) continue

      // Checked before counting, so the turn that wrote the list is not
      // itself "one turn since the write".
      if (
        !foundTodoWrite &&
        message.content.some(
          part =>
            part.type === 'tool-call' && part.toolName === TODO_WRITE_TOOL_NAME,
        )
      ) {
        foundTodoWrite = true
      }

      if (!foundTodoWrite) turnsSinceLastTodoWrite++
      if (!foundReminder) turnsSinceLastReminder++
    } else if (
      !foundReminder &&
      isAttachmentMessage(message) &&
      message.attachment.type === 'todo_reminder'
    ) {
      foundReminder = true
    }

    if (foundTodoWrite && foundReminder) break
  }

  return { turnsSinceLastTodoWrite, turnsSinceLastReminder }
}

export function getTodoReminderAttachments(
  messages: readonly Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (!(TODO_WRITE_TOOL_NAME in toolUseContext.options.tools)) return []
  if (!messages || messages.length === 0) return []

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)
  if (
    turnsSinceLastTodoWrite < TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE ||
    turnsSinceLastReminder < TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    return []
  }

  const todos = toolUseContext.session.todos ?? []
  return [
    {
      type: 'todo_reminder',
      content: todos.map(({ content, status }) => ({ content, status })),
      itemCount: todos.length,
    },
  ]
}
