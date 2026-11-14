import type { ConcurrencyPolicyFn } from '../concurrency-policy.js'
import type { AnyTool, ToolDefinition } from '../types.js'
import type { HookRunner } from '../hooks/hooks.js'
import type { WireEmitter } from '../wire-emitter.js'

/**
 * Per-turn tool execution context.
 */
export interface ToolUseContext {
  tools: Record<string, AnyTool>
  wire: WireEmitter
  sessionId?: string
  logLabel?: string
  getDefinition?: (name: string) => ToolDefinition | undefined
  abortController: AbortController
  concurrencyPolicy: ConcurrencyPolicyFn
  /** User-configured PreToolUse / PostToolUse hooks. */
  hooks?: HookRunner
  setInProgressToolUseIDs?: (fn: (prev: Set<string>) => Set<string>) => void
  setHasInterruptibleToolInProgress?: (value: boolean) => void
}
