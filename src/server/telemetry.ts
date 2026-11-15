/**
 * Usage telemetry reporter (server layer).
 *
 * Subscribes to the agent's `usage` events (emitted by `logStepCompletion` in
 * core/agent.ts) and ships them to the standalone analytics backend
 * (../../analytics) over HTTP. Design constraints:
 *
 *   - Fire-and-forget + batched: never blocks or fails a chat turn.
 *   - Identity lives HERE, not in core: we attach the session's owner email.
 *   - Fully opt-in: with no `ANALYTICS_URL` set, this is a no-op.
 *
 * Env:
 *   ANALYTICS_URL              e.g. http://analytics:8200 (unset → disabled)
 *   ANALYTICS_INGEST_API_KEY   shared secret sent as X-API-Key (optional)
 *   ANALYTICS_FLUSH_MS         batch flush interval (default 5000)
 *   ANALYTICS_DEBUG            "true" to log flush / HTTP failures (default off)
 */
import type { IEventBus } from '../core/types.js'

interface UsageEvent {
  step: number
  sessionId?: string
  model?: string
  provider?: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  latencyMs?: number
  ttfbMs?: number
  toolCalls: number
}

interface UsageReport {
  event_id?: string
  ts?: string
  user_email?: string
  session_id?: string
  turn_index?: number
  model?: string
  provider?: string
  source?: string
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  reasoning_tokens?: number
  total_tokens?: number
  latency_ms?: number
  ttfb_ms?: number
  tool_calls?: number
}

interface EventReport {
  event_id?: string
  ts?: string
  type: string
  user_email?: string
  session_id?: string
  payload?: Record<string, unknown>
}

/** Analytics event type for one user chat POST. */
export const USER_QUESTION_EVENT = 'chat.user_message'

const ENDPOINT = (process.env.ANALYTICS_URL ?? '').trim().replace(/\/+$/, '')
const API_KEY = process.env.ANALYTICS_INGEST_API_KEY ?? ''
const FLUSH_MS = (() => {
  const n = parseInt(process.env.ANALYTICS_FLUSH_MS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 5000
})()
const MAX_BATCH = 200
const DEBUG =
  String(process.env.ANALYTICS_DEBUG ?? '')
    .trim()
    .toLowerCase() === 'true'

export function isTelemetryEnabled(): boolean {
  return ENDPOINT.length > 0
}

function debugWarn(message: string): void {
  if (DEBUG) console.warn(message)
}

// Module-level queues shared across requests; one flush timer.
const usageQueue: UsageReport[] = []
const eventQueue: EventReport[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (!isTelemetryEnabled()) return
  const pending = usageQueue.length + eventQueue.length
  if (pending >= MAX_BATCH) {
    void flushUsage()
  } else if (!timer) {
    timer = setTimeout(() => void flushUsage(), FLUSH_MS)
  }
}

async function postIngest(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    debugWarn(`[telemetry] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
}

export async function flushUsage(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  // Unset / blank ANALYTICS_URL → telemetry off; never fetch or warn.
  if (!isTelemetryEnabled()) {
    usageQueue.length = 0
    eventQueue.length = 0
    return
  }

  const records = usageQueue.splice(0, usageQueue.length)
  const events = eventQueue.splice(0, eventQueue.length)
  if (records.length === 0 && events.length === 0) return

  try {
    if (records.length > 0) {
      await postIngest('/v1/usage', { records })
    }
    if (events.length > 0) {
      await postIngest('/v1/events', { events })
    }
  } catch (err) {
    // Fire-and-forget: drop on failure. Opt into noise with ANALYTICS_DEBUG=true.
    debugWarn(`[telemetry] flush failed: ${(err as Error).message}`)
  }
}

/**
 * Record one user chat message (question). Called once per POST /chat.
 * Idempotent on session_id + message index.
 */
export function reportUserQuestion(
  ctx: TelemetryContext,
  messageIndex: number,
  preview?: string,
): void {
  if (!isTelemetryEnabled()) return
  eventQueue.push({
    event_id: `${ctx.sessionId}:q:${messageIndex}`,
    ts: new Date().toISOString(),
    type: USER_QUESTION_EVENT,
    user_email: ctx.userEmail,
    session_id: ctx.sessionId,
    payload: preview ? { preview: preview.slice(0, 200) } : {},
  })
  scheduleFlush()
}

export interface TelemetryContext {
  sessionId: string
  userEmail?: string
}

/**
 * Subscribe a chat run's eventBus to usage telemetry. Returns an unsubscribe
 * function; call it (and optionally `flushUsage`) when the turn ends. No-op
 * when telemetry is disabled.
 */
export function attachUsageTelemetry(
  eventBus: IEventBus,
  ctx: TelemetryContext,
): () => void {
  if (!isTelemetryEnabled()) return () => {}

  return eventBus.on('usage', data => {
    const e = data as UsageEvent
    usageQueue.push({
      event_id: ctx.sessionId ? `${ctx.sessionId}:${e.step}` : undefined,
      ts: new Date().toISOString(),
      user_email: ctx.userEmail,
      session_id: ctx.sessionId,
      turn_index: e.step,
      model: e.model,
      provider: e.provider,
      source: 'agent',
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      cached_input_tokens: e.cachedInputTokens,
      reasoning_tokens: e.reasoningTokens,
      total_tokens: e.totalTokens,
      latency_ms: e.latencyMs,
      ttfb_ms: e.ttfbMs,
      tool_calls: e.toolCalls,
    })
    scheduleFlush()
  })
}
