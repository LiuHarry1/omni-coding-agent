import type { SystemNotice } from '../../../protocol/src/server.js'
import type { IEventBus, Message } from '../types.js'

export type { SystemNotice }

/** Per-request token usage, as reported by the provider. */
export interface StepUsage {
  step: number
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

export type QueryEvent =
  /** Appended to the conversation; consumers persist these in order. */
  | { type: 'message'; message: Message }
  /**
   * A summarizing compaction appended these rows. They also arrive as
   * `message` events right after this one.
   */
  | { type: 'compaction'; messages: readonly Message[] }
  | { type: 'notice'; notice: SystemNotice }
  | { type: 'usage'; usage: StepUsage }

/** Maps loop-internal bus events to notices; undefined for everything else. */
export function noticeFromBusEvent(
  event: string,
  data: unknown,
): SystemNotice | undefined {
  const d = (data ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (event) {
    case 'transient_retry':
      return {
        kind: 'retry',
        attempt: num(d.attempt),
        max_attempts: num(d.max),
        delay_ms: num(d.backoffMs),
        error: str(d.error),
      }
    case 'model_fallback':
      return {
        kind: 'model_fallback',
        from: str(d.originalModel),
        to: str(d.fallbackModel),
      }
    case 'compaction_warning':
      return {
        kind: 'context_warning',
        percent_left: num(d.percentLeft),
        current_tokens: num(d.currentTokens),
      }
    case 'compaction_error':
      return { kind: 'compaction_error', error: str(d.error) }
    default:
      return undefined
  }
}

/** `bus`, with every emit also handed to `tap` first. */
export function tapEventBus(
  bus: IEventBus,
  tap: (event: string, data: unknown) => void,
): IEventBus {
  return {
    on: (event, handler) => bus.on(event, handler),
    off: (event, handler) => bus.off(event, handler),
    emit(event, data) {
      tap(event, data)
      bus.emit(event, data)
    },
    scoped: prefix => bus.scoped(prefix),
    removeAllListeners: () => bus.removeAllListeners(),
  }
}

/** The usage event `runStep` reports on the bus, as a {@link StepUsage}. */
export function usageFromBusEvent(data: unknown): StepUsage {
  const d = (data ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    step: num(d.step),
    model: typeof d.model === 'string' ? d.model : '',
    inputTokens: num(d.inputTokens),
    outputTokens: num(d.outputTokens),
    cachedInputTokens: num(d.cachedInputTokens),
    cacheWriteTokens: num(d.cacheWriteTokens),
    reasoningTokens: num(d.reasoningTokens),
    totalTokens: num(d.totalTokens),
  }
}
