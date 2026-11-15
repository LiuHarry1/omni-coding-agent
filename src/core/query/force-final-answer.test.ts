import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamResult } from '../agent/streamConsumer.js'
import { EventBus } from '../event-bus.js'
import type { IProvider } from '../../services/llm/types.js'
import type { Message } from '../types.js'
import { noopWireEmitter } from '../wire-emitter.js'
import { forceFinalAnswerOnMaxSteps } from './force-final-answer.js'
import { runStep } from './run-step.js'

vi.mock('./run-step.js', () => ({ runStep: vi.fn() }))

const stepResult = (overrides: Partial<StreamResult>): StreamResult => ({
  text: '',
  toolCalls: [],
  toolResults: [],
  completedCleanly: true,
  ...overrides,
})

function summarize() {
  const messages: Message[] = [
    { role: 'user', content: 'request' },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier note.' }] },
  ]
  return forceFinalAnswerOnMaxSteps({
    messages,
    systemPrompt: 'system',
    provider: {} as IProvider,
    resolvedModel: 'test-model',
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    step: 3,
    currentTodos: [],
  })
}

describe('forceFinalAnswerOnMaxSteps', () => {
  beforeEach(() => {
    vi.mocked(runStep).mockReset()
  })

  it('returns the text of the forced step', async () => {
    vi.mocked(runStep).mockResolvedValue(stepResult({ text: ' Report. ' }))

    expect(await summarize()).toBe('Report.')
  })

  it('falls back to earlier text when the step says nothing', async () => {
    vi.mocked(runStep).mockResolvedValue(stepResult({}))

    expect(await summarize()).toBe('Earlier note.')
  })

  it('returns nothing when the request failed', async () => {
    vi.mocked(runStep).mockResolvedValue(
      stepResult({
        completedCleanly: false,
        completionError: 'Upstream stream failed: 502.',
      }),
    )

    expect(await summarize()).toBe('')
  })
})
