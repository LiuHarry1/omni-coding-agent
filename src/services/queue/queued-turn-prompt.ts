/**
 * Text of a turn the server starts for queued commands, kept out of
 * `queue-processor.ts` so the session UI projection can recognise such a
 * turn without pulling in the turn runtime.
 */
import type { QueuedCommand } from '../../utils/messageQueueManager.js'

const TASK_NOTIFICATION_OPEN = '<task-notification>'

/** The turn's prompt: each queued command as its own block. */
export function queuedTurnPrompt(commands: QueuedCommand[]): string {
  return commands.map(command => command.value).join('\n\n')
}

/** True for the stored opening message of a task-notification turn. */
export function isTaskNotificationText(text: string): boolean {
  return text.trimStart().startsWith(TASK_NOTIFICATION_OPEN)
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** The text inside each `<summary>` of the notifications, unescaped. */
export function notificationSummariesOf(text: string): string[] {
  return [...text.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(match =>
    unescapeXml(match[1]!).trim(),
  )
}

/** One display line per notification in the batch. */
export function notificationSummaries(commands: QueuedCommand[]): string[] {
  return commands.flatMap(command => {
    const summaries = notificationSummariesOf(command.value)
    return summaries.length > 0 ? summaries : ['Background task update']
  })
}
