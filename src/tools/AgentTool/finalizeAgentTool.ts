/**
 * Result extraction for subagent runs.
 * If the last assistant turn is pure tool_use, walk backward for text
 * so the parent still receives a useful summary.
 */

import type { Message } from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'

/** Empty-output marker shown to the parent when the subagent produced no text. */
export const SUBAGENT_NO_OUTPUT_MARKER =
  '(Subagent completed but returned no output.)'

/**
 * Extract text from assistant message content parts.
 */
export function extractTextFromAssistantContent(
  content: unknown,
  separator = '\n',
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join(separator)
}

/**
 * Walk messages newest→oldest; return the most recent assistant text.
 * Used when the loop exits mid-turn on a tool_use-only assistant message.
 * A reply split by output-limit continuations is returned whole.
 */
export function extractPartialResult(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!isRoleMessage(m) || m.role !== 'assistant') continue
    const text = extractTextFromAssistantContent(m.content, '\n')
    if (text.trim()) return withContinuedPrefix(messages, i, text).trim()
  }
  return undefined
}

/**
 * Prepend the assistant text each `continuation` reminder picked up from.
 * Pieces are concatenated as-is: the cut can fall mid-word or mid-line.
 */
function withContinuedPrefix(
  messages: Message[],
  index: number,
  text: string,
): string {
  let out = text
  let i = index
  for (;;) {
    const r = previousTurnMessage(messages, i)
    const reminder = r >= 0 ? messages[r]! : undefined
    if (
      !reminder ||
      !isRoleMessage(reminder) ||
      reminder.role !== 'user' ||
      reminder.continuation !== 'max_output_tokens'
    ) {
      return out
    }
    const p = previousTurnMessage(messages, r)
    const prev = p >= 0 ? messages[p]! : undefined
    if (!prev || !isRoleMessage(prev) || prev.role !== 'assistant') return out
    out = extractTextFromAssistantContent(prev.content, '\n') + out
    i = p
  }
}

/** Index of the nearest earlier message that isn't an attachment or other meta injection. */
function previousTurnMessage(messages: Message[], from: number): number {
  for (let j = from - 1; j >= 0; j--) {
    const m = messages[j]!
    if (!isRoleMessage(m)) continue
    if (m.role === 'user' && m.isMeta && !m.continuation) continue
    return j
  }
  return -1
}

/**
 * Resolve the string returned to the parent Task tool.
 * Prefer message-history extraction; fall back to loop accumulator;
 * never return empty — use the no-output marker.
 */
export function finalizeSubagentReturn(
  messages: Message[],
  finalText: string,
): string {
  const fromHistory = extractPartialResult(messages)
  const text = (fromHistory ?? finalText).trim()
  return text || SUBAGENT_NO_OUTPUT_MARKER
}
