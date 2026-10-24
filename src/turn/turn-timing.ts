/**
 * Turn span on the message that opened the turn, so the web UI's
 * "Worked for …" survives a reload.
 */
import type { Message, UserMessage } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'

/**
 * `messages` is what the turn has not persisted yet. runAgent puts meta
 * preludes ahead of the message built from the turn input; once the model
 * has replied, a mid-turn compaction may already have persisted it.
 */
function findTurnMessage(
  messages: Message[],
  isMeta: boolean,
): UserMessage | undefined {
  for (const m of messages) {
    if (!isRoleMessage(m)) continue
    if (m.role !== 'user') return undefined
    if (!!m.isMeta === isMeta) return m
  }
  return undefined
}

export function stampTurnTiming(
  messages: Message[],
  opts: { isMeta: boolean; startTime: number; endTime: number },
): void {
  const message = findTurnMessage(messages, opts.isMeta)
  if (!message) return
  message.turnStartTime = opts.startTime
  message.turnEndTime = opts.endTime
}
