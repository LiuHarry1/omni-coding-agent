/**
 * Queued commands handed to the model between tool rounds
 * (Claude Code `utils/attachments.ts` getQueuedCommandAttachments and
 * `utils/messages.ts` wrapCommandText).
 */
import { randomUUID } from 'crypto'
import type { AttachmentMessage, Message } from '../../core/types.js'
import { isAttachmentMessage } from '../../core/types.js'
import {
  getQueuedCommandsForLoop,
  hasBetweenTurnProcessing,
  remove as removeFromQueue,
  type MessageOrigin,
  type QueuedCommand,
} from '../messageQueueManager.js'
import type { QueuedCommandAttachment } from './types.js'

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): QueuedCommandAttachment[] {
  return queuedCommands
    .filter(_ => INLINE_NOTIFICATION_MODES.has(_.mode))
    .map(_ => ({
      type: 'queued_command' as const,
      prompt: _.value,
      ...(_.uuid ? { source_uuid: _.uuid } : {}),
      commandMode: _.mode,
      ...(_.origin ? { origin: _.origin } : {}),
      ...(_.isMeta ? { isMeta: true } : {}),
    }))
}

/**
 * Take what a loop may have from the session's queue right now, as
 * attachment messages ready to append to the conversation.
 *
 * Task notifications normally wait for the turn to end, where the queue
 * processor answers them. On a host without one they are taken here too.
 */
export function takeQueuedCommands(
  sessionId: string,
  agentId: string | undefined,
): { commands: QueuedCommand[]; messages: AttachmentMessage[] } {
  const commands = getQueuedCommandsForLoop(
    sessionId,
    agentId,
    hasBetweenTurnProcessing() ? 'next' : 'later',
  )
  const messages = getQueuedCommandAttachments(commands).map(
    (attachment): AttachmentMessage => ({
      type: 'attachment',
      attachment,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      isMeta: true,
    }),
  )
  if (commands.length > 0) removeFromQueue(sessionId, commands)
  return { commands, messages }
}

/**
 * Prefer the explicit origin carried from the queue; fall back to the
 * command mode for task notifications.
 */
export function queuedCommandOrigin(
  attachment: Pick<QueuedCommandAttachment, 'origin' | 'commandMode'>,
): MessageOrigin | undefined {
  return (
    attachment.origin ??
    (attachment.commandMode === 'task-notification'
      ? { kind: 'task-notification' }
      : undefined)
  )
}

/**
 * Only system-generated commands are hidden from the transcript. A message
 * the user typed during the turn has no origin and stays visible.
 */
export function isQueuedCommandFromUser(
  attachment: Pick<
    QueuedCommandAttachment,
    'origin' | 'commandMode' | 'isMeta'
  >,
): boolean {
  const origin = queuedCommandOrigin(attachment)
  return (origin === undefined || origin.kind === 'human') && !attachment.isMeta
}

/** A message the user typed while a turn ran, as it is in the transcript. */
export function isUserQueuedMessage(
  message: Message,
): message is AttachmentMessage & { attachment: QueuedCommandAttachment } {
  return (
    isAttachmentMessage(message) &&
    message.attachment.type === 'queued_command' &&
    isQueuedCommandFromUser(message.attachment)
  )
}

export function wrapCommandText(
  raw: string,
  origin: MessageOrigin | undefined,
): string {
  switch (origin?.kind) {
    case 'task-notification':
      return `A background agent completed a task:\n${raw}`
    case 'coordinator':
      return `The coordinator sent a message while you were working:\n${raw}\n\nAddress this before completing your current task.`
    case 'human':
    case undefined:
    default:
      return `The user sent a new message while you were working:\n${raw}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`
  }
}
