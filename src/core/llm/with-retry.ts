import { isTransientStreamError } from '../stream-errors.js'

/** Retries of one model request before its error is reported. */
export const MAX_REQUEST_RETRIES = 10
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 32_000

type ErrorWithResponse = {
  statusCode?: number
  status?: number
  isRetryable?: boolean
  responseHeaders?: Record<string, string | undefined>
  lastError?: unknown
  cause?: unknown
}

/** The innermost error carrying an HTTP response, if any. */
function responseError(err: unknown): ErrorWithResponse | undefined {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as ErrorWithResponse
    if (e.responseHeaders || (e.statusCode ?? e.status) !== undefined) return e
    current = e.lastError ?? e.cause
  }
  return undefined
}

function header(err: unknown, name: string): string | undefined {
  const headers = responseError(err)?.responseHeaders
  if (!headers) return undefined
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

/** How long the server asked us to wait, from `retry-after-ms` or `retry-after`. */
export function retryAfterMs(err: unknown): number | undefined {
  const ms = Number(header(err, 'retry-after-ms'))
  if (Number.isFinite(ms) && ms >= 0) return ms
  const value = header(err, 'retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

/**
 * Whether sending the same request again may succeed: the server says so
 * through `x-should-retry`, or the failure is a timeout, conflict, rate
 * limit, server error or dropped connection.
 */
export function isRetryableRequestError(err: unknown): boolean {
  const shouldRetry = header(err, 'x-should-retry')
  if (shouldRetry === 'true') return true
  if (shouldRetry === 'false') return false
  if (isTransientStreamError(err)) return true
  const e = responseError(err)
  const status = e?.statusCode ?? e?.status
  if (status === 408 || status === 409) return true
  if (status !== undefined && status >= 500) return true
  return e?.isRetryable === true
}

/**
 * Wait before retry `attempt` (1-based): what the server asked for, else
 * exponential backoff capped at 32s plus up to 25% jitter.
 */
export function retryDelayMs(attempt: number, err?: unknown): number {
  const requested = err === undefined ? undefined : retryAfterMs(err)
  if (requested !== undefined) return requested
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
  return base + Math.random() * 0.25 * base
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
