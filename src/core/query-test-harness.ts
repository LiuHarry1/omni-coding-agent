import { vi } from 'vitest'
import type { StreamResult } from './agent/streamConsumer.js'
import { EventBus } from './event-bus.js'
import type { IProvider } from './llm/types.js'
import type { QueryDeps } from './query/deps.js'
import type { QueryOptions } from './query/types.js'
import type { Message, TodoItem } from './types.js'
import { WireEmitter } from './wire-emitter.js'

/** What a scripted `runStep` returns; its `text` is also committed to history. */
export type StepScript = Partial<StreamResult>

type RunStepArgs = Parameters<QueryDeps['runStep']>[0]

type Overrides = Partial<Omit<QueryOptions, 'provider' | 'deps'>> & {
  provider?: Partial<IProvider>
}

/** `query()` options over fake loop phases, a recording wire and a real bus. */
export function createQueryHarness(overrides: Overrides = {}) {
  const events: Array<Record<string, unknown>> = []
  const wire = new WireEmitter(
    {
      emit(message) {
        events.push(message as unknown as Record<string, unknown>)
      },
    },
    'test-session',
  )
  const eventBus = new EventBus()
  const todoUpdates: TodoItem[][] = []
  eventBus.on('todo_update', data =>
    todoUpdates.push((data as { todos: TodoItem[] }).todos),
  )

  const deps = {
    preTurn: vi.fn<QueryDeps['preTurn']>(async ({ messages }) => messages),
    runStep: vi.fn<QueryDeps['runStep']>(),
    postTurn: vi.fn<QueryDeps['postTurn']>(async () => {}),
    forceFinalAnswerOnMaxSteps: vi.fn<QueryDeps['forceFinalAnswerOnMaxSteps']>(
      async () => '',
    ),
    generateToolUseSummary: vi.fn<QueryDeps['generateToolUseSummary']>(
      async () => null,
    ),
  }

  /** Queue one `runStep` result per call; `onStep` runs before it returns. */
  const scriptSteps = (
    steps: StepScript[],
    onStep?: (index: number, args: RunStepArgs) => void,
  ): void => {
    let calls = 0
    deps.runStep.mockImplementation(async args => {
      const index = calls++
      const script = steps[index]
      if (!script) throw new Error(`unexpected runStep call #${index + 1}`)
      onStep?.(index, args)
      const text = script.text ?? ''
      if (text) {
        args.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text }],
        } as Message)
      }
      return {
        toolCalls: [],
        toolResults: [],
        completedCleanly: true,
        ...script,
        text,
      }
    })
  }

  const options = {
    tools: {},
    systemPrompt: 'system',
    eventBus,
    wire,
    messages: [{ role: 'user', uuid: 'user-1', content: 'request' }],
    cwd: '/workspace',
    deps,
    ...overrides,
    provider: { defaultModelId: () => 'test-model', ...overrides.provider },
  } as unknown as QueryOptions

  return {
    options,
    deps,
    eventBus,
    wire,
    events,
    todoUpdates,
    scriptSteps,
    resultEvents: () => events.filter(event => event.type === 'result'),
  }
}
