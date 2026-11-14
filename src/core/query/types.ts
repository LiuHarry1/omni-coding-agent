import type { AgentOptions, Message } from '../types.js'
import type { QueryDeps } from './deps.js'
import type { Continue, Terminal } from './transitions.js'

/** Reason the query loop stopped, as callers outside the loop see it. */
export type QueryStopReason = 'completed' | 'aborted' | 'max_steps' | 'error'

export type QueryResult = {
  finalText: string
  messages: Message[]
  reason: QueryStopReason
  /** The exit the loop took; `reason` is derived from it. */
  terminal: Terminal
  /** Every continuation the loop took, in order. */
  transitions: Continue[]
}

/**
 * Options for `query()` — same as AgentOptions with messages already seeded
 * (user message / attachments appended by the caller when needed).
 */
export type QueryOptions = AgentOptions & {
  messages: Message[]
  /** Loop phases; defaults to the real ones. */
  deps?: QueryDeps
}
