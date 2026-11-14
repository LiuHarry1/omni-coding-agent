import { tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolUseContext } from '../../core/agent/tool-use-context.js'
import type { CanUseToolFn } from '../../core/can-use-tool.js'
import { instantiateTool } from '../../core/tool-definition.js'
import type { AnyTool, ToolContext, ToolDefinition } from '../../core/types.js'
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
