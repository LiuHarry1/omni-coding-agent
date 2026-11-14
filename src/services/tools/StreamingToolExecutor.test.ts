import { tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolUseContext } from '../../core/agent/tool-use-context.js'
import type { CanUseToolFn } from '../../core/can-use-tool.js'
import { instantiateTool } from '../../core/tool-definition.js'
import type { HookRunner } from '../../core/hooks/hooks.js'
import type { AggregatedHookResult } from '../../core/hooks/types.js'
import type {
  AnyTool,
  AttachmentMessage,
  ToolContext,
  ToolDefinition,
} from '../../core/types.js'
import { WireEmitter } from '../../core/wire-emitter.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import type { ExecutedToolResult } from './tool_execution.js'

function setup() {
  const execute = vi.fn(async ({ command }: { command: string }) => {
    return `ran ${command}`
  })
  const tools = {
    Bash: tool({
      description: 'Run a command',
      inputSchema: z.object({ command: z.string() }),
      execute,
    }),
  } as unknown as Record<string, AnyTool>
  const events: Array<Record<string, unknown>> = []
  const wire = new WireEmitter(
    {
      emit(message) {
        events.push(message as unknown as Record<string, unknown>)
      },
    },
    'test-session',
  )
  const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }))
  const executor = new StreamingToolExecutor(
    canUseTool as unknown as CanUseToolFn,
    {
      tools,
      wire,
      abortController: new AbortController(),
      concurrencyPolicy: () => false,
    } as unknown as ToolUseContext,
  )
  const settle = async (): Promise<ExecutedToolResult[]> => {
    const results: ExecutedToolResult[] = []
    for await (const result of executor.getRemainingResults()) {
      results.push(result)
    }
    return results
  }
  const toolResultEvents = () =>
    events.filter(event => event.type === 'tool_result')
  return { executor, execute, canUseTool, settle, toolResultEvents }
}

describe('StreamingToolExecutor with calls the SDK rejected', () => {
  it('reports invalid arguments without asking permission or running', async () => {
    const { executor, execute, canUseTool, settle, toolResultEvents } = setup()
    executor.addTool({
      toolCallId: 'c1',
      toolName: 'Bash',
      input: { cmd: 'ls' },
      unvalidated: true,
    })

    const results = await settle()

    expect(execute).not.toHaveBeenCalled()
    expect(canUseTool).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'c1', isError: true })
    expect(results[0]!.result).toContain('`command` is missing')
    expect(toolResultEvents()).toEqual([
      expect.objectContaining({ tool_use_id: 'c1', is_error: true }),
    ])
  })

  it('runs a misspelled tool name once its arguments check out', async () => {
    const { executor, execute, settle } = setup()
    executor.addTool({
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
      unvalidated: true,
    })

    const results = await settle()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        toolName: 'Bash',
        result: 'ran ls',
      }),
    ])
  })

  it('reports an unknown tool on the wire', async () => {
    const { executor, settle, toolResultEvents } = setup()
    executor.addTool({
      toolCallId: 'c1',
      toolName: 'Teleport',
      input: {},
      unvalidated: true,
    })

    const results = await settle()

    expect(results).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'Teleport',
        result: 'Error: No such tool available: Teleport',
        isError: true,
      },
    ])
    expect(toolResultEvents()).toEqual([
      expect.objectContaining({
        tool_use_id: 'c1',
        result: 'Error: No such tool available: Teleport',
        is_error: true,
      }),
    ])
  })
})

