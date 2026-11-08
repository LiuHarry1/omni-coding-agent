import type { streamText } from 'ai'
import { describe, expect, it } from 'vitest'
import { WireEmitter } from '../wire-emitter.js'
import { consumeStream } from './streamConsumer.js'

function fakeStream(parts: unknown[]): ReturnType<typeof streamText> {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        for (const part of parts) yield part
      },
    },
  } as unknown as ReturnType<typeof streamText>
}

function recordingWire(): {
  wire: WireEmitter
  events: Array<Record<string, unknown>>
} {
  const events: Array<Record<string, unknown>> = []
  return {
    wire: new WireEmitter(
      {
        emit(message) {
          events.push(message as unknown as Record<string, unknown>)
        },
      },
      'test-session',
    ),
    events,
  }
}

describe('consumeStream completion integrity', () => {
  it('accepts a response with a definitive finish event', async () => {
    const { wire } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'text-delta', id: 'text-1', text: 'done' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.text).toBe('done')
    expect(result.completedCleanly).toBe(true)
    expect(result.completionError).toBeUndefined()
  })

  it('does not turn an unfinished tool input into a synthetic tool call', async () => {
    const { wire, events } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        {
          type: 'tool-input-start',
          id: 'tool-1',
          toolName: 'Write',
        },
        {
          type: 'tool-input-delta',
          id: 'tool-1',
          delta: '{"file_path":"output.txt"',
        },
        {
          // AI SDK uses this fallback reason when a partial provider stream
          // closes without its own terminal chunk.
          type: 'finish',
          finishReason: 'other',
          rawFinishReason: undefined,
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.completedCleanly).toBe(false)
    expect(result.completionError).toContain('Write')
    expect(result.toolCalls).toEqual([])
    expect(result.toolResults).toEqual([])
    expect(events.some(event => event.type === 'tool_call')).toBe(false)
    expect(events.some(event => event.type === 'tool_result')).toBe(false)
  })

  it('rejects an unfinished tool input even with an explicit length finish', async () => {
    const { wire } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        {
          type: 'tool-input-start',
          id: 'tool-1',
          toolName: 'Write',
        },
        {
          type: 'finish',
          finishReason: 'length',
          rawFinishReason: 'max_tokens',
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.completedCleanly).toBe(false)
    expect(result.completionError).toContain('tool arguments')
  })

  it('rejects a provider error after partial text instead of reporting success', async () => {
    const { wire } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'text-delta', id: 'text-1', text: 'partial' },
        { type: 'error', error: new Error('connection reset') },
        {
          type: 'finish',
          finishReason: 'error',
          rawFinishReason: undefined,
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.text).toBe('partial')
    expect(result.completedCleanly).toBe(false)
    expect(result.completionError).toContain('connection reset')
  })
})
