import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IProvider } from '../llm/types.js'
import {
  cleanSummary,
  generateToolUseSummary,
} from './toolUseSummaryGenerator.js'

type Prompt = Array<{ role: string; content: unknown }>

/** A provider whose model answers `reply` and records what it was asked. */
function summaryModel(reply: string | (() => never)) {
  const requests: Array<{ prompt: Prompt; abortSignal?: AbortSignal }> = []
  const model = new MockLanguageModelV3({
    doGenerate: (async (options: {
      prompt: Prompt
      abortSignal?: AbortSignal
    }) => {
      requests.push(options)
      if (typeof reply === 'function') reply()
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    }) as never,
  })
  const provider: IProvider = {
    chatModel: () => model,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'small-model',
    describe: () => 'test',
  }
  const textOf = (role: string): string => {
    const message = requests[0]!.prompt.find(entry => entry.role === role)!
    return typeof message.content === 'string'
      ? message.content
      : (message.content as Array<{ text?: string }>)
          .map(part => part.text ?? '')
          .join('')
  }
  return { provider, requests, textOf }
}

const readCall = {
  name: 'Read',
  input: { file_path: 'src/config.json' },
  output: '{"port": 8080}',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateToolUseSummary', () => {
  it('asks the model about the calls and returns its label', async () => {
    const { provider, textOf } = summaryModel('Read config.json')

    const summary = await generateToolUseSummary({
      tools: [
        readCall,
        { name: 'Bash', input: { command: 'npm test' }, output: 'ok' },
      ],
      provider,
      model: 'small-model',
      lastAssistantText: 'Let me check the port.',
    })

    expect(summary).toBe('Read config.json')
    expect(textOf('system')).toContain('Write a short summary label')
    expect(textOf('user')).toBe(
      "User's intent (from assistant's last message): Let me check the port.\n\n" +
        'Tools completed:\n\n' +
        'Tool: Read\nInput: {"file_path":"src/config.json"}\nOutput: "{\\"port\\": 8080}"\n\n' +
        'Tool: Bash\nInput: {"command":"npm test"}\nOutput: "ok"\n\n' +
        'Label:',
    )
  })

  it('leaves the intent line out when the step had no text', async () => {
    const { provider, textOf } = summaryModel('Read config.json')

    await generateToolUseSummary({
      tools: [readCall],
      provider,
      model: 'small-model',
    })

    expect(textOf('user').startsWith('Tools completed:')).toBe(true)
  })

  it('shortens long inputs, outputs and intent before sending them', async () => {
    const { provider, textOf } = summaryModel('Wrote report')

    await generateToolUseSummary({
      tools: [
        {
          name: 'Write',
          input: { content: 'x'.repeat(5_000) },
          output: 'y'.repeat(5_000),
        },
      ],
      provider,
      model: 'small-model',
      lastAssistantText: 'z'.repeat(1_000),
    })

    const prompt = textOf('user')
    const input = prompt.match(/Input: (.*)\n/)![1]!
    const output = prompt.match(/Output: (.*)\n/)![1]!
    expect(input).toHaveLength(300)
    expect(input.endsWith('...')).toBe(true)
    expect(output).toHaveLength(300)
    expect(prompt.match(/z+/)![0]).toHaveLength(200)
  })

  it('does not call the model for an empty batch', async () => {
    const { provider, requests } = summaryModel('unused')

    await expect(
      generateToolUseSummary({ tools: [], provider, model: 'small-model' }),
    ).resolves.toBeNull()
    expect(requests).toEqual([])
  })

  it('returns null when the model fails, without retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { provider, requests } = summaryModel(() => {
      throw new Error('overloaded')
    })

    await expect(
      generateToolUseSummary({
        tools: [readCall],
        provider,
        model: 'small-model',
      }),
    ).resolves.toBeNull()
    expect(requests).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overloaded'))
  })

  it('returns null when the model answers with nothing', async () => {
    const { provider } = summaryModel('  \n ')

    await expect(
      generateToolUseSummary({
        tools: [readCall],
        provider,
        model: 'small-model',
      }),
    ).resolves.toBeNull()
  })

  it('stops with the turn', async () => {
    const controller = new AbortController()
    const { provider, requests } = summaryModel('Read config.json')

    controller.abort()
    await generateToolUseSummary({
      tools: [readCall],
      provider,
      model: 'small-model',
      signal: controller.signal,
    })

    // Either the request was never made, or it was made already aborted.
    expect(requests.every(request => request.abortSignal?.aborted)).toBe(true)
  })
})

describe('cleanSummary', () => {
  it.each([
    ['Read config.json', 'Read config.json'],
    ['  Read config.json  \n', 'Read config.json'],
    ['- Fixed NPE in UserService', 'Fixed NPE in UserService'],
    ['"Ran failing tests"', 'Ran failing tests'],
    ['Label: Created signup endpoint', 'Created signup endpoint'],
    [
      '\nSearched in auth/\nThe tools searched the auth folder.',
      'Searched in auth/',
    ],
  ])('%j becomes %j', (text, expected) => {
    expect(cleanSummary(text)).toBe(expected)
  })

  it('cuts a label that runs on', () => {
    const label = cleanSummary(`Refactored ${'very '.repeat(40)}long thing`)!

    expect(label.length).toBeLessThanOrEqual(80)
    expect(label.endsWith('…')).toBe(true)
  })

  it.each(['', '   ', '""', '-  '])('has no label for %j', text => {
    expect(cleanSummary(text)).toBeNull()
  })
})
