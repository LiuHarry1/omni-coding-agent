import { APICallError } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../event-bus.js'
import type { IProvider } from '../llm/types.js'
import type { Message } from '../types.js'
import { noopWireEmitter } from '../wire-emitter.js'
import { runStep, withExecutorToolCalls, type RunStepArgs } from './run-step.js'

type DoStream = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV3>[0]
>['doStream']
type CallOptions = Parameters<
  Extract<DoStream, (...args: never[]) => unknown>
>[0]

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** A model stream that says `text` and stops. */
function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
        },
      ] as never,
    }),
  }
}

function refusal(message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://llm.test/v1/messages',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  })
}

/** `runStep` arguments over a mock model that answers through `respond`. */
function stepArgs(
  respond: (options: CallOptions) => ReturnType<typeof textStream>,
  overrides: Partial<RunStepArgs> = {},
) {
  const requests: CallOptions[] = []
  const model = new MockLanguageModelV3({
    doStream: (async (options: CallOptions) => {
      requests.push(options)
      return respond(options)
    }) as never,
  })
  const provider: IProvider = {
    chatModel: () => model,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'test-model',
    describe: () => 'test',
  }
  const messages: Message[] = [{ role: 'user', content: 'hello' }]
  const args: RunStepArgs = {
    messages,
    tools: {},
    systemPrompt: 'system',
    provider,
    resolvedModel: 'test-model',
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    step: 0,
    stepStart: Date.now(),
    currentTodos: [],
    concurrencyPolicy: () => false,
    compaction: { maxOutputTokens: 16_384 } as RunStepArgs['compaction'],
    ...overrides,
  }
  return { args, requests, messages }
}

describe('runStep with a raised output cap', () => {
  it('retries once at the default when the endpoint refuses the cap', async () => {
    const { args, requests, messages } = stepArgs(
      options => {
        if ((options.maxOutputTokens ?? 0) > 32_000) {
          throw refusal('max_tokens: 65536 > 32000, the maximum for this model')
        }
        return textStream('Done.')
      },
      { maxOutputTokensOverride: 65_536 },
    )

    const result = await runStep(args)

    expect(requests.map(r => r.maxOutputTokens)).toEqual([65_536, 16_384])
    expect(result).toMatchObject({
      text: 'Done.',
      completedCleanly: true,
      outputCapRejected: true,
    })
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it('does not flag a cap the endpoint accepted', async () => {
    const { args, requests } = stepArgs(() => textStream('Done.'), {
      maxOutputTokensOverride: 65_536,
    })

    const result = await runStep(args)

    expect(requests.map(r => r.maxOutputTokens)).toEqual([65_536])
    expect(result.outputCapRejected).toBeUndefined()
  })

  it('reports a refusal at the default cap without retrying', async () => {
    const { args, requests } = stepArgs(() => {
      throw refusal('messages: roles must alternate')
    })

    const result = await runStep(args)

    expect(requests).toHaveLength(1)
    expect(result.completedCleanly).toBe(false)
    expect(result.completionError).toContain('roles must alternate')
    expect(result.outputCapRejected).toBeUndefined()
  })
})

describe('withExecutorToolCalls', () => {
  const call = (toolCallId: string, toolName: string) => ({
    toolCallId,
    toolName,
    input: {},
  })

  it('keeps stream order and takes the executor version of each call', () => {
    const streamed = [call('a', 'bash'), call('b', 'Write'), call('c', 'Read')]
    // The executor resolved the misspelled name and never saw `b`, whose
    // arguments did not parse.
    const executed = [call('c', 'Read'), call('a', 'Bash')]

    expect(withExecutorToolCalls(streamed, executed)).toEqual([
      call('a', 'Bash'),
      call('b', 'Write'),
      call('c', 'Read'),
    ])
  })
})
