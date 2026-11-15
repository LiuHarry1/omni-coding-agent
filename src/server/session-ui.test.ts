import { describe, expect, it } from 'vitest'
import { buildTruncationReminder } from '../core/query/helpers.js'
import type { Message } from '../core/types.js'
import { TODO_WRITE_TOOL_NAME } from '../constants/tool_names.js'
import { sessionToUIMessages } from './session-ui.js'

function todoRound(status: 'pending' | 'completed'): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: `todo-${status}`,
          toolName: TODO_WRITE_TOOL_NAME,
          input: {},
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `todo-${status}`,
          toolName: TODO_WRITE_TOOL_NAME,
          output: { type: 'text', value: 'Updated 1 todo' },
          toolUseResult: {
            todos: [{ id: 'one', content: 'First', status }],
            message: 'Updated 1 todo',
          },
        },
      ],
    },
  ]
}

describe('sessionToUIMessages todo hydration', () => {
  it('restores the latest persisted TodoWrite state', () => {
    const messages: Message[] = [
      { role: 'user', content: 'work' },
      ...todoRound('pending'),
      ...todoRound('completed'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]
    const ui = sessionToUIMessages(
      JSON.parse(JSON.stringify(messages)) as Message[],
    ) as Array<{ type: string; parts?: Array<Record<string, unknown>> }>
    const assistant = ui.find(message => message.type === 'assistant')
    const todos = assistant?.parts?.filter(part => part.type === 'todo_list')

    expect(todos).toHaveLength(2)
    expect(todos?.at(-1)?.todos).toEqual([
      { id: 'one', content: 'First', status: 'completed' },
    ])
  })

  it('ignores malformed persisted todo data', () => {
    const messages = todoRound('pending')
    const tool = messages[1] as Extract<Message, { role: 'tool' }>
    tool.content[0]!.toolUseResult = {
      todos: [{ id: 'one', content: 'First', status: 'invalid' }],
    }
    const ui = sessionToUIMessages(messages) as Array<{
      parts?: Array<Record<string, unknown>>
    }>
    expect(ui[0]?.parts?.some(part => part.type === 'todo_list')).toBe(false)
  })
})

describe('sessionToUIMessages output-limit continuation', () => {
  const textParts = (messages: Message[]) => {
    const ui = sessionToUIMessages(messages) as Array<{
      type: string
      parts?: Array<{ type: string; content?: string }>
    }>
    const assistants = ui.filter(message => message.type === 'assistant')
    expect(assistants).toHaveLength(1)
    return assistants[0]!.parts!.map(part => `${part.type}:${part.content}`)
  }
  const text = (value: string): Message => ({
    role: 'assistant',
    content: [{ type: 'text', text: value }],
  })

  it('rejoins a reply that was cut off and resumed', () => {
    expect(
      textParts([
        { role: 'user', content: 'write it' },
        text('Hello wor'),
        buildTruncationReminder(),
        text('ld!'),
      ]),
    ).toEqual(['text:Hello world!'])
  })

  it('keeps the resumed text apart when reasoning comes first', () => {
    expect(
      textParts([
        { role: 'user', content: 'write it' },
        text('Hello wor'),
        buildTruncationReminder(),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'picking up' },
            { type: 'text', text: 'ld!' },
          ],
        },
      ]),
    ).toEqual(['text:Hello wor', 'reasoning:picking up', 'text:ld!'])
  })

  it('does not join text across a reminder to reissue a cut tool call', () => {
    expect(
      textParts([
        { role: 'user', content: 'write it' },
        text('Writing the file.'),
        buildTruncationReminder(['Write']),
        text('Trying again.'),
      ]),
    ).toEqual(['text:Writing the file.', 'text:Trying again.'])
  })
})

