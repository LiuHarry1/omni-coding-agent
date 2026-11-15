import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  isRetryableRequestError,
  retryAfterMs,
  retryDelayMs,
  sleep,
} from './with-retry.js'

function apiError(
  statusCode: number,
  responseHeaders?: Record<string, string>,
): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://llm.test/v1/messages',
    requestBodyValues: {},
    statusCode,
    responseHeaders,
    isRetryable: false,
  })
}

describe('isRetryableRequestError', () => {
  it.each([408, 409, 429, 500, 502, 503, 529])('retries HTTP %i', status => {
    expect(isRetryableRequestError(apiError(status))).toBe(true)
  })

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', status => {
    expect(isRetryableRequestError(apiError(status))).toBe(false)
  })

  it('does what x-should-retry says', () => {
    expect(
      isRetryableRequestError(apiError(400, { 'x-should-retry': 'true' })),
    ).toBe(true)
    expect(
      isRetryableRequestError(apiError(503, { 'X-Should-Retry': 'false' })),
    ).toBe(false)
  })

  it('looks inside the SDK retry error', () => {
    const wrapped = new RetryError({
      message: 'failed after 1 attempt',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503)],
    })
    expect(isRetryableRequestError(wrapped)).toBe(true)
  })

  it('retries dropped connections', () => {
    const err = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    })
    expect(isRetryableRequestError(err)).toBe(true)
  })
})

describe('retry delay', () => {
  it('waits as long as retry-after asks', () => {
    expect(retryAfterMs(apiError(429, { 'retry-after': '7' }))).toBe(7_000)
    expect(retryAfterMs(apiError(429, { 'retry-after-ms': '250' }))).toBe(250)
    expect(retryDelayMs(1, apiError(429, { 'retry-after': '3' }))).toBe(3_000)
  })

  it('backs off exponentially with jitter, capped at 32s', () => {
    for (const [attempt, base] of [
      [1, 500],
      [2, 1_000],
      [4, 4_000],
      [10, 32_000],
    ] as const) {
      const delay = retryDelayMs(attempt, apiError(503))
      expect(delay).toBeGreaterThanOrEqual(base)
      expect(delay).toBeLessThanOrEqual(base * 1.25)
    }
  })
})

describe('sleep', () => {
  it('ends as soon as the caller is stopped', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const done = sleep(60_000, controller.signal)
    controller.abort()
    await done
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
