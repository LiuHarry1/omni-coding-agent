import { describe, expect, it, vi } from 'vitest'
import type { MCPPromptInfo } from './manager.js'
import {
  isMcpPromptSlash,
  listMcpPromptSlashEntries,
  parsePromptArguments,
  promptMessagesToText,
  resolveMcpPromptSlash,
  type McpPromptSource,
} from './prompts.js'

const GREET: MCPPromptInfo = {
  server: 'my server',
  name: 'greet',
  description: 'Greet someone',
  arguments: [{ name: 'name', required: true }, { name: 'tone' }],
}
const REVIEW: MCPPromptInfo = { server: 'git', name: 'review', arguments: [] }

function source(
  getPrompt: McpPromptSource['getPrompt'] = async () => [
    { role: 'user', content: { type: 'text', text: 'Hello there' } },
  ],
) {
  return {
    listPrompts: vi.fn(async () => [GREET, REVIEW]),
    getPrompt: vi.fn(getPrompt),
  }
}

describe('parsePromptArguments', () => {
  it('gives the last argument the rest of the line', () => {
    expect(
      parsePromptArguments('Ada in a warm tone', ['name', 'tone']),
    ).toEqual({ name: 'Ada', tone: 'in a warm tone' })
    expect(parsePromptArguments('fix the login bug', ['task'])).toEqual({
      task: 'fix the login bug',
    })
  })

  it('keeps quoted words together', () => {
    expect(
      parsePromptArguments('"Ada Lovelace" warm', ['name', 'tone']),
    ).toEqual({ name: 'Ada Lovelace', tone: 'warm' })
    expect(
      parsePromptArguments(`'Ada Lovelace' "very \\"warm\\""`, [
        'name',
        'tone',
      ]),
    ).toEqual({ name: 'Ada Lovelace', tone: 'very "warm"' })
  })

  it('leaves out arguments nothing was typed for', () => {
    expect(parsePromptArguments('Ada', ['name', 'tone'])).toEqual({
      name: 'Ada',
    })
    expect(parsePromptArguments('  ', ['name'])).toEqual({})
    expect(parsePromptArguments('anything', [])).toEqual({})
  })
})

describe('promptMessagesToText', () => {
  it('joins the messages and marks what the assistant said', () => {
    expect(
      promptMessagesToText([
        { role: 'user', content: { type: 'text', text: 'Review this.' } },
        { role: 'assistant', content: { type: 'text', text: 'Which file?' } },
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: { uri: 'file:///a.ts', text: 'const a = 1' },
          },
        },
        {
          role: 'user',
          content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        },
      ] as Parameters<typeof promptMessagesToText>[0]),
    ).toBe(
      [
        'Review this.',
        'Assistant: Which file?',
        '<resource uri="file:///a.ts">\nconst a = 1\n</resource>',
        '[image content omitted]',
      ].join('\n\n'),
    )
  })
})

describe('MCP prompt slash commands', () => {
  it('recognises only lines that name an MCP prompt', () => {
    expect(isMcpPromptSlash('/mcp__git__review')).toBe(true)
    expect(isMcpPromptSlash('/mcp__git__review the diff\n')).toBe(true)
    expect(isMcpPromptSlash('/help')).toBe(false)
    expect(isMcpPromptSlash('look at /mcp__git__review')).toBe(false)
  })

  it('lists prompts under names that are safe to type', async () => {
    expect(await listMcpPromptSlashEntries(source())).toEqual([
      {
        name: 'mcp__my_server__greet',
        description: 'Greet someone',
        kind: 'mcp-prompt',
        argumentHint: '<name> [tone]',
        source: 'mcp',
        server: 'my server',
      },
      {
        name: 'mcp__git__review',
        description: 'Prompt from git',
        kind: 'mcp-prompt',
        argumentHint: undefined,
        source: 'mcp',
        server: 'git',
      },
    ])
  })

  it('expands a prompt with what the user typed', async () => {
    const prompts = source()
    expect(
      await resolveMcpPromptSlash('/mcp__my_server__greet Ada warm', prompts),
    ).toEqual({ text: 'Hello there' })
    expect(prompts.getPrompt).toHaveBeenCalledWith('my server', 'greet', {
      name: 'Ada',
      tone: 'warm',
    })
  })

  it('says what is missing instead of calling the server', async () => {
    const prompts = source()
    const result = await resolveMcpPromptSlash(
      '/mcp__my_server__greet',
      prompts,
    )
    expect(result).toEqual({
      error:
        '/mcp__my_server__greet needs name.\n\nUsage: /mcp__my_server__greet <name> [tone]',
    })
    expect(prompts.getPrompt).not.toHaveBeenCalled()
  })

  it('names the prompts there are when asked for one there is not', async () => {
    expect(await resolveMcpPromptSlash('/mcp__git__blame', source())).toEqual({
      error:
        'Unknown MCP prompt: /mcp__git__blame\n\nAvailable MCP prompts: /mcp__my_server__greet, /mcp__git__review',
    })
  })

  it('reports a server that fails', async () => {
    const prompts = source(async () => {
      throw new Error('boom')
    })
    expect(await resolveMcpPromptSlash('/mcp__git__review', prompts)).toEqual({
      error: 'Error running /mcp__git__review: boom',
    })
  })

  it('leaves other messages alone', async () => {
    expect(await resolveMcpPromptSlash('/help', source())).toBeNull()
  })
})
