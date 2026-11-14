import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from './event-bus.js'
import type { QueryOptions } from './query/types.js'
import type { Message, UserMessage } from './types.js'
import { WireEmitter } from './wire-emitter.js'

type StepScript = {
  text?: string
  truncated?: boolean
  truncatedToolNames?: string[]
  completedCleanly?: boolean
  toolCalls?: unknown[]
}

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

/** Each runStep call commits its assistant text, like the real one does. */
function scriptSteps(steps: StepScript[]): void {
  let i = 0
  mocks.runStep.mockImplementation(
    async (args: { messages: Message[]; eventBus: EventBus }) => {
      const s = steps[i++]
      if (!s) throw new Error(`unexpected runStep call #${i}`)
      if (i === 1) {
        args.eventBus.emit('todo_update', {
          todos: [{ id: 't1', content: 'write report', status: 'in_progress' }],
        })
      }
      const text = s.text ?? ''
      if (text) {
        args.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text }],
        } as Message)
      }
      return {
        text,
        toolCalls: s.toolCalls ?? [],
        toolResults: [],
        completedCleanly: s.completedCleanly ?? true,
        ...(s.truncated ? { truncated: true } : {}),
        ...(s.truncatedToolNames
          ? { truncatedToolNames: s.truncatedToolNames }
          : {}),
      }
    },
  )
}

async function run(opts: { cap?: number } = {}) {
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
  const todoUpdates: unknown[] = []
  eventBus.on('todo_update', data => todoUpdates.push(data))

  const result = await query({
    tools: {},
    systemPrompt: 'system',
    eventBus,
    wire,
    messages: [
      { role: 'user', uuid: 'user-1', content: 'write a long report' },
    ],
    provider: {
      defaultModelId: () => 'test-model',
      ...(opts.cap !== undefined ? { maxOutputTokenCap: () => opts.cap } : {}),
    },
    compaction: { maxOutputTokens: 16_384 },
    cwd: '/workspace',
  } as unknown as QueryOptions)

  const overrides = mocks.runStep.mock.calls.map(
    ([args]) =>
      (args as { maxOutputTokensOverride?: number }).maxOutputTokensOverride,
  )
  const reminders = result.messages.filter(
    (m): m is UserMessage =>
      (m as UserMessage).role === 'user' && (m as UserMessage).isMeta === true,
  )
  return { result, events, todoUpdates, overrides, reminders }
}

const truncatedText = (text: string): StepScript => ({ text, truncated: true })

describe('query output-limit truncation recovery', () => {
  beforeEach(() => {
    mocks.runStep.mockReset()
    mocks.postTurn.mockReset()
  })

  it('continues after a cut-off answer with a hidden reminder', async () => {
    scriptSteps([truncatedText('Hello wor'), { text: 'ld!' }])

    const { result, reminders } = await run()

    expect(result.reason).toBe('completed')
    expect(result.finalText).toBe('Hello world!')
    expect(mocks.runStep).toHaveBeenCalledTimes(2)
    expect(mocks.postTurn).toHaveBeenCalledTimes(2)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.continuation).toBe('max_output_tokens')
    expect(String(reminders[0]!.content)).toContain('Continue exactly')
  })

  it('asks to reissue a tool call whose input was cut off', async () => {
    scriptSteps([
      {
        text: 'Writing the file.',
        truncated: true,
        truncatedToolNames: ['Write'],
        completedCleanly: false,
      },
      { text: 'Done.' },
    ])

    const { result, events, reminders } = await run()

    expect(result.reason).toBe('completed')
    expect(String(reminders[0]!.content)).toContain('Write')
    // A dropped call starts over; its lead-in is not part of the answer.
    expect(reminders[0]!.continuation).toBeUndefined()
    expect(result.finalText).toBe('Done.')
    expect(events.some(e => e.type === 'result' && e.subtype === 'error')).toBe(
      false,
    )
  })

  it('counts a cut tool call the provider closed with an error result', async () => {
    const cutCall = {
      truncated: true,
      truncatedToolNames: ['Write'],
      toolCalls: [{ toolCallId: 'c1', toolName: 'Write', input: {} }],
    }
    scriptSteps([cutCall, cutCall, cutCall, cutCall])

    const { result, reminders } = await run()

    expect(result.reason).toBe('error')
    expect(mocks.runStep).toHaveBeenCalledTimes(4)
    expect(reminders).toHaveLength(3)
  })

  it('needs no reminder when the cut only followed complete tool calls', async () => {
    const ranTools = {
      truncated: true,
      toolCalls: [{ toolCallId: 'c1', toolName: 'Read', input: {} }],
    }
    scriptSteps([ranTools, ranTools, ranTools, ranTools, { text: 'Done.' }])

    const { result, reminders } = await run()

    expect(result.reason).toBe('completed')
    expect(mocks.runStep).toHaveBeenCalledTimes(5)
    expect(reminders).toHaveLength(0)
  })

  it('gives up with an error after repeated cuts and leaves todos open', async () => {
    scriptSteps([
      truncatedText('a'),
      truncatedText('b'),
      truncatedText('c'),
      truncatedText('d'),
    ])

    const { result, events, todoUpdates } = await run()

    expect(result.reason).toBe('error')
    expect(mocks.runStep).toHaveBeenCalledTimes(4)
    expect(result.finalText).toBe('abcd')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'result', subtype: 'error' }),
    )
    // Only the seed update from the first step; no auto-complete.
    expect(todoUpdates).toHaveLength(1)
  })

  it('resets the budget once a step finishes normally', async () => {
    scriptSteps([
      truncatedText('a'),
      truncatedText('b'),
      {
        toolCalls: [{ toolCallId: 'c1', toolName: 'Read', input: {} }],
      },
      truncatedText('c'),
      truncatedText('d'),
      truncatedText('e'),
      { text: 'f' },
    ])

    const { result } = await run()

    expect(result.reason).toBe('completed')
    expect(mocks.runStep).toHaveBeenCalledTimes(7)
  })

  it('raises max_tokens for continuations only when the model declares a higher cap', async () => {
    scriptSteps([
      truncatedText('a'),
      truncatedText('b'),
      {
        toolCalls: [{ toolCallId: 'c1', toolName: 'Read', input: {} }],
      },
      { text: 'c' },
    ])
    const withCap = await run({ cap: 128_000 })
    expect(withCap.overrides).toEqual([undefined, 65_536, 65_536, undefined])

    mocks.runStep.mockReset()
    scriptSteps([truncatedText('a'), { text: 'b' }])
    const noCap = await run()
    expect(noCap.overrides).toEqual([undefined, undefined])

    mocks.runStep.mockReset()
    scriptSteps([truncatedText('a'), { text: 'b' }])
    const lowCap = await run({ cap: 8_192 })
    expect(lowCap.overrides).toEqual([undefined, undefined])
  })
})
