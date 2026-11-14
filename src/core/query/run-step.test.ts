import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { APICallError, tool } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { isPersistedReference } from '../../services/tool-storage/index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { EventBus } from '../event-bus.js'
import { createHookRunner } from '../hooks/hooks.js'
import type { HooksConfig } from '../hooks/types.js'
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

function overloaded(options: { retryable?: boolean } = {}): APICallError {
  return new APICallError({
    message: 'Overloaded',
    url: 'https://llm.test/v1/messages',
    requestBodyValues: {},
    statusCode: 529,
    isRetryable: options.retryable ?? false,
  })
}

/** A second model to fall back to, with the requests it received. */
function fallbackModel(text = 'From the fallback.') {
  const requests: CallOptions[] = []
  const model = new MockLanguageModelV3({
    doStream: (async (options: CallOptions) => {
      requests.push(options)
      return textStream(text)
    }) as never,
  })
  const provider: IProvider = {
    chatModel: () => model,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'fallback-model',
    describe: () => 'fallback',
  }
  return { fallback: { provider, model: 'fallback-model' }, requests }
}

describe('runStep when the model is overloaded', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Await `pending` while letting the retry backoffs elapse. */
  async function settled<T>(pending: Promise<T>): Promise<T> {
    let done = false
    const tracked = pending.finally(() => {
      done = true
    })
    while (!done) await vi.advanceTimersByTimeAsync(1_000)
    return tracked
  }

  it('switches to the fallback after three overloaded responses in a row', async () => {
    const { fallback, requests: fallbackRequests } = fallbackModel()
    const fallbacks: unknown[] = []
    const { args, requests, messages } = stepArgs(
      () => {
        throw overloaded()
      },
      { fallback },
    )
    args.eventBus.on('model_fallback', data => fallbacks.push(data))

    const result = await settled(runStep(args))

    expect(requests).toHaveLength(3)
    expect(fallbackRequests).toHaveLength(1)
    expect(result).toMatchObject({
      text: 'From the fallback.',
      completedCleanly: true,
      modelFallback: true,
    })
    expect(fallbacks).toEqual([
      { originalModel: 'test-model', fallbackModel: 'fallback-model' },
    ])
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' })
  })

  it("counts the SDK's own retries toward the three", async () => {
    const { fallback, requests: fallbackRequests } = fallbackModel()
    const { args, requests } = stepArgs(
      () => {
        throw overloaded({ retryable: true })
      },
      { fallback },
    )

    const result = await settled(runStep(args))

    // One surfaced error stands for the request and its three SDK retries.
    expect(requests).toHaveLength(4)
    expect(fallbackRequests).toHaveLength(1)
    expect(result.modelFallback).toBe(true)
  })

  it('stays on the main model when it recovers', async () => {
    const { fallback, requests: fallbackRequests } = fallbackModel()
    let calls = 0
    const { args } = stepArgs(
      () => {
        if (++calls <= 2) throw overloaded()
        return textStream('Recovered.')
      },
      { fallback },
    )

    const result = await settled(runStep(args))

    expect(fallbackRequests).toHaveLength(0)
    expect(result.text).toBe('Recovered.')
    expect(result.modelFallback).toBeUndefined()
  })

  it('starts the fallback at the default output cap', async () => {
    const { fallback, requests: fallbackRequests } = fallbackModel()
    const { args } = stepArgs(
      () => {
        throw overloaded()
      },
      { fallback, maxOutputTokensOverride: 65_536 },
    )

    const result = await settled(runStep(args))

    expect(fallbackRequests.map(r => r.maxOutputTokens)).toEqual([16_384])
    expect(result.outputCapRejected).toBeUndefined()
  })

  it('retries then fails when no fallback is configured', async () => {
    const { args, requests } = stepArgs(() => {
      throw overloaded()
    })

    const result = await settled(runStep(args))

    expect(requests).toHaveLength(3)
    expect(result.completedCleanly).toBe(false)
    expect(result.completionError).toContain('Overloaded')
    expect(result.modelFallback).toBeUndefined()
  })

  it('does not fall back on other failures', async () => {
    const { fallback, requests: fallbackRequests } = fallbackModel()
    const { args } = stepArgs(
      () => {
        throw refusal('messages: roles must alternate')
      },
      { fallback },
    )

    const result = await settled(runStep(args))

    expect(fallbackRequests).toHaveLength(0)
    expect(result.completedCleanly).toBe(false)
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

describe.skipIf(process.platform === 'win32')(
  'runStep with hook commands',
  () => {
    let dir: string

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-step-hooks-'))
    })

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    /** A hook command running `body` with the event available as `input`. */
    const hookCommand = (name: string, body: string) => {
      const file = path.join(dir, `${name}.cjs`)
      fs.writeFileSync(
        file,
        `const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))\n${body}\n`,
      )
      return {
        type: 'command' as const,
        command: `"${process.execPath}" "${file}"`,
      }
    }

    /** One step in which the model calls Bash with each of `commands`. */
    function bashStep(commands: string[], hooks: HooksConfig) {
      const ran: string[] = []
      const tools = {
        Bash: tool({
          description: 'Run a command',
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            ran.push(command)
            return `ran ${command}`
          },
        }),
      } as unknown as RunStepArgs['tools']
      const step = stepArgs(
        () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              ...commands.map((command, index) => ({
                type: 'tool-call',
                toolCallId: `call-${index}`,
                toolName: 'Bash',
                input: JSON.stringify({ command }),
              })),
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_use' },
                usage,
              },
            ] as never,
          }),
        }),
        {
          tools,
          hooks: createHookRunner({ hooks, cwd: dir, sessionId: 'session-1' }),
        },
      )
      return { ...step, ran }
    }

    it('lets a PreToolUse command stop one call and not the others', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { args, ran } = bashStep(['rm -rf build', 'npm test'], {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              hookCommand(
                'guard',
                `if (input.tool_input.command.startsWith('rm -rf')) {
                  console.error('rm -rf is not allowed here')
                  process.exit(2)
                }`,
              ),
            ],
          },
        ],
      })

      const result = await runStep(args)
      warn.mockRestore()

      expect(ran).toEqual(['npm test'])
      expect(result.toolResults).toMatchObject([
        {
          toolCallId: 'call-0',
          isError: true,
          result: expect.stringMatching(
            /^PreToolUse:Bash hook error: \[.*guard\.cjs"\]: rm -rf is not allowed here$/,
          ),
        },
        { toolCallId: 'call-1', result: 'ran npm test' },
      ])
      expect(result.hookStopped).toBeUndefined()
    })

    it('ends the turn when a PostToolUse command says not to continue', async () => {
      const { args, ran, messages } = bashStep(['npm test'], {
        PostToolUse: [
          {
            hooks: [
              hookCommand(
                'budget',
                `console.log(JSON.stringify({
                  continue: false,
                  stopReason: 'Saw ' + input.tool_response,
                }))`,
              ),
            ],
          },
        ],
      })

      const result = await runStep(args)

      expect(ran).toEqual(['npm test'])
      expect(result.hookStopped).toBe('Saw ran npm test')
      // The note follows the tool result it belongs to.
      expect(messages.at(-2)).toMatchObject({ role: 'tool' })
      expect(messages.at(-1)).toMatchObject({
        type: 'attachment',
        attachment: {
          type: 'hook_stopped_continuation',
          hookName: 'PostToolUse:Bash',
          message: 'Saw ran npm test',
        },
      })
    })
  },
)

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
