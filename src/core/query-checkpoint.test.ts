import { describe, expect, it, vi } from 'vitest'
import { query } from './query.js'
import { createQueryHarness } from './query-test-harness.js'
import { isRoleMessage, type Message } from './types.js'

describe('step transcript checkpoint', () => {
  it('awaits a complete post-turn checkpoint before completing the step', async () => {
    let entered = false
    let committed = false
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const h = createQueryHarness({
      onStepCommitted: async (checkpointed: readonly Message[]) => {
        entered = true
        const last = checkpointed.at(-1)
        expect(last && isRoleMessage(last) ? last.role : undefined).toBe(
          'assistant',
        )
        await gate
        committed = true
      },
    })
    // The step itself commits nothing; post-turn appends the checkpointed tail.
    h.deps.runStep.mockResolvedValue({
      text: 'step complete',
      toolCalls: [],
      toolResults: [],
      completedCleanly: true,
    })
    h.deps.postTurn.mockImplementation(async ({ messages }) => {
      messages.push({
        role: 'assistant',
        uuid: 'assistant-checkpoint',
        content: [{ type: 'text', text: 'step complete' }],
      })
    })

    const promise = query(h.options)

    await vi.waitFor(() => expect(entered).toBe(true))
    let resolved = false
    void promise.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    release()
    const result = await promise
    expect(committed).toBe(true)
    expect(result.reason).toBe('completed')
    expect(result.finalText).toBe('step complete')
  })
})
