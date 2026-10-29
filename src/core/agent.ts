import {
  ensureMessageUuid,
  ensureMessageUuids,
} from '../services/session-memory/index.js'
import { getAttachmentMessages } from '../utils/attachments.js'
import type { AgentOptions } from './types.js'
import { buildUserMessage } from './query/helpers.js'
import { query } from './query.js'

export { query } from './query.js'
export type {
  QueryOptions,
  QueryResult,
  QueryStopReason,
} from './query/types.js'

/**
 * High-level entry: append user message + attachments, then run the unified
 * `query()` loop. Returns final assistant text for backward-compatible callers.
 */
export async function runAgent(
  userMessage: string,
  opts: AgentOptions,
): Promise<string> {
  const messages = opts.messages ?? []
  const { toolUseContext } = opts

  if (toolUseContext) {
    for await (const att of getAttachmentMessages(
      userMessage,
      toolUseContext,
      messages,
    )) {
      messages.push(ensureMessageUuid(att))
    }
  }
  for (const prelude of opts.attachmentPrelude ?? []) {
    messages.push(ensureMessageUuid(prelude))
  }
  messages.push(
    buildUserMessage(
      userMessage,
      opts.images,
      opts.isMeta,
      opts.attachmentFiles,
      opts.displayUserMessage,
    ),
  )
  ensureMessageUuids(messages)

  const result = await query({ ...opts, runAgent, messages })
  if (opts.throwOnError && result.reason === 'error') {
    const detail = result.finalText.trim()
    throw new Error(
      detail
        ? `Agent query failed: ${detail}`
        : 'Agent query failed before producing a final response.',
    )
  }
  return result.finalText
}
