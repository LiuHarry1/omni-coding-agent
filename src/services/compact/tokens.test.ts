import { describe, expect, it } from 'vitest'
import { toAttachedUsage } from './tokens.js'

describe('toAttachedUsage', () => {
  it('keeps cache reads and writes from the usage details', () => {
    expect(
      toAttachedUsage({
        inputTokens: 12_000,
        outputTokens: 300,
        totalTokens: 12_300,
        inputTokenDetails: {
          noCacheTokens: 1_000,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 1_000,
        },
        outputTokenDetails: { textTokens: 100, reasoningTokens: 200 },
      }),
    ).toEqual({
      inputTokens: 12_000,
      outputTokens: 300,
      totalTokens: 12_300,
      cachedInputTokens: 10_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 200,
    })
  })

  it('drops fields the provider did not report', () => {
    expect(
      toAttachedUsage({ inputTokens: 5, outputTokens: undefined }),
    ).toEqual({ inputTokens: 5 })
    expect(toAttachedUsage(undefined)).toEqual({})
  })
})
