import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from './types.js'

const written = vi.hoisted(() => [] as Array<{ id: string; m: unknown }>)
vi.mock('../session/index.js', () => ({
  appendMessage: (id: string, m: unknown) => written.push({ id, m }),
}))

import { runSessionTurn } from './agent.js'
import { createQueryHarness } from './query-test-harness.js'

const roles = () =>
  written.map(({ m }) => (m as { role?: string; type?: string }).role)

describe('runSessionTurn', () => {
  beforeEach(() => {
    written.length = 0
  })

  it('writes the opening message before the first model request', async () => {
    const h = createQueryHarness({ messages: [] })
    const order: string[] = []
    h.scriptSteps([{ text: 'answer' }], () => {
      order.push(`request after ${written.length} written`)
    })
    const result = await runSessionTurn('s1', 'hello', h.options, {
      onSeeded: () => order.push('seeded'),
    })
    expect(order).toEqual(['seeded', 'request after 1 written'])
    expect(roles()).toEqual(['user', 'assistant'])
    expect(written.every(w => w.id === 's1')).toBe(true)
    expect(result.reason).toBe('completed')
  })

  it('writes recalled memories ahead of the user message', async () => {
    const h = createQueryHarness({ messages: [] })
    h.scriptSteps([{ text: 'answer' }])
    const memory = {
      type: 'attachment',
      attachment: { type: 'relevant_memories', memories: [] },
    } as unknown as Message
    await runSessionTurn('s1', 'hello', {
      ...h.options,
      leadingMessages: [memory],
    })
    expect(written.map(({ m }) => m)).toEqual(h.options.messages)
    expect(written[0]!.m).toBe(memory)
    expect(roles()).toEqual([undefined, 'user', 'assistant'])
  })

  it('keeps what a failed turn appended', async () => {
    const h = createQueryHarness({ messages: [] })
    h.deps.runStep.mockImplementation(async args => {
      args.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
      } as Message)
      throw new Error('boom')
    })
    await expect(runSessionTurn('s1', 'hello', h.options)).rejects.toThrow(
      'boom',
    )
    expect(roles()).toEqual(['user', 'assistant'])
  })
})