describe('StreamingToolExecutor and a tool that checks its own input', () => {
  function setupWithValidation(
    validateInput: NonNullable<ToolDefinition['validateInput']>,
  ) {
    const execute = vi.fn(async () => 'edited')
    const definition: ToolDefinition = {
      name: 'Edit',
      description: 'Edit a file',
      validateInput,
      create: () =>
        tool({
          description: 'Edit a file',
          inputSchema: z.object({ file_path: z.string() }),
          execute,
        }) as unknown as AnyTool,
    }
    const order: string[] = []
    const canUseTool = vi.fn(async () => {
      order.push('permission')
      return { behavior: 'allow' as const }
    })
    const executor = new StreamingToolExecutor(
      canUseTool as unknown as CanUseToolFn,
      {
        tools: {
          Edit: instantiateTool(definition, '/repo', {} as ToolContext),
        },
        wire: new WireEmitter({ emit() {} }, 'test-session'),
        abortController: new AbortController(),
        concurrencyPolicy: () => false,
      } as unknown as ToolUseContext,
    )
    const settle = async (): Promise<ExecutedToolResult[]> => {
      const results: ExecutedToolResult[] = []
      for await (const result of executor.getRemainingResults()) {
        results.push(result)
      }
      return results
    }
    return { executor, execute, canUseTool, settle, order }
  }

  it('returns the reason without asking permission or running', async () => {
    const { executor, execute, canUseTool, settle } = setupWithValidation(
      () => ({ result: false, message: 'Error: file not found: a.ts' }),
    )
    executor.addTool({
      toolCallId: 'c1',
      toolName: 'Edit',
      input: { file_path: 'a.ts' },
    })

    const results = await settle()

    expect(canUseTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        isError: true,
        result: 'Error: file not found: a.ts',
      }),
    ])
  })

  it('checks the input before the permission prompt', async () => {
    const { executor, execute, settle, order } = setupWithValidation(() => {
      order.push('validate')
      return { result: true }
    })
    executor.addTool({
      toolCallId: 'c1',
      toolName: 'Edit',
      input: { file_path: 'a.ts' },
    })

    await settle()

    expect(order).toEqual(['validate', 'permission'])
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('StreamingToolExecutor with hooks', () => {
  const emptyHookResult = (hookName: string): AggregatedHookResult => ({
    hookName,
    blockingErrors: [],
    additionalContexts: [],
    outputs: [],
    preventContinuation: false,
    systemMessages: [],
  })

  /** A Bash tool behind hooks whose answers the test supplies. */
  function setupWithHooks(answers: {
    pre?: Partial<AggregatedHookResult>
    post?: Partial<AggregatedHookResult>
    execute?: (input: { command: string }) => Promise<string>
  }) {
    const order: string[] = []
    const execute = vi.fn(async (input: { command: string }) => {
      order.push('execute')
      if (answers.execute) return answers.execute(input)
      return `ran ${input.command}`
    })
    const canUseTool = vi.fn(async () => {
      order.push('permission')
      return { behavior: 'allow' as const }
    })
    const hooks: HookRunner = {
      has: event =>
        (event === 'PreToolUse' && answers.pre !== undefined) ||
        (event === 'PostToolUse' && answers.post !== undefined),
      preToolUse: vi.fn(async () => {
        order.push('pre')
        return { ...emptyHookResult('PreToolUse:Bash'), ...answers.pre }
      }),
      postToolUse: vi.fn(async () => {
        order.push('post')
        return { ...emptyHookResult('PostToolUse:Bash'), ...answers.post }
      }),
      userPromptSubmit: async () => emptyHookResult('UserPromptSubmit'),
      stop: async () => emptyHookResult('Stop'),
    }
    const executor = new StreamingToolExecutor(
      canUseTool as unknown as CanUseToolFn,
      {
        tools: {
          Bash: tool({
            description: 'Run a command',
            inputSchema: z.object({ command: z.string() }),
            execute,
          }),
        },
        wire: new WireEmitter({ emit() {} }, 'test-session'),
        abortController: new AbortController(),
        concurrencyPolicy: () => false,
        hooks,
      } as unknown as ToolUseContext,
    )
    const run = async (command = 'npm test'): Promise<ExecutedToolResult> => {
      executor.addTool({
        toolCallId: 'c1',
        toolName: 'Bash',
        input: { command },
      })
      const results: ExecutedToolResult[] = []
      for await (const result of executor.getRemainingResults()) {
        results.push(result)
      }
      return results[0]!
    }
    return { run, execute, canUseTool, hooks, order }
  }

  const attachments = (result: ExecutedToolResult) =>
    (result.followUpMessages ?? []).map(
      message => (message as AttachmentMessage).attachment,
    )

  it('runs PreToolUse before the permission check and PostToolUse after the tool', async () => {
    const { run, hooks, order } = setupWithHooks({ pre: {}, post: {} })

    const result = await run()

    expect(order).toEqual(['pre', 'permission', 'execute', 'post'])
    expect(hooks.preToolUse).toHaveBeenCalledWith(
      {
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        toolUseId: 'c1',
      },
      expect.anything(),
    )
    expect(hooks.postToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
        toolResponse: 'ran npm test',
      }),
      expect.anything(),
    )
    expect(result).toMatchObject({ result: 'ran npm test' })
    expect(result.isError).toBeFalsy()
    expect(result.followUpMessages).toBeUndefined()
  })

  it('does not run a tool a PreToolUse hook blocked', async () => {
    const { run, execute, canUseTool } = setupWithHooks({
      pre: {
        blockingErrors: [
          { blockingError: '[guard]: no tests on Friday', command: 'guard' },
        ],
      },
    })

    const result = await run()

    expect(canUseTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      isError: true,
      result: 'PreToolUse:Bash hook error: [guard]: no tests on Friday',
    })
    expect(result.preventContinuation).toBeUndefined()
  })

  it('does not run a tool a PreToolUse hook denied', async () => {
    const { run, execute } = setupWithHooks({
      pre: { permissionBehavior: 'deny', permissionReason: 'not in CI' },
    })

    const result = await run()

    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      isError: true,
      result: 'PreToolUse:Bash hook error: not in CI',
    })
  })

  it('runs the tool with the input a PreToolUse hook rewrote', async () => {
    const { run, execute, canUseTool } = setupWithHooks({
      pre: { updatedInput: { command: 'npm test -- --run' } },
    })

    const result = await run()

    // The permission check sees what will actually run.
    expect(canUseTool).toHaveBeenCalledWith(
      'Bash',
      { command: 'npm test -- --run' },
      expect.anything(),
    )
    expect(execute).toHaveBeenCalledWith(
      { command: 'npm test -- --run' },
      expect.anything(),
    )
    expect(result.result).toBe('ran npm test -- --run')
  })

  it('refuses rewritten input that does not fit the tool', async () => {
    const { run, execute, canUseTool } = setupWithHooks({
      pre: { updatedInput: { cmd: 'npm test' } },
    })

    const result = await run()

    expect(canUseTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it.each(['allow', 'ask'] as const)(
    'hands a hook decision of %s to the permission check',
    async behavior => {
      const { run, canUseTool } = setupWithHooks({
        pre: { permissionBehavior: behavior, permissionReason: 'policy' },
      })

      await run()

      expect(canUseTool).toHaveBeenCalledWith(
        'Bash',
        { command: 'npm test' },
        {
          toolUseId: 'c1',
          hookPermission: { behavior, reason: 'policy' },
        },
      )
    },
  )

  it('ends the turn without running the tool when PreToolUse says stop', async () => {
    const { run, execute } = setupWithHooks({
      pre: { preventContinuation: true, stopReason: 'Budget used up' },
    })

    const result = await run()

    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      isError: true,
      preventContinuation: 'Budget used up',
    })
    expect(attachments(result)).toEqual([
      {
        type: 'hook_stopped_continuation',
        hookName: 'PreToolUse:Bash',
        message: 'Budget used up',
      },
    ])
  })

  it('puts PreToolUse context after the tool result', async () => {
    const { run } = setupWithHooks({
      pre: { additionalContexts: ['Tests take about a minute.'] },
    })

    const result = await run()

    expect(result.result).toBe('ran npm test')
    expect(attachments(result)).toEqual([
      {
        type: 'hook_additional_context',
        hookName: 'PreToolUse:Bash',
        content: ['Tests take about a minute.'],
      },
    ])
  })

  it('keeps the tool result and adds what a PostToolUse hook objected to', async () => {
    const { run } = setupWithHooks({
      post: {
        blockingErrors: [
          { blockingError: '[lint]: 2 errors in a.ts', command: 'lint' },
        ],
        additionalContexts: ['Run the formatter before committing.'],
      },
    })

    const result = await run()

    expect(result.result).toBe('ran npm test')
    expect(result.isError).toBeFalsy()
    expect(attachments(result)).toEqual([
      {
        type: 'hook_blocking_error',
        hookName: 'PostToolUse:Bash',
        blockingError: {
          blockingError: '[lint]: 2 errors in a.ts',
          command: 'lint',
        },
      },
      {
        type: 'hook_additional_context',
        hookName: 'PostToolUse:Bash',
        content: ['Run the formatter before committing.'],
      },
    ])
  })

  it('ends the turn after the tool when PostToolUse says stop', async () => {
    const { run } = setupWithHooks({
      post: { preventContinuation: true },
    })

    const result = await run()

    expect(result.result).toBe('ran npm test')
    expect(result.preventContinuation).toBe('Execution stopped by hook')
  })

  it('skips PostToolUse for a tool that failed', async () => {
    const { run, hooks } = setupWithHooks({
      post: {},
      execute: async () => {
        throw new Error('command not found')
      },
    })

    const result = await run()

    expect(result.isError).toBe(true)
    expect(hooks.postToolUse).not.toHaveBeenCalled()
  })

  it('skips PostToolUse when permission was refused', async () => {
    const { run, hooks, canUseTool, execute } = setupWithHooks({ post: {} })
    canUseTool.mockResolvedValueOnce({
      behavior: 'deny',
      message: 'User rejected Bash command npm test.',
    } as never)

    const result = await run()

    expect(execute).not.toHaveBeenCalled()
    expect(hooks.postToolUse).not.toHaveBeenCalled()
    expect(result.result).toBe('User rejected Bash command npm test.')
  })
})
