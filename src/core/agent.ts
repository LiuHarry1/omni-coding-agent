import {
  ensureMessageUuid,
  ensureMessageUuids,
} from '../services/session-memory/index.js'
import { getAttachmentMessages } from '../utils/attachments.js'
import { takeQueuedCommands } from '../utils/attachments/queued-commands.js'
import { hasBetweenTurnProcessing } from '../utils/messageQueueManager.js'
import { appendMessage } from '../session/index.js'
import type { AgentOptions, Message } from './types.js'
import { buildUserMessage } from './query/helpers.js'
import { queryEvents } from './query.js'
import type { QueryEvent } from './query/events.js'
import type { QueryResult } from './query/types.js'

/**
 * Ways into the query loop. `runAgentEvents` seeds the user turn and runs
 * the loop; `runAgent` is the same for callers that only want the final text
 * (subagents, forks); `runSessionTurn` also writes every message to the
 * session's transcript, and is what the main conversation uses.
 */
export { query } from './query.js'
export type {
  QueryOptions,
  QueryResult,
  QueryStopReason,
} from './query/types.js'

/**
 * High-level entry: append user message + attachments, then run the unified
 * query loop. Returns final assistant text for backward-compatible callers.
 */
export async function runAgent(
  userMessage: string,
  opts: AgentOptions,
): Promise<string> {
  const turn = runAgentEvents(userMessage, opts)
  let next = await turn.next()
  while (!next.done) {
    if (next.value.type === 'message') opts.onMessage?.(next.value.message)
    next = await turn.next()
  }
  const result = next.value
  // A stop that races the model can surface as `error` with no text; callers
  // that asked for throwOnError still want an AbortError, not a hard failure.
  if (opts.abortSignal?.aborted) {
    const err = new Error('Subagent stopped by user.')
    err.name = 'AbortError'
    throw err
  }
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

/**
 * Seeds the user turn and runs the query loop. The seeded messages are the
 * first `message` events.
 */
export async function* runAgentEvents(
  userMessage: string,
  opts: AgentOptions,
): AsyncGenerator<QueryEvent, QueryResult> {
  const messages = opts.messages ?? []
  const newMessagesFrom = messages.length
  const { toolUseContext } = opts

  for (const leading of opts.leadingMessages ?? []) {
    messages.push(ensureMessageUuid(leading))
  }
  if (toolUseContext) {
    for await (const att of getAttachmentMessages(
      userMessage,
      toolUseContext,
      messages,
    )) {
      messages.push(ensureMessageUuid(att))
    }
    // Background tasks that finished since the last turn. Where a queue
    // processor runs they have had a turn of their own by now.
    if (opts.sessionId && !hasBetweenTurnProcessing()) {
      messages.push(...takeQueuedCommands(opts.sessionId, undefined).messages)
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
  for (const extra of opts.afterUserMessages ?? []) {
    messages.push(extra)
  }
  ensureMessageUuids(messages)

  return yield* queryEvents({ ...opts, runAgent, messages, newMessagesFrom })
}

export interface SessionTurnObserver {
  /**
   * The opening user message and its attachments are in history and about
   * to be written: the place to stamp them.
   */
  onSeeded?: () => void
  /** A message reached the transcript file. */
  onPersisted?: (message: Message) => void
  /** Every loop event, after any message in it was written. */
  onEvent?: (event: QueryEvent) => void
}

/**
 * Runs one turn of a stored session. Each message is appended to the
 * transcript the moment the loop hands it over, so the file never lags the
 * conversation by more than the message in flight.
 */
export async function runSessionTurn(
  sessionId: string,
  userMessage: string,
  opts: AgentOptions,
  observer: SessionTurnObserver = {},
): Promise<QueryResult> {
  const history = opts.messages ?? []
  const turnStart = history.length
  const persisted = new Set<Message>()
  let seeded = false
  const persist = (message: Message) => {
    if (!seeded) {
      seeded = true
      observer.onSeeded?.()
    }
    appendMessage(sessionId, message)
    persisted.add(message)
    observer.onPersisted?.(message)
  }

  const turn = runAgentEvents(userMessage, { ...opts, messages: history })
  try {
    while (true) {
      const next = await turn.next()
      if (next.done) return next.value
      if (next.value.type === 'message') persist(next.value.message)
      observer.onEvent?.(next.value)
    }
  } catch (err) {
    // Seeding can fail before the loop ever runs; keep what it appended.
    for (const message of history.slice(turnStart)) {
      if (!persisted.has(message)) persist(message)
    }
    throw err
  }
}
