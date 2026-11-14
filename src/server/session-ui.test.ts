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
