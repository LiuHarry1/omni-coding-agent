import { afterEach, describe, expect, it } from 'vitest'
import type { IProvider } from '../../core/llm/types.js'
import { compactionLimits } from './autoCompact.js'

const withWindow = (contextWindow: number | undefined): IProvider =>
  ({ contextWindow: () => contextWindow }) as unknown as IProvider

describe('compactionLimits', () => {
  afterEach(() => {
    delete process.env.COMPACT_CONTEXT_WINDOW
  })

  it('follows the window of the model being called', () => {
    const small = compactionLimits(undefined, withWindow(128_000))
    const large = compactionLimits(undefined, withWindow(1_000_000))
    expect(small.contextWindow).toBe(128_000)
    expect(large.contextWindow).toBe(1_000_000)
    expect(small.threshold).toBeLessThan(128_000)
    expect(large.threshold).toBeGreaterThan(900_000)
    expect(small.blockingLimit).toBeGreaterThan(small.threshold)
  })

  it('falls back to the compaction setting when the model has no known window', () => {
    const limits = compactionLimits(
      {
        enabled: true,
        contextWindow: 64_000,
        microCompactKeepRecent: 5,
        maxFilesToRestore: 5,
        maxTokensPerFile: 5_000,
        fileBudget: 50_000,
      },
      withWindow(undefined),
    )
    expect(limits.contextWindow).toBe(64_000)
  })

  it('lets the environment override every source', () => {
    process.env.COMPACT_CONTEXT_WINDOW = '50000'
    expect(
      compactionLimits(undefined, withWindow(1_000_000)).contextWindow,
    ).toBe(50_000)
  })
})
