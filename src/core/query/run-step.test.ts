import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { APICallError, tool } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isPersistedReference } from '../../services/tool-storage/index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { EventBus } from '../event-bus.js'
import type { IProvider } from '../llm/types.js'
import { registerSessionLocation } from '../session-paths.js'
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

describe('runStep tool result budget', () => {
  const SESSION = 'run-step-budget'
  const previousAuth = process.env.AUTH_ENABLED
  const previousLimit = process.env.TOOL_RESULTS_PER_MESSAGE_CHARS
  let home: string | undefined

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    restore('AUTH_ENABLED', previousAuth)
    restore('TOOL_RESULTS_PER_MESSAGE_CHARS', previousLimit)
    if (home) fs.rmSync(home, { recursive: true, force: true })
  })

  it('bounds the results of one step together before committing them', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-step-budget-'))
    process.env.AUTH_ENABLED = 'true'
    process.env.TOOL_RESULTS_PER_MESSAGE_CHARS = '10000'
    registerSessionLocation(SESSION, { projectKey: 'test', agentHome: home })

    const sizes: Record<string, number> = { a: 8_000, b: 3_000, c: 6_000 }
    const tools = {
      Grep: tool({
        description: 'Search',
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => 'x'.repeat(sizes[pattern]!),
      }),
    } as unknown as RunStepArgs['tools']
    const { args, messages } = stepArgs(
      () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...Object.keys(sizes).map(pattern => ({
              type: 'tool-call',
              toolCallId: `call-${pattern}`,
              toolName: 'Grep',
              input: JSON.stringify({ pattern }),
            })),
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_use' },
              usage,
            },
          ] as never,
        }),
      }),
      { tools, sessionId: SESSION, concurrencyPolicy: () => true },
    )

    const result = await runWithRequestScope(
      { agentHome: home, cwd: home },
      () => runStep(args),
    )

    // 17k in one message against a 10k limit: the 8k result moves to disk.
    const inline = result.toolResults.map(r => !isPersistedReference(r.result))
    expect(inline).toEqual([false, true, true])
    const toolMessage = messages.at(-1) as Extract<Message, { role: 'tool' }>
    expect(toolMessage.role).toBe('tool')
    expect(
      toolMessage.content.map(part =>
        isPersistedReference(String((part.output as { value: string }).value)),
      ),
    ).toEqual([true, false, false])
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
