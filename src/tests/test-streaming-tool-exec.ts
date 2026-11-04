/**
 * StreamingToolExecutor — concurrency-safe tools run in parallel.
 */
import assert from 'node:assert/strict'
import { StreamingToolExecutor } from '../services/tools/StreamingToolExecutor.js'
import { allowAllTools } from '../core/can-use-tool.js'
import { createAbortController } from '../utils/abortController.js'
import type { ToolUseContext } from '../core/agent/tool-use-context.js'
import type { AnyTool, ToolDefinition } from '../core/types.js'
import type { WireEmitter } from '../core/wire-emitter.js'

const noopWire = {
  toolResult() {},
} as unknown as WireEmitter

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const defs: Record<string, ToolDefinition> = {
  Read: {
    name: 'Read',
    description: 'read',
    isConcurrencySafe: () => true,
    interruptBehavior: () => 'cancel',
    create: () => ({}) as AnyTool,
  },
  Write: {
    name: 'Write',
    description: 'write',
    isConcurrencySafe: () => false,
    interruptBehavior: () => 'block',
    create: () => ({}) as AnyTool,
  },
}

const order: string[] = []
const tools: Record<string, AnyTool> = {
  Read: {
    execute: async (input: { id: number }) => {
      order.push(`start-${input.id}`)
      await sleep(30)
      order.push(`end-${input.id}`)
      return `read-${input.id}`
    },
  } as unknown as AnyTool,
  Write: {
    execute: async () => {
      order.push('write')
      return 'written'
    },
  } as unknown as AnyTool,
}

async function main(): Promise<void> {
  const abortController = createAbortController()
  const ctx: ToolUseContext = {
    tools,
    wire: noopWire,
    abortController,
    concurrencyPolicy: () => true,
    getDefinition: name => defs[name],
  }
  const executor = new StreamingToolExecutor(allowAllTools, ctx)

  executor.addTool({
    toolCallId: 'a',
    toolName: 'Read',
    input: { id: 1 },
  })
  executor.addTool({
    toolCallId: 'b',
    toolName: 'Read',
    input: { id: 2 },
  })
  executor.addTool({
    toolCallId: 'c',
    toolName: 'Write',
    input: {},
  })

  const results = []
  for await (const r of executor.getRemainingResults()) {
    results.push(r)
  }

  assert.equal(results.length, 3)
  assert.ok(order.indexOf('start-1') < order.indexOf('end-1'))
  assert.ok(order.indexOf('start-2') < order.indexOf('end-2'))
  // Both reads should start before either ends (parallel)
  assert.ok(order.indexOf('start-2') < order.indexOf('end-1'))
  // Write runs after reads complete
  assert.ok(order.indexOf('end-1') < order.indexOf('write'))
  assert.ok(order.indexOf('end-2') < order.indexOf('write'))

  console.log('[ok] parallel reads then serial write')

  // Single addTool burst:
  const overlapOrder: string[] = []
  const overlapTools: Record<string, AnyTool> = {
    Read: {
      execute: async (input: { id: number }) => {
        overlapOrder.push(`start-${input.id}`)
        await sleep(50)
        overlapOrder.push(`end-${input.id}`)
        return `read-${input.id}`
      },
    } as unknown as AnyTool,
  }
  const overlapCtx: ToolUseContext = {
    tools: overlapTools,
    wire: noopWire,
    abortController: createAbortController(),
    concurrencyPolicy: () => true,
    getDefinition: name => defs[name],
  }
  const overlapExec = new StreamingToolExecutor(allowAllTools, overlapCtx)
  overlapExec.addTool({ toolCallId: 'x', toolName: 'Read', input: { id: 1 } })
  overlapExec.addTool({ toolCallId: 'y', toolName: 'Read', input: { id: 2 } })
  for await (const _ of overlapExec.getRemainingResults()) {
    /* drain */
  }
  assert.ok(
    overlapOrder.indexOf('start-2') < overlapOrder.indexOf('end-1'),
    `reads should overlap; got: ${overlapOrder.join(',')}`,
  )
  console.log('[ok] single burst parallel reads overlap')

  // Stop mid-run: the model must see what the tool actually produced.
  const stopController = createAbortController()
  const stopCtx: ToolUseContext = {
    tools: {
      Write: {
        execute: async (
          _input: unknown,
          opts: { abortSignal?: AbortSignal },
        ) => {
          await new Promise<void>(resolve =>
            opts.abortSignal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          )
          return 'tick 1\ntick 2\n[interrupted]'
        },
      } as unknown as AnyTool,
    },
    wire: noopWire,
    abortController: stopController,
    concurrencyPolicy: () => false,
    getDefinition: name => defs[name],
  }
  const stopExec = new StreamingToolExecutor(allowAllTools, stopCtx)
  stopExec.addTool({ toolCallId: 's', toolName: 'Write', input: {} })
  setTimeout(() => stopController.abort(), 20)
  const stopped = []
  for await (const r of stopExec.getRemainingResults()) stopped.push(r)
  assert.equal(stopped.length, 1)
  assert.match(stopped[0]!.result, /tick 2/)
  assert.doesNotMatch(stopped[0]!.result, /rejected/i)
  console.log('[ok] interrupted tool keeps its partial output')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})
