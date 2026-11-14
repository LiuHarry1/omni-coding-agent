import { describe, expect, it } from 'vitest'
import { EventBus } from '../../core/event-bus.js'
import type {
  Message,
  Session,
  TodoItem,
  ToolContext,
} from '../../core/types.js'
import { noopWireEmitter } from '../../core/wire-emitter.js'
import { definition } from './TodoWriteTool.js'
import { applyTodoWrite, restoreTodosFromMessages } from './todo-state.js'

const open: TodoItem[] = [
  { id: 'a', content: 'Write the parser', status: 'in_progress' },
  { id: 'b', content: 'Add tests', status: 'pending' },
]

function todoResult(
  todos: TodoItem[],
  options: { isError?: boolean } = {},
): Message {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'TodoWrite',
        output: { type: 'text', value: 'Updated' },
        toolUseResult: { todos, message: 'Updated' },
        ...options,
      },
    ],
  }
}

describe('applyTodoWrite', () => {
  it('replaces the list when not merging', () => {
    const next = applyTodoWrite(
      open,
      [{ id: 'c', content: 'Ship', status: 'pending' }],
      false,
    )

    expect(next).toEqual([{ id: 'c', content: 'Ship', status: 'pending' }])
  })

  it('upserts by id when merging and keeps active items first', () => {
    const next = applyTodoWrite(
      open,
      [
        { id: 'a', status: 'completed' },
        { id: 'b', status: 'in_progress' },
      ],
      true,
    )

    expect(next).toEqual([
      { id: 'b', content: 'Add tests', status: 'in_progress' },
      { id: 'a', content: 'Write the parser', status: 'completed' },
    ])
  })
})

describe('restoreTodosFromMessages', () => {
  it('takes the list from the last successful TodoWrite result', () => {
    const older: TodoItem[] = [{ id: 'x', content: 'Old', status: 'pending' }]

    expect(
      restoreTodosFromMessages([todoResult(older), todoResult(open)]),
    ).toEqual(open)
  })

  it('ignores a TodoWrite call that failed', () => {
    const messages = [todoResult(open), todoResult([], { isError: true })]

    expect(restoreTodosFromMessages(messages)).toEqual(open)
  })

  it('is empty when the last list was finished', () => {
    const finished: TodoItem[] = [
      { id: 'a', content: 'Write the parser', status: 'completed' },
      { id: 'b', content: 'Add tests', status: 'cancelled' },
    ]

    expect(
      restoreTodosFromMessages([todoResult(open), todoResult(finished)]),
    ).toEqual([])
  })

  it('is empty for a session that never used the tool', () => {
    expect(restoreTodosFromMessages([{ role: 'user', content: 'hi' }])).toEqual(
      [],
    )
  })
})

describe('TodoWrite and the session list', () => {
  type Execute = (input: {
    todos: Array<{ id: string; content: string; status: TodoItem['status'] }>
    merge: boolean
  }) => Promise<{ data: { todos: TodoItem[] } }>

  function createTool(session?: Session) {
    const eventBus = new EventBus()
    const context = {
      eventBus,
      wire: noopWireEmitter,
      session,
    } as unknown as ToolContext
    const created = definition.create('/repo', context) as unknown as {
      execute: Execute
    }
    return { execute: created.execute, context }
  }

  it('carries the list into a tool created for a later turn', async () => {
    const session = { id: 's1', messages: [] } as unknown as Session

    await createTool(session).execute({ todos: open, merge: false })
    const { data } = await createTool(session).execute({
      todos: [{ id: 'a', content: 'Write the parser', status: 'completed' }],
      merge: true,
    })

    expect(data.todos.map(todo => todo.id)).toEqual(['b', 'a'])
    expect(session.todos).toEqual(data.todos)
  })

  it('reports a finished list but does not carry it forward', async () => {
    const session = { id: 's1', messages: [] } as unknown as Session
    const { execute } = createTool(session)

    await execute({ todos: open, merge: false })
    const { data } = await execute({
      todos: open.map(todo => ({ ...todo, status: 'completed' as const })),
      merge: true,
    })

    expect(data.todos).toHaveLength(2)
    expect(session.todos).toEqual([])
  })

  it('keeps a list of its own when there is no session', async () => {
    const { execute } = createTool()

    await execute({ todos: open, merge: false })
    const { data } = await execute({
      todos: [{ id: 'c', content: 'Ship', status: 'pending' }],
      merge: true,
    })

    expect(data.todos.map(todo => todo.id)).toEqual(['a', 'b', 'c'])
  })
})
