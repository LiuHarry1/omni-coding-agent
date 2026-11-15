import { describe, expect, it } from 'vitest'
import { noticeText } from './translate-outbound.js'

describe('noticeText', () => {
  it('describes a retry and a context warning in one line', () => {
    expect(
      noticeText({
        kind: 'retry',
        attempt: 1,
        max_attempts: 10,
        delay_ms: 1_500,
        error: 'overloaded',
      }),
    ).toBe('Request failed, retrying in 2s (attempt 1/10): overloaded')
    expect(
      noticeText({
        kind: 'context_warning',
        percent_left: 7,
        current_tokens: 150_000,
      }),
    ).toBe('Context left: 7% before older messages are summarized')
  })
})
