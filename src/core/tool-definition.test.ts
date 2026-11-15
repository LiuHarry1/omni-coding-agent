import { tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import '../tools.js'
import { BROWSER_READ_ONLY_TOOL_NAMES } from '../constants/tool_names.js'
import { modeDenial } from '../utils/permissions/mode-restrictions.js'
import {
  defineTool,
  instantiateTool,
  isToolReadOnly,
  validateToolCall,
} from './tool-definition.js'
import { ToolRegistry, defaultRegistry } from './tool-registry.js'
import type { AnyTool, ToolContext, ToolDefinition } from './types.js'

const context = {} as ToolContext

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'Probe',
    description: 'A tool for tests',
    create: () =>
      tool({
        description: 'A tool for tests',
        inputSchema: z.object({ value: z.string() }),
        execute: async () => 'ok',
      }) as unknown as AnyTool,
    ...overrides,
  }
}

describe('defineTool', () => {
  it('assumes a tool is neither parallel-safe nor read-only', () => {
    const defined = defineTool(definition())

    expect(defined.isConcurrencySafe({})).toBe(false)
    expect(defined.isReadOnly()).toBe(false)
  })

  it('keeps what the definition declares', () => {
    const defined = defineTool(
      definition({ isConcurrencySafe: () => true, isReadOnly: () => true }),
    )

    expect(defined.isConcurrencySafe({})).toBe(true)
    expect(defined.isReadOnly()).toBe(true)
  })

  it('is applied to every definition the registry holds', () => {
    const registry = new ToolRegistry()
    registry.register(definition())

    expect(registry.get('Probe')?.isConcurrencySafe?.({})).toBe(false)
    expect(registry.get('Probe')?.isReadOnly?.()).toBe(false)
  })
})

describe('isToolReadOnly', () => {
  it('is false for a tool without a definition', () => {
    expect(isToolReadOnly(undefined)).toBe(false)
  })

  it('is false when the predicate throws', () => {
    const def = definition({
      isReadOnly: () => {
        throw new Error('bad input')
      },
    })

    expect(isToolReadOnly(def, {})).toBe(false)
  })

  it('answers per call when given the input', () => {
    const def = definition({
      isReadOnly: input =>
        (input as { command?: string } | undefined)?.command === 'ls',
    })

    expect(isToolReadOnly(def, { command: 'ls' })).toBe(true)
    expect(isToolReadOnly(def, { command: 'rm -rf build' })).toBe(false)
    expect(isToolReadOnly(def)).toBe(false)
  })
})

describe('validateInput bound to a tool instance', () => {
  it('receives the cwd and context the tool was created with', async () => {
    const validateInput = vi.fn(() => ({ result: true as const }))
    const instance = instantiateTool(
      definition({ validateInput }),
      '/repo',
      context,
    )

    await validateToolCall(instance, { value: 'x' })

    expect(validateInput).toHaveBeenCalledWith(
      { value: 'x' },
      { cwd: '/repo', context },
    )
  })

  it('reports why a call cannot succeed', async () => {
    const instance = instantiateTool(
      definition({
        validateInput: () => ({
          result: false,
          message: 'Error: no such file',
        }),
      }),
      '/repo',
      context,
    )

    expect(await validateToolCall(instance, {})).toEqual({
      result: false,
      message: 'Error: no such file',
    })
  })

  it('stays with the instance when its execute is wrapped', async () => {
    const instance = instantiateTool(
      definition({
        validateInput: () => ({ result: false, message: 'Error: nope' }),
      }),
      '/repo',
      context,
    )
    const wrapped = { ...instance, execute: async () => 'wrapped' } as AnyTool

    expect((await validateToolCall(wrapped, {})).result).toBe(false)
  })

  it('passes tools that have no check of their own', async () => {
    const instance = instantiateTool(definition(), '/repo', context)

    expect(await validateToolCall(instance, {})).toEqual({ result: true })
    expect(await validateToolCall(undefined, {})).toEqual({ result: true })
  })

  it('turns a throwing check into a failed validation', async () => {
    const instance = instantiateTool(
      definition({
        validateInput: () => {
          throw new Error('disk unreadable')
        },
      }),
      '/repo',
      context,
    )

    expect(await validateToolCall(instance, {})).toEqual({
      result: false,
      message: 'Error: disk unreadable',
    })
  })
})

describe('ask mode', () => {
  const isReadOnly = (name: string) => isToolReadOnly(defaultRegistry.get(name))
  const allowed = (names: string[]) =>
    names.filter(name => !modeDenial('ask', name, isReadOnly))

  it('runs exactly the built-in tools that declare themselves read-only, and ToolSearch', () => {
    const builtIn = defaultRegistry.list().map(item => item.name)

    expect(
      allowed([...builtIn, 'ToolSearch', 'mcp__docs__search']).sort(),
    ).toEqual(
      [
        'Read',
        'Glob',
        'Grep',
        'LSP',
        'WebSearch',
        'WebFetch',
        'ToolSearch',
        ...BROWSER_READ_ONLY_TOOL_NAMES,
      ].sort(),
    )
  })

  it('refuses the mode-switch tools', () => {
    expect(allowed(['Read', 'EnterPlanMode', 'ExitPlanMode'])).toEqual(['Read'])
  })
})
