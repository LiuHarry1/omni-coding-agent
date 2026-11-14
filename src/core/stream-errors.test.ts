import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import {
  failedAttemptCount,
  isOverloadedError,
  isTransientStreamError,
} from './stream-errors.js'

function apiError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://llm.test/v1/messages',
    requestBodyValues: {},
    statusCode,
  })
}

describe('isOverloadedError', () => {
  it('recognises a 529', () => {
    expect(isOverloadedError(apiError(529, 'upstream error'))).toBe(true)
  })

  it('recognises an overloaded_error reported mid-stream without a status', () => {
    const streamed = new Error(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    )

    expect(isOverloadedError(streamed)).toBe(true)
  })

  it("recognises the SDK's retry error around a 529", () => {
    const last = apiError(529, 'upstream error')
    const retry = new RetryError({
      message: 'Failed after 4 attempts.',
      reason: 'maxRetriesExceeded',
      errors: [last, last, last, last],
    })

    expect(isOverloadedError(retry)).toBe(true)
    expect(failedAttemptCount(retry)).toBe(4)
  })

  it('does not match rate limits or bad requests', () => {
    expect(isOverloadedError(apiError(429, 'rate limit exceeded'))).toBe(false)
    expect(isOverloadedError(apiError(400, 'roles must alternate'))).toBe(false)
  })

  it('is retried like other transient failures', () => {
    expect(isTransientStreamError(apiError(529, 'upstream error'))).toBe(true)
  })
})

describe('failedAttemptCount', () => {
  it('is one for an error that was not retried', () => {
    expect(failedAttemptCount(apiError(529, 'Overloaded'))).toBe(1)
  })
})
