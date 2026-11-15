import { describe, expect, it } from 'vitest'
import { noticeLabel } from './notice-label.js'

describe('noticeLabel', () => {
  const retry = {
    kind: 'retry',
    attempt: 2,
    max_attempts: 10,
    delay_ms: 4_000,
    error: 'overloaded',
    at: 1_000,
  }

  it('counts down a retry and disappears when it is due', () => {
    expect(noticeLabel(retry, 1_500)).toBe(
      'Request failed, retrying in 4s (attempt 2/10)',
    )
    expect(noticeLabel(retry, 5_000)).toBeNull()
  })

  it('shows a model switch for a short while', () => {
    const fallback = { kind: 'model_fallback', from: 'a', to: 'b', at: 0 }
    expect(noticeLabel(fallback, 1_000)).toBe('a is busy, switched to b')
    expect(noticeLabel(fallback, 60_000)).toBeNull()
    expect(noticeLabel(null, 0)).toBeNull()
  })
})
