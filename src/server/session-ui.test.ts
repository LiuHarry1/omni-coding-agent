import { describe, expect, it } from 'vitest'
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
