import { tool } from 'ai'
import { z } from 'zod'
import type {
  DualChannelToolResult,
  ToolDefinition,
  TodoItem,
  TodoStatus,
} from '../../core/types.js'
import { emitTodoUpdate } from '../../core/wire-internal.js'
import { TODO_WRITE_TOOL_NAME } from '../../constants/tool_names.js'
import { applyTodoWrite, isTodoListDone } from './todo-state.js'

export type TodoWriteOutput = {
  todos: TodoItem[]
  message: string
}

export const TodoWriteOutputSchema = z.object({
  todos: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
    }),
  ),
  message: z.string(),
})

function summarize(items: TodoItem[]): string {
  const counts: Record<string, number> = {}
  for (const t of items) counts[t.status] = (counts[t.status] || 0) + 1

  const parts: string[] = []
  for (const s of [
    'in_progress',
    'pending',
    'completed',
    'cancelled',
  ] as TodoStatus[]) {
    if (counts[s]) parts.push(`${counts[s]} ${s}`)
  }
  return `Updated ${items.length} todos: ${parts.join(', ')}`
}

export const definition: ToolDefinition = {
  name: TODO_WRITE_TOOL_NAME,
  description:
    'Create or update a structured task checklist to track multi-step work',
  shouldDefer: true,
  isConcurrencySafe: () => false,
  // Mode D — todos for UI/side panel; message for model
  outputSchema: TodoWriteOutputSchema,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const o = output as TodoWriteOutput
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: o.message,
    }
  },

  create(_cwd, context) {
    // The main agent's list lives on the session so it carries across turns;
    // a subagent has no session and keeps its own list for its run.
    let ownTodos: TodoItem[] = []
    const session = context.session

    return tool({
      description:
        'Create or update a structured todo list for tracking multi-step tasks. ' +
        'Use for complex work (3+ steps). Set merge=true to update existing items by id ' +
        'without replacing the full list. Keep only ONE item in_progress at a time. ' +
        'Mark items completed as you finish them.',
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              id: z
                .string()
                .describe("Unique identifier, e.g. 'setup-db', 'add-auth'"),
              content: z.string().describe('Short description of the task'),
              status: z.enum([
                'pending',
                'in_progress',
                'completed',
                'cancelled',
              ]),
            }),
          )
          .min(1),
        merge: z
          .boolean()
          .optional()
          .default(false)
          .describe('true = upsert by id; false = replace entire list'),
      }),
      execute: async ({
        todos: incoming,
        merge,
      }: {
        todos: Array<{ id: string; content: string; status: TodoStatus }>
        merge: boolean
      }) => {
        const existing = session ? (session.todos ?? []) : ownTodos
        const sorted = applyTodoWrite(existing, incoming, merge)
        // A finished list is not carried forward: the next plan starts empty.
        const kept = isTodoListDone(sorted) ? [] : sorted
        if (session) session.todos = kept
        else ownTodos = kept

        emitTodoUpdate(context.wire, context.eventBus, sorted)

        const data: TodoWriteOutput = {
          todos: sorted,
          message: summarize(sorted),
        }
        return { data } satisfies DualChannelToolResult<TodoWriteOutput>
      },
    })
  },
}
