import { describe, expect, it } from 'vitest'
import { query } from './query.js'
import { createQueryHarness, type StepScript } from './query-test-harness.js'
import type { HookRunner } from './hooks/hooks.js'
import type { AggregatedHookResult } from './hooks/types.js'
import type { IProvider } from './llm/types.js'
import type { AnyTool, AttachmentMessage, TodoItem } from './types.js'

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

describe('query loop: hooks', () => {
  const hookResult = (
    hookName: string,
    overrides: Partial<AggregatedHookResult> = {},
  ): AggregatedHookResult => ({
    hookName,
    blockingErrors: [],
    additionalContexts: [],
    outputs: [],
    preventContinuation: false,
    systemMessages: [],
    ...overrides,
  })

  /** Hooks whose Stop answers come from a list, one per time the model ends. */
  function stopHooks(answers: Array<Partial<AggregatedHookResult>>) {
    const seenActive: boolean[] = []
    const hooks: HookRunner = {
      has: event => event === 'Stop',
      preToolUse: async () => hookResult('PreToolUse'),
      postToolUse: async () => hookResult('PostToolUse'),
      userPromptSubmit: async () => hookResult('UserPromptSubmit'),
      stop: async stopHookActive => {
        seenActive.push(stopHookActive)
        return hookResult('Stop', answers[seenActive.length - 1])
      },
    }
    return { hooks, seenActive }
  }

  const blocking = (text: string): Partial<AggregatedHookResult> => ({
    blockingErrors: [{ blockingError: text, command: 'check' }],
  })

  it('ends the turn when the Stop hook has no objection', async () => {
    const { hooks, seenActive } = stopHooks([{}])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([{ text: 'Done.' }])

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(seenActive).toEqual([false])
    expect(h.deps.runStep).toHaveBeenCalledTimes(1)
  })

  it('sends the model back to work with the Stop hook feedback', async () => {
    const { hooks, seenActive } = stopHooks([
      blocking('[check]: tests are failing'),
      {},
    ])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([{ text: 'Done.' }, { text: 'Fixed the tests.' }])

    const result = await query(h.options)

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.transitions).toEqual([{ reason: 'stop_hook_blocking' }])
    expect(result.messages.at(-2)).toMatchObject({
      role: 'user',
      isMeta: true,
      content: 'Stop hook feedback:\n[check]: tests are failing',
    })
    expect(result.finalText).toBe('Fixed the tests.')
    // The second run of the hook is told it already sent the model back.
    expect(seenActive).toEqual([false, true])
    expect(h.resultEvents()).toHaveLength(1)
  })

  it('keeps telling the Stop hook it is active through the tool steps that follow its feedback', async () => {
    const { hooks, seenActive } = stopHooks([blocking('add a test'), {}, {}])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([
      { text: 'Done.' },
      toolStep('Write'),
      { text: 'Added a test.' },
    ])

    const result = await query(h.options)

    expect(result.transitions).toEqual([
      { reason: 'stop_hook_blocking' },
      { reason: 'next_turn' },
    ])
    // The tool step is still the model answering the hook's feedback.
    expect(seenActive).toEqual([false, true])
  })

  it('does not run the Stop hook after a step that called tools', async () => {
    const { hooks, seenActive } = stopHooks([{}])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([toolStep('Read'), { text: 'Done.' }])

    await query(h.options)

    expect(seenActive).toEqual([false])
  })

  it('ends the turn with the reason when the Stop hook says stop', async () => {
    const { hooks } = stopHooks([
      { preventContinuation: true, stopReason: 'Budget used up' },
    ])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([{ text: 'Done.' }])

    const result = await query(h.options)

    expect(result.terminal).toEqual({
      reason: 'stop_hook_prevented',
      notice: 'Stopped by hook: Budget used up',
    })
    expect(result.reason).toBe('completed')
    expect(result.messages.at(-1)).toMatchObject({
      type: 'attachment',
      attachment: {
        type: 'hook_stopped_continuation',
        hookName: 'Stop',
        message: 'Budget used up',
      },
    })
    // The user is told why, then the turn ends once and successfully.
    expect(JSON.stringify(h.events)).toContain(
      'Stopped by hook: Budget used up',
    )
    expect(h.resultEvents()).toEqual([
      expect.objectContaining({ subtype: 'success', reason: 'done' }),
    ])
  })

  it('stopping wins over feedback when a Stop hook gives both', async () => {
    const { hooks } = stopHooks([
      { ...blocking('keep going'), preventContinuation: true },
    ])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([{ text: 'Done.' }])

    const result = await query(h.options)

    expect(result.terminal.reason).toBe('stop_hook_prevented')
    expect(h.deps.runStep).toHaveBeenCalledTimes(1)
  })

  it('treats an abort during the Stop hook as an abort', async () => {
    const controller = new AbortController()
    const hooks: HookRunner = {
      ...stopHooks([]).hooks,
      stop: async () => {
        controller.abort()
        return hookResult('Stop', blocking('keep going'))
      },
    }
    const h = createQueryHarness({ hooks, abortSignal: controller.signal })
    h.scriptSteps([{ text: 'Done.' }])

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(h.deps.runStep).toHaveBeenCalledTimes(1)
  })

  it('ends the turn after a step in which a tool hook said stop', async () => {
    const { hooks, seenActive } = stopHooks([{}])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([{ ...toolStep('Bash'), hookStopped: 'Too many edits' }])

    const result = await query(h.options)

    expect(result.terminal).toEqual({
      reason: 'hook_stopped',
      notice: 'Stopped by hook: Too many edits',
    })
    expect(result.reason).toBe('completed')
    expect(h.deps.runStep).toHaveBeenCalledTimes(1)
    // The step is committed like any other before the turn ends.
    expect(h.deps.postTurn).toHaveBeenCalledTimes(1)
    expect(seenActive).toEqual([])
    expect(h.resultEvents()).toEqual([
      expect.objectContaining({ subtype: 'success', reason: 'done' }),
    ])
  })

  it('hands the hooks to every step', async () => {
    const { hooks } = stopHooks([{}])
    const h = createQueryHarness({ hooks })
    h.scriptSteps([toolStep('Read'), { text: 'Done.' }])

    await query(h.options)

    for (const [args] of h.deps.runStep.mock.calls) {
      expect(args.hooks).toBe(hooks)
    }
  })
})

