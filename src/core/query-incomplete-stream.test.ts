import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from './event-bus.js'
import type { QueryOptions } from './query/types.js'
import { WireEmitter } from './wire-emitter.js'

const mocks = vi.hoisted(() => ({
  runStep: vi.fn(),
  postTurn: vi.fn(),
}))

vi.mock('./query/pre-turn.js', () => ({
  preTurn: async ({ messages }: { messages: unknown[] }) => messages,
}))

vi.mock('./query/run-step.js', () => ({
  createDumpRecorder: () => undefined,
  runStep: mocks.runStep,
}))

vi.mock('./query/post-turn.js', () => ({
  postTurn: mocks.postTurn,
  emitTurnEnd: () => {},
}))

vi.mock('./query/force-final-answer.js', () => ({
  forceFinalAnswerOnMaxSteps: async () => undefined,
}))

import { query } from './query.js'

describe('query incomplete stream handling', () => {
  beforeEach(() => {
    mocks.runStep.mockReset()
    mocks.postTurn.mockReset()
  })

  it('returns an error terminal instead of success', async () => {
    mocks.runStep.mockResolvedValue({
      text: '',
      toolCalls: [],
      toolResults: [],
      completedCleanly: false,
      completionError: 'Upstream stream ended before tool arguments completed.',
    })

    const events: Array<Record<string, unknown>> = []
    const wire = new WireEmitter(
      {
        emit(message) {
          events.push(message as unknown as Record<string, unknown>)
        },
      },
      'test-session',
    )

    const result = await query({
      tools: {},
      systemPrompt: 'system',
      eventBus: new EventBus(),
      wire,
      messages: [{ role: 'user', uuid: 'user-1', content: 'write a file' }],
      provider: {
        defaultModelId: () => 'test-model',
      },
      cwd: '/workspace',
    } as unknown as QueryOptions)

    expect(result.reason).toBe('error')
    expect(mocks.postTurn).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'error',
        error: 'Upstream stream ended before tool arguments completed.',
      }),
    )
    expect(
      events.some(
        event => event.type === 'result' && event.subtype === 'success',
      ),
    ).toBe(false)
  })
})
