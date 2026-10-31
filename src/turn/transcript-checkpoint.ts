import type { Message } from '../core/types.js'
import { appendMessage } from '../session/index.js'

/** Append every message after a durable cursor and return the next cursor. */
export function persistMessagesFromCursor(
  sessionId: string,
  messages: readonly Message[],
  persistFrom: number,
): number {
  for (const message of messages.slice(persistFrom)) {
    appendMessage(sessionId, message)
  }
  return messages.length
}

/**
 * Persist pending pre-compaction messages followed by the new append-only
 * compaction rows. The returned cursor prevents the normal checkpoint path
 * from writing either segment again.
 */
export function persistFullCompactionFromCursor(
  sessionId: string,
  messages: readonly Message[],
  persistFrom: number,
  compactedMessages: readonly Message[],
): number {
  const compactStart = messages.length - compactedMessages.length
  for (const message of messages.slice(persistFrom, compactStart)) {
    appendMessage(sessionId, message)
  }
  for (const message of compactedMessages) {
    appendMessage(sessionId, message)
  }
  return messages.length
}
