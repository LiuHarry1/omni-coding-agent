import { describe, expect, it } from 'vitest'
import { query } from './query.js'
import { createQueryHarness, type StepScript } from './query-test-harness.js'
import type { QueryOptions } from './query/types.js'
import type { UserMessage } from './types.js'

const truncatedText = (text: string): StepScript => ({ text, truncated: true })
const toolCall = (toolName: string) => ({
  toolCallId: 'c1',
  toolName,
  input: {},
})
const recovery = (attempt: number) => ({
  reason: 'max_output_tokens_recovery',
  attempt,
})

async function run(steps: StepScript[], opts: { cap?: number } = {}) {
  const h = createQueryHarness({
    compaction: { maxOutputTokens: 16_384 } as QueryOptions['compaction'],
    provider:
      opts.cap !== undefined ? { maxOutputTokenCap: () => opts.cap } : {},
  })
  h.scriptSteps(steps, index => {
    if (index === 0) {
      h.eventBus.emit('todo_update', {
        todos: [{ id: 't1', content: 'write report', status: 'in_progress' }],
      })
    }
  })

  const result = await query(h.options)

  const overrides = h.deps.runStep.mock.calls.map(
    ([args]) => args.maxOutputTokensOverride,
  )
  const reminders = result.messages.filter(
    (m): m is UserMessage =>
      (m as UserMessage).role === 'user' && (m as UserMessage).isMeta === true,
  )
  return { ...h, result, overrides, reminders }
}

describe('query output-limit truncation recovery', () => {
  it('continues after a cut-off answer with a hidden reminder', async () => {
    const { result, reminders, deps } = await run([
      truncatedText('Hello wor'),
      { text: 'ld!' },
    ])

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([recovery(1)])
    expect(result.finalText).toBe('Hello world!')
    expect(deps.postTurn).toHaveBeenCalledTimes(2)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.continuation).toBe('max_output_tokens')
    expect(String(reminders[0]!.content)).toContain('Continue exactly')
  })

  it('asks to reissue a tool call whose input was cut off', async () => {
    const { result, reminders, resultEvents } = await run([
      {
        text: 'Writing the file.',
        truncated: true,
        truncatedToolNames: ['Write'],
        completedCleanly: false,
      },
      { text: 'Done.' },
    ])

    expect(result.reason).toBe('completed')
    expect(String(reminders[0]!.content)).toContain('Write')
    // A dropped call starts over; its lead-in is not part of the answer.
    expect(reminders[0]!.continuation).toBeUndefined()
    expect(result.finalText).toBe('Done.')
    expect(resultEvents().some(e => e.subtype === 'error')).toBe(false)
  })

  it('counts a cut tool call the provider closed with an error result', async () => {
    const cutCall: StepScript = {
      truncated: true,
      truncatedToolNames: ['Write'],
      toolCalls: [toolCall('Write')],
    }
    const { result } = await run([cutCall, cutCall, cutCall, cutCall])

    expect(result.reason).toBe('error')
    expect(result.terminal).toEqual({ reason: 'max_output_tokens' })
    expect(result.transitions).toEqual([recovery(1), recovery(2), recovery(3)])
  })

  it('needs no reminder when the cut only followed complete tool calls', async () => {
    const ranTools: StepScript = {
      truncated: true,
      toolCalls: [toolCall('Read')],
    }
    const { result, reminders } = await run([
      ranTools,
      ranTools,
      ranTools,
      ranTools,
      { text: 'Done.' },
    ])

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual(Array(4).fill({ reason: 'next_turn' }))
    expect(reminders).toHaveLength(0)
  })

  it('gives up with an error after repeated cuts and leaves todos open', async () => {
    const { result, deps, resultEvents, todoUpdates } = await run([
      truncatedText('a'),
      truncatedText('b'),
      truncatedText('c'),
      truncatedText('d'),
    ])

    expect(result.reason).toBe('error')
    expect(result.terminal).toEqual({ reason: 'max_output_tokens' })
    expect(deps.runStep).toHaveBeenCalledTimes(4)
    expect(result.finalText).toBe('abcd')
    expect(resultEvents()).toEqual([
      expect.objectContaining({ subtype: 'error' }),
    ])
    // Only the seed update from the first step; no auto-complete.
    expect(todoUpdates).toHaveLength(1)
  })

  it('resets the budget once a step finishes normally', async () => {
    const { result } = await run([
      truncatedText('a'),
      truncatedText('b'),
      { toolCalls: [toolCall('Read')] },
      truncatedText('c'),
      truncatedText('d'),
      truncatedText('e'),
      { text: 'f' },
    ])

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([
      recovery(1),
      recovery(2),
      { reason: 'next_turn' },
      recovery(1),
      recovery(2),
      recovery(3),
    ])
  })

  it('stops raising max_tokens once the endpoint refuses the declared cap', async () => {
    const { overrides } = await run(
      [
        truncatedText('a'),
        { ...truncatedText('b'), outputCapRejected: true },
        truncatedText('c'),
        { toolCalls: [toolCall('Read')] },
        truncatedText('d'),
        { text: 'e' },
      ],
      { cap: 128_000 },
    )

    // Refused on the second request; not tried again for the rest of the turn.
    expect(overrides).toEqual([
      undefined,
      65_536,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('raises max_tokens for continuations only when the model declares a higher cap', async () => {
    const withCap = await run(
      [
        truncatedText('a'),
        truncatedText('b'),
        { toolCalls: [toolCall('Read')] },
        { text: 'c' },
      ],
      { cap: 128_000 },
    )
    expect(withCap.overrides).toEqual([undefined, 65_536, 65_536, undefined])

    const noCap = await run([truncatedText('a'), { text: 'b' }])
    expect(noCap.overrides).toEqual([undefined, undefined])

    const lowCap = await run([truncatedText('a'), { text: 'b' }], {
      cap: 8_192,
    })
    expect(lowCap.overrides).toEqual([undefined, undefined])
  })
})
