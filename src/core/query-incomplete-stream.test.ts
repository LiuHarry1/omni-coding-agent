import { describe, expect, it } from 'vitest'
import { query } from './query.js'
import { createQueryHarness } from './query-test-harness.js'

describe('query incomplete stream handling', () => {
  it('returns an error terminal instead of success', async () => {
    const h = createQueryHarness()
    h.scriptSteps([
      {
        completedCleanly: false,
        completionError:
          'Upstream stream ended before tool arguments completed.',
      },
    ])

    const result = await query(h.options)

    expect(result.reason).toBe('error')
    expect(result.terminal).toEqual({
      reason: 'model_error',
      error: 'Upstream stream ended before tool arguments completed.',
    })
    expect(h.deps.postTurn).not.toHaveBeenCalled()
    expect(h.resultEvents()).toEqual([
      expect.objectContaining({
        subtype: 'error',
        error: 'Upstream stream ended before tool arguments completed.',
      }),
    ])
  })
})
