import { describe, expect, it } from 'vitest'
import { query } from './query.js'
import { createQueryHarness, type StepScript } from './query-test-harness.js'
import type { IProvider } from './llm/types.js'
import type { AnyTool, TodoItem } from './types.js'

const toolStep = (toolName: string): StepScript => ({
  toolCalls: [{ toolCallId: `call-${toolName}`, toolName, input: {} }],
})

const openTodos: TodoItem[] = [
  { id: 't1', content: 'write report', status: 'in_progress' },
  { id: 't2', content: 'send report', status: 'pending' },
]

const subtypes = (events: Array<Record<string, unknown>>) =>
  events.map(event => event.subtype)

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

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([
      { reason: 'next_turn' },
      { reason: 'plan_build_kickoff' },
    ])
    // The reminder sits between the text-only reply and the final step.
    expect(result.messages.at(-2)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('The user approved your plan'),
    })
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

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([
      { reason: 'next_turn' },
      { reason: 'next_turn' },
    ])
  })

  it('sends no reminder when the approving step also started implementing', async () => {
    const h = createQueryHarness()
    h.scriptSteps(
      [
        {
          toolCalls: [
            ...toolStep('ExitPlanMode').toolCalls!,
            ...toolStep('TodoWrite').toolCalls!,
          ],
        },
        { text: 'Done.' },
      ],
      index => {
        if (index === 0) h.eventBus.emit('plan_ready', { approved: true })
      },
    )

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([{ reason: 'next_turn' }])
  })

  it('ignores a plan that was not approved', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('ExitPlanMode'), { text: 'Revising.' }], index => {
      if (index === 0) h.eventBus.emit('plan_ready', { approved: false })
    })

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([{ reason: 'next_turn' }])
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
    expect(result.terminal).toEqual({ reason: 'aborted_streaming' })
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

    expect(result.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(h.deps.preTurn).toHaveBeenCalledTimes(1)
    expect(h.deps.runStep).not.toHaveBeenCalled()
    expect(h.resultEvents()).toHaveLength(0)
  })

  it('stops when the step reports an abort and leaves todos open', async () => {
    const h = createQueryHarness()
    h.scriptSteps(
      [{ text: 'Partial ans', aborted: true, abortPhase: 'streaming' }],
      () => {
        h.eventBus.emit('todo_update', { todos: openTodos })
      },
    )

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(result.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(result.finalText).toBe('Partial ans')
    expect(h.deps.postTurn).not.toHaveBeenCalled()
    expect(h.resultEvents()).toHaveLength(0)
    expect(h.todoUpdates).toHaveLength(1)
  })

  it('tells an abort after the tools ran from one mid-response', async () => {
    const h = createQueryHarness()
    h.scriptSteps([{ ...toolStep('Bash'), aborted: true, abortPhase: 'tools' }])

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(result.terminal).toEqual({ reason: 'aborted_tools' })
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
    expect(result.terminal).toEqual({
      reason: 'max_turns',
      turnCount: 3,
      summarized: true,
    })
    expect(result.finalText).toBe('Summary so far.')
    expect(h.deps.runStep).toHaveBeenCalledTimes(2)
    expect(h.deps.forceFinalAnswerOnMaxSteps).toHaveBeenCalledTimes(1)
    expect(subtypes(h.resultEvents())).toEqual(['success'])
    // Only the seed update: running out of steps does not finish the work.
    expect(h.todoUpdates).toHaveLength(1)
  })

  it('reports an error when no summary is produced', async () => {
    const h = createQueryHarness({ maxSteps: 1 })
    h.scriptSteps([toolStep('Read')], () => {
      h.eventBus.emit('todo_update', { todos: openTodos })
    })

    const result = await query(h.options)

    expect(result.reason).toBe('max_steps')
    expect(result.terminal).toEqual({
      reason: 'max_turns',
      turnCount: 2,
      summarized: false,
    })
    expect(h.resultEvents()).toEqual([
      expect.objectContaining({
        subtype: 'error',
        error: 'Reached max steps (1)',
      }),
    ])
    expect(h.todoUpdates).toHaveLength(1)
  })

  it('does not force a summary when the last allowed step finishes the turn', async () => {
    const h = createQueryHarness({ maxSteps: 2 })
    h.scriptSteps([toolStep('Read'), { text: 'Done.' }])

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(h.deps.forceFinalAnswerOnMaxSteps).not.toHaveBeenCalled()
  })
})

