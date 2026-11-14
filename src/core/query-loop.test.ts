import { describe, expect, it } from 'vitest'
import { query } from './query.js'
import { createQueryHarness, type StepScript } from './query-test-harness.js'
import {
  isRoleMessage,
  type AnyTool,
  type Message,
  type TodoItem,
} from './types.js'

const toolStep = (toolName: string): StepScript => ({
  toolCalls: [{ toolCallId: `call-${toolName}`, toolName, input: {} }],
})

const openTodos: TodoItem[] = [
  { id: 't1', content: 'write report', status: 'in_progress' },
  { id: 't2', content: 'send report', status: 'pending' },
]

const subtypes = (events: Array<Record<string, unknown>>) =>
  events.map(event => event.subtype)

function kickoffReminders(messages: readonly Message[]): Message[] {
  return messages.filter(
    m =>
      isRoleMessage(m) &&
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes('The user approved your plan'),
  )
}

describe('query loop: approved plan', () => {
  it('pushes the model to implement when it only replies with text', async () => {
    const h = createQueryHarness()
    h.scriptSteps(
      [toolStep('ExitPlanMode'), { text: 'Plan approved.' }, { text: 'Done.' }],
      index => {
        if (index === 0) h.eventBus.emit('plan_ready', { approved: true })
      },
    )

    const result = await query(h.options)

    expect(result.reason).toBe('completed')
    expect(h.deps.runStep).toHaveBeenCalledTimes(3)
    expect(kickoffReminders(result.messages)).toHaveLength(1)
    expect(result.finalText).toBe('Done.')
  })

  it('sends no reminder once an implementation tool has run', async () => {
    const h = createQueryHarness()
    h.scriptSteps(
      [toolStep('ExitPlanMode'), toolStep('Write'), { text: 'Done.' }],
      index => {
        if (index === 0) h.eventBus.emit('plan_ready', { approved: true })
      },
    )

    const result = await query(h.options)

    expect(result.reason).toBe('completed')
    expect(h.deps.runStep).toHaveBeenCalledTimes(3)
    expect(kickoffReminders(result.messages)).toHaveLength(0)
  })

  it('ignores a plan that was not approved', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('ExitPlanMode'), { text: 'Revising.' }], index => {
      if (index === 0) h.eventBus.emit('plan_ready', { approved: false })
    })

    const result = await query(h.options)

    expect(h.deps.runStep).toHaveBeenCalledTimes(2)
    expect(kickoffReminders(result.messages)).toHaveLength(0)
  })
})

describe('query loop: abort', () => {
  it('stops before the first step when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = createQueryHarness({ abortSignal: controller.signal })
    h.scriptSteps([])

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(h.deps.preTurn).not.toHaveBeenCalled()
    expect(h.deps.runStep).not.toHaveBeenCalled()
    expect(h.resultEvents()).toHaveLength(0)
  })

  it('stops after compaction without calling the model', async () => {
    const controller = new AbortController()
    const h = createQueryHarness({ abortSignal: controller.signal })
    h.scriptSteps([])
    h.deps.preTurn.mockImplementation(async ({ messages }) => {
      controller.abort()
      return messages
    })

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(h.deps.preTurn).toHaveBeenCalledTimes(1)
    expect(h.deps.runStep).not.toHaveBeenCalled()
    expect(h.resultEvents()).toHaveLength(0)
  })

  it('stops when the step reports an abort and leaves todos open', async () => {
    const h = createQueryHarness()
    h.scriptSteps([{ text: 'Partial ans', aborted: true }], () => {
      h.eventBus.emit('todo_update', { todos: openTodos })
    })

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(result.finalText).toBe('Partial ans')
    expect(h.deps.postTurn).not.toHaveBeenCalled()
    expect(h.resultEvents()).toHaveLength(0)
    expect(h.todoUpdates).toHaveLength(1)
  })
})