describe('sessionToUIMessages and a turn a hook ended', () => {
  const stoppedBy = (hookName: string, message: string): Message => ({
    type: 'attachment',
    uuid: `stop-${hookName}`,
    timestamp: '2026-11-14T00:00:00.000Z',
    isMeta: true,
    attachment: { type: 'hook_stopped_continuation', hookName, message },
  })

  const texts = (messages: Message[]) =>
    (
      sessionToUIMessages(messages) as Array<{
        type: string
        parts?: Array<{ type: string; content?: string }>
      }>
    )
      .filter(message => message.type === 'assistant')
      .map(message =>
        (message.parts ?? [])
          .filter(part => part.type === 'text')
          .map(part => part.content),
      )

  it('shows the reason after the reply, as it was shown live', () => {
    expect(
      texts([
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        stoppedBy('Stop', 'Budget used up'),
      ]),
    ).toEqual([['Done.', 'Stopped by hook: Budget used up']])
  })

  it('shows nothing for the other hook notes', () => {
    expect(
      texts([
        { role: 'user', content: 'work' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        {
          type: 'attachment',
          uuid: 'context-1',
          timestamp: '2026-11-14T00:00:00.000Z',
          isMeta: true,
          attachment: {
            type: 'hook_additional_context',
            hookName: 'Stop',
            content: ['Use pnpm.'],
          },
        },
      ]),
    ).toEqual([['Done.']])
  })
})

describe('sessionToUIMessages and tool batch labels', () => {
  const call = (toolCallId: string) => ({
    type: 'tool-call' as const,
    toolCallId,
    toolName: 'Read',
    input: {},
  })
  const result = (toolCallId: string) => ({
    type: 'tool-result' as const,
    toolCallId,
    toolName: 'Read',
    output: { type: 'text' as const, value: 'ok' },
  })
  const label = (summary: string, ids: string[]): Message => ({
    type: 'attachment',
    uuid: `label-${ids.join('-')}`,
    timestamp: '2026-11-14T00:00:00.000Z',
    isMeta: true,
    attachment: {
      type: 'tool_use_summary',
      summary,
      precedingToolUseIds: ids,
    },
  })

  it('puts each label on the tool calls of its batch', () => {
    const ui = sessionToUIMessages([
      { role: 'user', content: 'work' },
      { role: 'assistant', content: [call('a'), call('b')] },
      { role: 'tool', content: [result('a'), result('b')] },
      { role: 'assistant', content: [call('c')] },
      { role: 'tool', content: [result('c')] },
      // Written while the second batch ran, so stored after it.
      label('Read two files', ['a', 'b']),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      label('Read config', ['c']),
    ] as Message[]) as Array<{
      type: string
      parts?: Array<{
        type: string
        toolCallId?: string
        batchSummary?: string
      }>
    }>

    const assistant = ui.filter(message => message.type === 'assistant')
    // The labels add no bubble of their own.
    expect(assistant).toHaveLength(1)
    expect(
      assistant[0]!
        .parts!.filter(part => part.type === 'tool_call')
        .map(part => [part.toolCallId, part.batchSummary]),
    ).toEqual([
      ['a', 'Read two files'],
      ['b', 'Read two files'],
      ['c', 'Read config'],
    ])
  })
})

describe('sessionToUIMessages and queued commands', () => {
  const queued = (
    attachment: Omit<
      Extract<Message, { type: 'attachment' }>['attachment'] & {
        type: 'queued_command'
      },
      'type'
    >,
  ): Message => ({
    type: 'attachment',
    uuid: `queued-${attachment.prompt}`,
    timestamp: '2026-11-14T00:00:00.000Z',
    isMeta: true,
    attachment: { type: 'queued_command', ...attachment },
  })

  const toolRound = (id: string): Message[] => [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Working on ${id}.` },
        { type: 'tool-call', toolCallId: id, toolName: 'Read', input: {} },
      ],
    } as Message,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'Read',
          output: { type: 'text', value: 'ok' },
        },
      ],
    } as Message,
  ]

  const outline = (messages: Message[]) =>
    (
      sessionToUIMessages(messages) as Array<{
        type: string
        content?: string
        queued?: boolean
        summaries?: string[]
        parts?: Array<{ type: string; content?: string }>
      }>
    ).map(message => {
      if (message.type === 'user') {
        return `user${message.queued ? '(queued)' : ''}:${message.content}`
      }
      if (message.type === 'task_notification') {
        return `notification:${message.summaries?.join('|')}`
      }
      return `${message.type}:${(message.parts ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.content)
        .join('|')}`
    })

  it('shows a message sent during the turn where the model received it', () => {
    expect(
      outline([
        { role: 'user', content: 'fix a.ts' },
        ...toolRound('call-1'),
        queued({ prompt: 'also fix b.ts', commandMode: 'prompt' }),
        ...toolRound('call-2'),
        { role: 'assistant', content: [{ type: 'text', text: 'Both done.' }] },
      ]),
    ).toEqual([
      'user:fix a.ts',
      'assistant:Working on call-1.',
      'user(queued):also fix b.ts',
      'assistant:Working on call-2.|Both done.',
    ])
  })

  it('gives that message the id rewind and fork take', () => {
    const shown = sessionToUIMessages([
      { role: 'user', content: 'fix a.ts' },
      ...toolRound('call-1'),
      queued({ prompt: 'also fix b.ts', commandMode: 'prompt' }),
    ]) as Array<{ queued?: boolean; messageId?: string }>
    expect(shown.find(message => message.queued)?.messageId).toBe(
      'queued-also fix b.ts',
    )
  })

  it('keeps system-generated queued commands out of the transcript', () => {
    expect(
      outline([
        { role: 'user', content: 'fix a.ts' },
        ...toolRound('call-1'),
        queued({
          prompt: '<task-notification>stalled</task-notification>',
          commandMode: 'task-notification',
        }),
        queued({
          prompt: 'look at src/ only',
          commandMode: 'prompt',
          isMeta: true,
          origin: { kind: 'coordinator' },
        }),
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      ]),
    ).toEqual(['user:fix a.ts', 'assistant:Working on call-1.|Done.'])
  })

  it('shows a turn started by finished background tasks as a notice', () => {
    const notification = (summary: string) =>
      `<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`

    expect(
      outline([
        { role: 'user', content: 'start the audit' },
        { role: 'assistant', content: [{ type: 'text', text: 'Launched.' }] },
        {
          role: 'user',
          isMeta: true,
          content: `${notification('Agent &quot;audit&quot; completed')}\n\n${notification('Background command &quot;npm test&quot; completed (exit code 0)')}`,
        },
        { role: 'assistant', content: [{ type: 'text', text: 'All clear.' }] },
      ]),
    ).toEqual([
      'user:start the audit',
      'assistant:Launched.',
      'notification:Agent "audit" completed|Background command "npm test" completed (exit code 0)',
      'assistant:All clear.',
    ])
  })
})
