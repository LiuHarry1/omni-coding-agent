import { describe, expect, it, vi } from 'vitest'
import type { QueryOptions } from './query/types.js'
import { EventBus } from './event-bus.js'
import { noopWireEmitter } from './wire-emitter.js'
import { isRoleMessage, type Message } from './types.js'

vi.mock('./query/pre-turn.js', () => ({
  preTurn: async ({ messages }: { messages: unknown[] }) => messages,
}))

vi.mock('./query/run-step.js', () => ({
  createDumpRecorder: () => undefined,
  runStep: async () => ({
    aborted: false,
    text: 'step complete',
    toolCalls: [],
  }),
}))

vi.mock('./query/post-turn.js', () => ({
  postTurn: async ({ messages }: { messages: unknown[] }) => {
    messages.push({
      role: 'assistant',
      uuid: 'assistant-checkpoint',
      content: [{ type: 'text', text: 'step complete' }],
    })
  },
  emitTurnEnd: () => {},
}))

vi.mock('./query/force-final-answer.js', () => ({
  forceFinalAnswerOnMaxSteps: async () => undefined,
}))

import { query } from './query.js'

describe('step transcript checkpoint', () => {
  it('awaits a complete post-turn checkpoint before completing the step', async () => {
    let entered = false
    let committed = false
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const messages = [
      { role: 'user' as const, uuid: 'user-1', content: 'request' },
    ]
    const promise = query({
      tools: {},
      systemPrompt: 'system',
      eventBus: new EventBus(),
      wire: noopWireEmitter,
      messages,
      provider: {
        defaultModelId: () => 'test-model',
      },
      cwd: '/workspace',
      onStepCommitted: async (checkpointed: readonly Message[]) => {
        entered = true
        const last = checkpointed.at(-1)
        expect(last && isRoleMessage(last) ? last.role : undefined).toBe(
          'assistant',
        )
        await gate
        committed = true
      },
    } as unknown as QueryOptions)

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