describe('query loop: step limit', () => {
  it('returns the forced summary when one is produced', async () => {
    const h = createQueryHarness({ maxSteps: 2 })
    h.scriptSteps([toolStep('Read'), toolStep('Read')], index => {
      if (index === 0) h.eventBus.emit('todo_update', { todos: openTodos })
    })
    h.deps.forceFinalAnswerOnMaxSteps.mockResolvedValue('Summary so far.')

    const result = await query(h.options)

    expect(result.reason).toBe('max_steps')
    expect(result.finalText).toBe('Summary so far.')
    expect(h.deps.runStep).toHaveBeenCalledTimes(2)
    expect(h.deps.forceFinalAnswerOnMaxSteps).toHaveBeenCalledTimes(1)
    expect(subtypes(h.resultEvents())).toEqual(['success'])
    // Seed update, then the auto-complete on exit.
    expect(h.todoUpdates).toHaveLength(2)
  })

  it('reports an error when no summary is produced', async () => {
    const h = createQueryHarness({ maxSteps: 1 })
    h.scriptSteps([toolStep('Read')])

    const result = await query(h.options)

    expect(result.reason).toBe('max_steps')
    expect(subtypes(h.resultEvents())).toEqual(['error', 'success'])
    expect(h.resultEvents()[0]).toMatchObject({
      error: 'Reached max steps (1)',
    })
  })

  it('does not force a summary when the last allowed step finishes the turn', async () => {
    const h = createQueryHarness({ maxSteps: 2 })
    h.scriptSteps([toolStep('Read'), { text: 'Done.' }])

    const result = await query(h.options)

    expect(result.reason).toBe('completed')
    expect(h.deps.forceFinalAnswerOnMaxSteps).not.toHaveBeenCalled()
  })
})

describe('query loop: permission mode change', () => {
  const tool = {} as AnyTool

  it('swaps the tool set at once and the system prompt for the next step', async () => {
    const toolsSeen: string[][] = []
    const h = createQueryHarness({
      tools: { Read: tool, Write: tool },
      refreshTools: () => ({ Read: tool, ExitPlanMode: tool }),
      refreshSystemPrompt: async () => 'plan-mode system',
    })
    h.scriptSteps(
      [toolStep('EnterPlanMode'), { text: 'Done.' }],
      (index, args) => {
        if (index === 0) {
          h.eventBus.emit('mode_changed', { mode: 'plan' })
          toolsSeen.push(Object.keys(args.tools).sort())
        }
      },
    )

    await query(h.options)

    expect(toolsSeen).toEqual([['ExitPlanMode', 'Read']])
    const prompts = h.deps.runStep.mock.calls.map(([args]) => args.systemPrompt)
    expect(prompts).toEqual(['system', 'plan-mode system'])
    const nextTools = h.deps.runStep.mock.calls[1]![0].tools
    expect(Object.keys(nextTools).sort()).toEqual(['ExitPlanMode', 'Read'])
  })
})

describe('query loop: completion', () => {
  it('marks open todos completed and reports success once', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('TodoWrite'), { text: 'All done.' }], index => {
      if (index === 0) h.eventBus.emit('todo_update', { todos: openTodos })
    })

    const result = await query(h.options)

    expect(result.reason).toBe('completed')
    expect(result.finalText).toBe('All done.')
    expect(subtypes(h.resultEvents())).toEqual(['success'])
    expect(h.todoUpdates).toHaveLength(2)
    expect(h.todoUpdates[1]!.map(todo => todo.status)).toEqual([
      'completed',
      'completed',
    ])
  })

  it('numbers steps from zero and runs post-turn for each', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('Read'), toolStep('Read'), { text: 'Done.' }])

    await query(h.options)

    expect(h.deps.runStep.mock.calls.map(([args]) => args.step)).toEqual([
      0, 1, 2,
    ])
    expect(h.deps.postTurn.mock.calls.map(([args]) => args.step)).toEqual([
      0, 1, 2,
    ])
  })
})
