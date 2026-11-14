import { streamText, tool } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { StreamingToolExecutor } from '../../services/tools/StreamingToolExecutor.js'
import { WireEmitter } from '../wire-emitter.js'
import { consumeStream, TRUNCATED_TOOL_INPUT_RESULT } from './streamConsumer.js'

const PARTIAL_WRITE_INPUT = '{"file_path":"big.txt","content":"aaa'

/**
 * A real `streamText` over a mock model that, like the Anthropic and
 * OpenAI-compatible providers, closes an unfinished tool call itself and
 * hands over whatever arguments had arrived.
 */
function sdkStream(
  input: string,
  finishReason: 'length' | 'tool-calls',
): ReturnType<typeof streamText> {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call-1', toolName: 'Write' },
          { type: 'tool-input-delta', id: 'call-1', delta: input },
          { type: 'tool-input-end', id: 'call-1' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'Write',
            input,
          },
          {
            type: 'finish',
            finishReason: { unified: finishReason, raw: finishReason },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ] as never,
      }),
    }),
  })
  return streamText({
    model,
    prompt: 'write the file',
    tools: {
      Write: tool({
        description: 'Write a file',
        inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      }),
    },
  }) as unknown as ReturnType<typeof streamText>
}

function fakeExecutor(addTool: (call: unknown) => void): StreamingToolExecutor {
  return {
    addTool,
    getCompletedResults: () => [],
  } as unknown as StreamingToolExecutor
}

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
    expect(result.truncated).toBeUndefined()
  })
})

describe('consumeStream output-limit truncation', () => {
  it('flags text cut off at the output limit as truncated but clean', async () => {
    const { wire, events } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'text-delta', id: 'text-1', text: 'half an ans' },
        {
          type: 'finish',
          finishReason: 'length',
          rawFinishReason: 'max_tokens',
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.text).toBe('half an ans')
    expect(result.completedCleanly).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.truncatedToolNames).toBeUndefined()
    expect(events.some(event => event.type === 'tool_result')).toBe(false)
  })

  it('reports the cut tool and settles its streaming card', async () => {
    const { wire, events } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'tool-input-start', id: 'tool-1', toolName: 'Write' },
        {
          type: 'tool-input-delta',
          id: 'tool-1',
          delta: '{"file_path":"big.txt","content":"aaa',
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
    expect(result.truncated).toBe(true)
    expect(result.truncatedToolNames).toEqual(['Write'])
    expect(result.toolCalls).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'tool-1',
        result: TRUNCATED_TOOL_INPUT_RESULT,
        is_error: true,
      }),
    )
    expect(events.some(event => event.type === 'tool_call')).toBe(false)
  })

  it('settles a cut tool call the provider closed itself without running it', async () => {
    const { wire, events } = recordingWire()
    const addTool = vi.fn()
    const result = await consumeStream(
      sdkStream(PARTIAL_WRITE_INPUT, 'length'),
      wire,
      undefined,
      undefined,
      { streamingExecutor: fakeExecutor(addTool) },
    )

    expect(addTool).not.toHaveBeenCalled()
    expect(result.truncated).toBe(true)
    expect(result.truncatedToolNames).toEqual(['Write'])
    expect(result.completedCleanly).toBe(true)
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call-1', toolName: 'Write', input: {} },
    ])
    expect(result.toolResults).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'Write',
        result: TRUNCATED_TOOL_INPUT_RESULT,
      },
    ])
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool_result')).toEqual([
      expect.objectContaining({
        tool_use_id: 'call-1',
        result: TRUNCATED_TOOL_INPUT_RESULT,
        is_error: true,
      }),
    ])
  })

  it('reports malformed arguments as a plain tool error when nothing was cut', async () => {
    const { wire } = recordingWire()
    const addTool = vi.fn()
    const result = await consumeStream(
      sdkStream(PARTIAL_WRITE_INPUT, 'tool-calls'),
      wire,
      undefined,
      undefined,
      { streamingExecutor: fakeExecutor(addTool) },
    )

    expect(addTool).not.toHaveBeenCalled()
    expect(result.truncated).toBeUndefined()
    expect(result.truncatedToolNames).toBeUndefined()
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]!.result).toContain('Invalid input for tool')
  })

  it('does not treat a stream error as truncation', async () => {
    const { wire } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'text-delta', id: 'text-1', text: 'partial' },
        { type: 'error', error: new Error('boom') },
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
    expect(result.truncated).toBeUndefined()
  })

  it('does not flag a normal stop', async () => {
    const { wire } = recordingWire()
    const result = await consumeStream(
      fakeStream([
        { type: 'text-delta', id: 'text-1', text: 'all done' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'end_turn',
          totalUsage: {},
        },
      ]),
      wire,
    )

    expect(result.truncated).toBeUndefined()
  })
})