describe('query loop: failed request', () => {
  const failed: StepScript = {
    completedCleanly: false,
    completionError: 'Upstream stream failed: 502. Try again.',
  }

  it('reports one error and leaves todos open', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('TodoWrite'), failed], index => {
      if (index === 0) h.eventBus.emit('todo_update', { todos: openTodos })
    })

    const result = await query(h.options)

    expect(result.reason).toBe('error')
    expect(result.terminal).toEqual({
      reason: 'model_error',
      error: 'Upstream stream failed: 502. Try again.',
    })
    expect(h.resultEvents()).toEqual([
      expect.objectContaining({
        subtype: 'error',
        error: 'Upstream stream failed: 502. Try again.',
      }),
    ])
    expect(h.todoUpdates).toHaveLength(1)
  })

  it('counts as an abort when the user stopped the turn meanwhile', async () => {
    const controller = new AbortController()
    const h = createQueryHarness({ abortSignal: controller.signal })
    h.scriptSteps([failed], () => controller.abort())

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(h.resultEvents()).toHaveLength(0)
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

  const promptsAfterModeChange = async (
    refreshSystemPrompt: () => Promise<string>,
  ) => {
    const h = createQueryHarness({ refreshSystemPrompt })
    h.scriptSteps(
      [toolStep('EnterPlanMode'), toolStep('Read'), { text: 'Done.' }],
      index => {
        if (index === 0) h.eventBus.emit('mode_changed', { mode: 'plan' })
      },
    )
    const result = await query(h.options)
    return {
      result,
      prompts: h.deps.runStep.mock.calls.map(([args]) => args.systemPrompt),
      preTurnPrompts: h.deps.preTurn.mock.calls.map(
        ([args]) => args.systemPrompt,
      ),
    }
  }

  it('waits for a slow system prompt refresh before the next request', async () => {
    let refreshes = 0
    const { prompts, preTurnPrompts } = await promptsAfterModeChange(
      async () => {
        refreshes++
        await new Promise(resolve => setTimeout(resolve, 20))
        return 'plan-mode system'
      },
    )

    expect(prompts).toEqual(['system', 'plan-mode system', 'plan-mode system'])
    expect(preTurnPrompts).toEqual(prompts)
    expect(refreshes).toBe(1)
  })

  it('keeps the previous system prompt when the refresh fails', async () => {
    const { result, prompts } = await promptsAfterModeChange(async () => {
      throw new Error('settings unreadable')
    })

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(prompts).toEqual(['system', 'system', 'system'])
  })
})

describe('query loop: model fallback', () => {
  const fallbackProvider = {
    defaultModelId: () => 'fallback-model',
  } as unknown as IProvider

  it('stays on the fallback model once a step has switched to it', async () => {
    const turnEnds: Array<{ model: string }> = []
    const h = createQueryHarness({
      fallbackProvider,
      sessionId: 'test-session',
      onTurnEnd: snapshot => turnEnds.push(snapshot),
    })
    h.scriptSteps([
      { ...toolStep('Read'), modelFallback: true },
      toolStep('Read'),
      { text: 'Done.' },
    ])

    await query(h.options)

    const requests = h.deps.runStep.mock.calls.map(([args]) => ({
      model: args.resolvedModel,
      canFallBack: args.fallback !== undefined,
    }))
    expect(requests).toEqual([
      { model: 'test-model', canFallBack: true },
      { model: 'fallback-model', canFallBack: false },
      { model: 'fallback-model', canFallBack: false },
    ])
    // The step that switched is committed under the model that answered it.
    expect(
      h.deps.postTurn.mock.calls.map(([args]) => args.resolvedModel),
    ).toEqual(['fallback-model', 'fallback-model', 'fallback-model'])
    expect(turnEnds.map(snapshot => snapshot.model)).toEqual(['fallback-model'])
  })

  it('reports the fallback model when the switching step ends the turn', async () => {
    const turnEnds: Array<{ model: string }> = []
    const h = createQueryHarness({
      fallbackProvider,
      sessionId: 'test-session',
      onTurnEnd: snapshot => turnEnds.push(snapshot),
    })
    h.scriptSteps([{ text: 'Done.', modelFallback: true }])

    await query(h.options)

    expect(turnEnds.map(snapshot => snapshot.model)).toEqual(['fallback-model'])
  })

  it('sizes a continuation for the fallback model, not the one left behind', async () => {
    const h = createQueryHarness({
      fallbackProvider: {
        defaultModelId: () => 'fallback-model',
        maxOutputTokenCap: () => 32_000,
      } as unknown as IProvider,
      provider: { maxOutputTokenCap: () => 128_000 },
    })
    h.scriptSteps([
      { text: 'part one', truncated: true },
      { text: 'part two', truncated: true, modelFallback: true },
      { text: 'part three' },
    ])

    await query(h.options)

    expect(
      h.deps.runStep.mock.calls.map(([args]) => args.maxOutputTokensOverride),
    ).toEqual([undefined, 65_536, 32_000])
  })

  it('offers no fallback when none is configured', async () => {
    const h = createQueryHarness()
    h.scriptSteps([{ text: 'Done.' }])

    await query(h.options)

    expect(h.deps.runStep.mock.calls[0]![0].fallback).toBeUndefined()
  })
})

describe('query loop: completion', () => {
  it('reports success once and leaves open todos as the model wrote them', async () => {
    const h = createQueryHarness()
    h.scriptSteps([toolStep('TodoWrite'), { text: 'All done.' }], index => {
      if (index === 0) h.eventBus.emit('todo_update', { todos: openTodos })
    })

    const result = await query(h.options)

    expect(result.reason).toBe('completed')
    expect(result.finalText).toBe('All done.')
    expect(subtypes(h.resultEvents())).toEqual(['success'])
    expect(h.todoUpdates).toEqual([openTodos])
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