describe('query loop: tool use summaries', () => {
  const summarizer = {
    provider: { defaultModelId: () => 'small-model' } as IProvider,
    model: 'small-model',
  }

  const readStep = (id: string, file: string): StepScript => ({
    text: `Reading ${file}`,
    toolCalls: [
      { toolCallId: id, toolName: 'Read', input: { file_path: file } },
    ],
    toolResults: [
      { toolCallId: id, toolName: 'Read', result: `contents of ${file}` },
    ],
  })

  const summaryEvents = (events: Array<Record<string, unknown>>) =>
    events.filter(event => event.subtype === 'tool_use_summary')

  const summaryAttachments = (messages: unknown[]) =>
    (messages as AttachmentMessage[])
      .filter(message => message.attachment?.type === 'tool_use_summary')
      .map(message => message.attachment)

  it('labels each batch of tool calls and reports it before the turn ends', async () => {
    const h = createQueryHarness({ toolUseSummary: summarizer })
    h.deps.generateToolUseSummary.mockImplementation(
      async ({ tools }) =>
        `Read ${(tools[0]!.input as { file_path: string }).file_path}`,
    )
    h.scriptSteps([
      readStep('call-1', 'a.ts'),
      readStep('call-2', 'b.ts'),
      { text: 'Done.' },
    ])

    const result = await query(h.options)

    expect(h.deps.generateToolUseSummary).toHaveBeenCalledTimes(2)
    expect(h.deps.generateToolUseSummary.mock.calls[0]![0]).toMatchObject({
      tools: [
        {
          name: 'Read',
          input: { file_path: 'a.ts' },
          output: 'contents of a.ts',
        },
      ],
      provider: summarizer.provider,
      model: 'small-model',
      lastAssistantText: 'Reading a.ts',
    })
    expect(summaryEvents(h.events)).toMatchObject([
      { summary: 'Read a.ts', preceding_tool_use_ids: ['call-1'] },
      { summary: 'Read b.ts', preceding_tool_use_ids: ['call-2'] },
    ])
    // Kept for reloads, in the same order.
    expect(summaryAttachments(result.messages)).toEqual([
      {
        type: 'tool_use_summary',
        summary: 'Read a.ts',
        precedingToolUseIds: ['call-1'],
      },
      {
        type: 'tool_use_summary',
        summary: 'Read b.ts',
        precedingToolUseIds: ['call-2'],
      },
    ])
    // Nothing follows the result event.
    expect(h.events.at(-1)).toMatchObject({ type: 'result' })
  })

  it('does not hold the next request back while the label is written', async () => {
    const h = createQueryHarness({ toolUseSummary: summarizer })
    let finishLabel!: (label: string) => void
    h.deps.generateToolUseSummary.mockImplementation(
      () => new Promise<string | null>(resolve => (finishLabel = resolve)),
    )
    h.scriptSteps([readStep('call-1', 'a.ts'), { text: 'Done.' }], index => {
      if (index === 1) {
        // The second request is already running; the label arrives now.
        expect(summaryEvents(h.events)).toEqual([])
        finishLabel('Read a.ts')
      }
    })

    await query(h.options)

    expect(summaryEvents(h.events)).toMatchObject([{ summary: 'Read a.ts' }])
  })

  it('covers every call of a batch with one label', async () => {
    const h = createQueryHarness({ toolUseSummary: summarizer })
    h.deps.generateToolUseSummary.mockResolvedValue('Read two files')
    h.scriptSteps([
      {
        toolCalls: [
          ...readStep('call-1', 'a.ts').toolCalls!,
          ...readStep('call-2', 'b.ts').toolCalls!,
        ],
      },
      { text: 'Done.' },
    ])

    await query(h.options)

    expect(summaryEvents(h.events)).toMatchObject([
      {
        summary: 'Read two files',
        preceding_tool_use_ids: ['call-1', 'call-2'],
      },
    ])
  })

  it('writes no labels unless a summary model is given', async () => {
    const h = createQueryHarness()
    h.scriptSteps([readStep('call-1', 'a.ts'), { text: 'Done.' }])

    const result = await query(h.options)

    expect(h.deps.generateToolUseSummary).not.toHaveBeenCalled()
    expect(summaryEvents(h.events)).toEqual([])
    expect(summaryAttachments(result.messages)).toEqual([])
  })

  it.each([
    ['has nothing to say', async () => null],
    [
      'fails',
      async () => {
        throw new Error('small model unavailable')
      },
    ],
  ] as Array<[string, () => Promise<string | null>]>)(
    'carries on without a label when the summary model %s',
    async (_name, answer) => {
      const h = createQueryHarness({ toolUseSummary: summarizer })
      h.deps.generateToolUseSummary.mockImplementation(answer)
      h.scriptSteps([readStep('call-1', 'a.ts'), { text: 'Done.' }])

      const result = await query(h.options)

      expect(result.terminal).toEqual({ reason: 'completed' })
      expect(result.finalText).toBe('Done.')
      expect(summaryEvents(h.events)).toEqual([])
      expect(summaryAttachments(result.messages)).toEqual([])
    },
  )

  it('drops the label of a batch when the next step is aborted', async () => {
    const controller = new AbortController()
    const h = createQueryHarness({
      toolUseSummary: summarizer,
      abortSignal: controller.signal,
    })
    h.deps.generateToolUseSummary.mockResolvedValue('Read a.ts')
    h.scriptSteps([
      readStep('call-1', 'a.ts'),
      { aborted: true, abortPhase: 'streaming' },
    ])

    const result = await query(h.options)

    expect(result.reason).toBe('aborted')
    expect(summaryEvents(h.events)).toEqual([])
  })
})
