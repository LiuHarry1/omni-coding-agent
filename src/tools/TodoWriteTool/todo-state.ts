/**
 * The todo list as the TodoWrite tool maintains it, and how to rebuild it
 * from a transcript.
 */
import {
  isRoleMessage,
  type Message,
  type TodoItem,
  type TodoStatus,
} from '../../core/types.js'
import { TODO_WRITE_TOOL_NAME } from '../../constants/tool_names.js'

const STATUS_ORDER: Record<TodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

export function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  )
}

/** The list after one TodoWrite call: upsert by id, or replace when not merging. */
export function applyTodoWrite(
  existing: readonly TodoItem[],
  incoming: ReadonlyArray<{
    id: string
    content?: string
    status?: TodoStatus
  }>,
  merge: boolean,
): TodoItem[] {
  const todos = new Map<string, TodoItem>(
    merge ? existing.map(t => [t.id, t]) : [],
  )
  for (const item of incoming) {
    const previous = todos.get(item.id)
    todos.set(item.id, {
      id: item.id,
      content: item.content ?? previous?.content ?? '',
      status: item.status ?? previous?.status ?? 'pending',
    })
  }
  return sortTodos([...todos.values()])
}

/** A list with nothing left to do; the next plan starts from empty. */
export function isTodoListDone(todos: readonly TodoItem[]): boolean {
  return todos.every(t => t.status === 'completed' || t.status === 'cancelled')
}

const STATUSES = new Set<string>(Object.keys(STATUS_ORDER))

function parseTodoList(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const out: TodoItem[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return null
    const { id, content, status } = raw as Record<string, unknown>
    if (
      typeof id !== 'string' ||
      typeof content !== 'string' ||
      typeof status !== 'string' ||
      !STATUSES.has(status)
    ) {
      return null
    }
    out.push({ id, content, status: status as TodoStatus })
  }
  return out
}

/**
 * The open todo list of a reloaded session: the list its last successful
 * TodoWrite call produced, as stored with that call's result.
 */
export function restoreTodosFromMessages(
  messages: readonly Message[],
): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (!isRoleMessage(message) || message.role !== 'tool') continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]!
      if (part.toolName !== TODO_WRITE_TOOL_NAME || part.isError === true) {
        continue
      }
      const todos = parseTodoList(
        (part.toolUseResult as { todos?: unknown } | undefined)?.todos,
      )
      if (!todos) continue
      return isTodoListDone(todos) ? [] : todos
    }
  }
  return []
}
