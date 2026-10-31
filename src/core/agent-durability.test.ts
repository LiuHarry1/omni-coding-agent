import { describe, expect, it, vi } from 'vitest'
import { isRoleMessage, type AgentOptions, type Message } from './types.js'

const observed = vi.hoisted(() => ({
  order: [] as string[],
  queryMessages: [] as Message[],
}))

vi.mock('./query.js', () => ({
  query: async (options: AgentOptions) => {
    observed.order.push('query')
    observed.queryMessages = [...(options.messages ?? [])]
    return {
      finalText: 'ok',
      messages: options.messages ?? [],
      reason: 'completed',
    }
  },
}))

import { runAgent } from './agent.js'

describe('opening transcript checkpoint', () => {
  it('awaits user-message persistence before entering the query loop', async () => {
    observed.order = []
    observed.queryMessages = []
    const messages: Message[] = []

    const result = await runAgent('durable request', {
      messages,
      onMessagesSeeded: async seeded => {
        observed.order.push('checkpoint-start')
        const opening = seeded.at(-1)
        expect(
          opening && isRoleMessage(opening) ? opening.role : undefined,
        ).toBe('user')
        expect(opening?.uuid).toBeTypeOf('string')
        await Promise.resolve()
        observed.order.push('checkpoint-end')
      },
      onQueryResult: async result => {
        await Promise.resolve()
        expect(result.reason).toBe('completed')
        observed.order.push('query-result')
      },
    } as AgentOptions)

    expect(result).toBe('ok')
    expect(observed.order).toEqual([
      'checkpoint-start',
      'checkpoint-end',
      'query',
      'query-result',
    ])
    const queriedOpening = observed.queryMessages.at(-1)
    expect(
      queriedOpening && isRoleMessage(queriedOpening)
        ? queriedOpening.role
        : undefined,
    ).toBe('user')
  })
})
