import { describe, expect, it } from 'vitest'
import type {
  AnyTool,
  AssistantMessage,
  Message,
  Session,
  TodoItem,
  ToolUseContext,
} from '../../core/types.js'
import { createAttachmentMessage } from '../attachments.js'
import { expandAttachmentMessagesForAPI } from '../messages.js'
import {
  getTodoReminderAttachments,
  getTodoReminderTurnCounts,
} from './todo-reminder.js'

const text = (value: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: value }],
})

const toolCall = (toolName: string): AssistantMessage => ({
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input: {} },
  ],
})

const reasoningOnly: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'reasoning', text: 'thinking' }],
}

const turns = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => text(`turn ${i}`))

const reminder = (): Message =>
  createAttachmentMessage({ type: 'todo_reminder', content: [], itemCount: 0 })

function context(todos?: TodoItem[], withTool = true): ToolUseContext {
  return {
    cwd: '/repo',
    session: { id: 's1', messages: [], todos } as unknown as Session,
    readFileState: new Map(),
    options: { tools: withTool ? { TodoWrite: {} as AnyTool } : {} },
  }
}

describe('getTodoReminderTurnCounts', () => {
  it('counts every assistant turn when the tool was never used', () => {
    expect(getTodoReminderTurnCounts(turns(4))).toEqual({
      turnsSinceLastTodoWrite: 4,
      turnsSinceLastReminder: 4,
    })
  })

  it('does not count the turn that wrote the list', () => {
    const messages = [...turns(3), toolCall('TodoWrite'), ...turns(2)]

    expect(getTodoReminderTurnCounts(messages).turnsSinceLastTodoWrite).toBe(2)
  })

  it('counts turns since the last reminder separately', () => {
    const messages = [
      toolCall('TodoWrite'),
      ...turns(5),
      reminder(),
      ...turns(3),
    ]

    expect(getTodoReminderTurnCounts(messages)).toEqual({
      turnsSinceLastTodoWrite: 8,
      turnsSinceLastReminder: 3,
    })
  })

  it('skips turns that carry only reasoning', () => {
    const messages = [text('a'), reasoningOnly, text('b')]

    expect(getTodoReminderTurnCounts(messages).turnsSinceLastTodoWrite).toBe(2)
  })
})

describe('getTodoReminderAttachments', () => {
  const todos: TodoItem[] = [
    { id: 'a', content: 'Write the parser', status: 'in_progress' },
    { id: 'b', content: 'Add tests', status: 'pending' },
  ]

  it('reminds after ten turns without the tool, with the current list', () => {
    expect(getTodoReminderAttachments(turns(10), context(todos))).toEqual([
      {
        type: 'todo_reminder',
        content: [
          { content: 'Write the parser', status: 'in_progress' },
          { content: 'Add tests', status: 'pending' },
        ],
        itemCount: 2,
      },
    ])
  })

  it('stays quiet before ten turns', () => {
    expect(getTodoReminderAttachments(turns(9), context(todos))).toEqual([])
  })

  it('waits ten more turns after a reminder', () => {
    const recent = [...turns(10), reminder(), ...turns(9)]
    const due = [...turns(10), reminder(), ...turns(10)]

    expect(getTodoReminderAttachments(recent, context())).toEqual([])
    expect(getTodoReminderAttachments(due, context())).toHaveLength(1)
  })

  it('stays quiet when the todo tool is not available', () => {
    expect(
      getTodoReminderAttachments(turns(20), context(todos, false)),
    ).toEqual([])
  })
})

describe('todo_reminder for the model', () => {
  it('lists the open items', () => {
    const [message] = expandAttachmentMessagesForAPI([
      createAttachmentMessage({
        type: 'todo_reminder',
        content: [{ content: 'Add tests', status: 'pending' }],
        itemCount: 1,
      }),
    ])

    const rendered = JSON.stringify(message)
    expect(rendered).toContain("The TodoWrite tool hasn't been used recently.")
    expect(rendered).toContain('[1. [pending] Add tests]')
  })

  it('omits the list when there are no items', () => {
    const [message] = expandAttachmentMessagesForAPI([reminder()])

    expect(JSON.stringify(message)).not.toContain('existing contents')
  })
})
