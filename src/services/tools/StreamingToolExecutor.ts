/**
 * Streaming tool executor.
 * Tools start as soon as tool_use blocks arrive during model streaming.
 */
import type { CanUseToolFn } from '../../core/can-use-tool.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { BASH_TOOL_NAME } from '../../constants/tool_names.js'
import type { ToolDefinition } from '../../core/types.js'
import type { ToolUseContext } from '../../core/agent/tool-use-context.js'
import {
  executeOneTool,
  type ExecutedToolResult,
  type ToolCallRef,
} from '../../services/tools/tool_execution.js'

/** Common model typos / case variants → canonical tool names. */
const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: BASH_TOOL_NAME,
  BASH: BASH_TOOL_NAME,
}

function resolveToolName(name: string, ctx: ToolUseContext): string {
  if (ctx.getDefinition?.(name) || ctx.tools[name]) return name
  const aliased =
    TOOL_NAME_ALIASES[name] ?? TOOL_NAME_ALIASES[name.toLowerCase()]
  if (aliased && (ctx.getDefinition?.(aliased) || ctx.tools[aliased])) {
    return aliased
  }
  // Case-insensitive match against registered tools (Bash vs bash).
  const lower = name.toLowerCase()
  for (const key of Object.keys(ctx.tools)) {
    if (key.toLowerCase() === lower) return key
  }
  return name
}

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  call: ToolCallRef
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  result?: ExecutedToolResult
}

export class StreamingToolExecutor {
  #tools: TrackedTool[] = []
  #ctx: ToolUseContext
  #canUseTool: CanUseToolFn
  #hasErrored = false
  #erroredToolDescription = ''
  #siblingAbortController: AbortController
  #discarded = false
  #progressResolve?: () => void

  constructor(canUseTool: CanUseToolFn, ctx: ToolUseContext) {
    this.#canUseTool = canUseTool
    this.#ctx = ctx
    this.#siblingAbortController = createChildAbortController(
      ctx.abortController,
    )
  }

  discard(): void {
    this.#discarded = true
  }

  addTool(call: ToolCallRef): void {
    const resolvedName = resolveToolName(call.toolName, this.#ctx)
    const normalizedCall =
      resolvedName === call.toolName
        ? call
        : { ...call, toolName: resolvedName }
    const def = this.#ctx.getDefinition?.(normalizedCall.toolName)
    const isConcurrencySafe = this.#isConcurrencySafe(def, normalizedCall)
    if (!def && !this.#ctx.tools[normalizedCall.toolName]) {
      this.#tools.push({
        id: call.toolCallId,
        call: normalizedCall,
        status: 'completed',
        isConcurrencySafe: true,
        result: {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: `Error: No such tool available: ${call.toolName}`,
          isError: true,
        },
      })
      void this.#processQueue()
      return
    }

    this.#tools.push({
      id: call.toolCallId,
      call: normalizedCall,
      status: 'queued',
      isConcurrencySafe,
    })
    void this.#processQueue()
  }

  getAllToolCalls(): ToolCallRef[] {
    return this.#tools.map(t => t.call)
  }

  *getCompletedResults(): Generator<ExecutedToolResult> {
    if (this.#discarded) return
    for (const tool of this.#tools) {
      if (tool.status === 'yielded') continue
      if (tool.status === 'completed' && tool.result) {
        tool.status = 'yielded'
        this.#markComplete(tool.id)
        yield tool.result
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  async *getRemainingResults(): AsyncGenerator<ExecutedToolResult> {
    if (this.#discarded) return
    while (this.#hasUnfinished()) {
      this.#processQueue()
      for (const result of this.getCompletedResults()) {
        yield result
      }
      if (
        this.#hasExecuting() &&
        !this.#hasCompleted() &&
        !this.#progressResolve
      ) {
        const executing = this.#tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)
        const progress = new Promise<void>(resolve => {
          this.#progressResolve = resolve
        })
        if (executing.length > 0) {
          await Promise.race([...executing, progress])
        }
      }
    }
    for (const result of this.getCompletedResults()) {
      yield result
    }
  }

  #isConcurrencySafe(
    def: ToolDefinition | undefined,
    call: ToolCallRef,
  ): boolean {
    if (def?.isConcurrencySafe) {
      try {
        return Boolean(def.isConcurrencySafe(call.input))
      } catch {
        return false
      }
    }
    try {
      return this.#ctx.concurrencyPolicy(call.toolName, call.input)
    } catch {
      return false
    }
  }

  #canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.#tools.filter(t => t.status === 'executing')
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    )
  }

  #processQueue(): void {
    for (const tool of this.#tools) {
      if (tool.status !== 'queued') continue
      if (this.#canExecuteTool(tool.isConcurrencySafe)) {
        void this.#executeTool(tool)
      } else if (!tool.isConcurrencySafe) {
        break
      }
    }
  }

  #getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.#discarded) return 'streaming_fallback'
    if (this.#hasErrored) return 'sibling_error'
    if (this.#ctx.abortController.signal.aborted) {
      if (this.#ctx.abortController.signal.reason === 'interrupt') {
        return this.#getInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted'
          : null
      }
      return 'user_interrupted'
    }
    return null
  }

  #getInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const def = this.#ctx.getDefinition?.(tool.call.toolName)
    if (def?.interruptBehavior) {
      try {
        return def.interruptBehavior()
      } catch {
        return 'block'
      }
    }
    return tool.isConcurrencySafe ? 'cancel' : 'block'
  }

  #syntheticResult(
    tool: TrackedTool,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
  ): ExecutedToolResult {
    const { toolCallId, toolName } = tool.call
    let result: string
    if (reason === 'user_interrupted') {
      result = 'Not run: the user interrupted the turn before this tool started'
    } else if (reason === 'streaming_fallback') {
      result = 'Error: Streaming fallback - tool execution discarded'
    } else {
      result = this.#erroredToolDescription
        ? `Cancelled: parallel tool call ${this.#erroredToolDescription} errored`
        : 'Cancelled: parallel tool call errored'
    }
    this.#ctx.wire.toolResult({
      tool_use_id: toolCallId,
      result,
      is_error: true,
    })
    return { toolCallId, toolName, result, isError: true }
  }

  #executeTool(tool: TrackedTool): void {
    tool.status = 'executing'
    this.#ctx.setInProgressToolUseIDs?.((prev: Set<string>) =>
      new Set(prev).add(tool.id),
    )
    this.#updateInterruptibleState()

    const run = async () => {
      const initialReason = this.#getAbortReason(tool)
      if (initialReason) {
        tool.result = this.#syntheticResult(tool, initialReason)
        tool.status = 'completed'
        this.#updateInterruptibleState()
        return
      }

      const permission = await this.#canUseTool(
        tool.call.toolName,
        tool.call.input,
        { toolUseId: tool.call.toolCallId },
      )
      if (permission.behavior === 'deny') {
        const result = permission.message
        this.#ctx.wire.toolResult({
          tool_use_id: tool.call.toolCallId,
          result,
          is_error: true,
        })
        tool.result = {
          toolCallId: tool.call.toolCallId,
          toolName: tool.call.toolName,
          result,
          isError: true,
        }
        tool.status = 'completed'
        this.#updateInterruptibleState()
        return
      }

      const input: Record<string, unknown> =
        permission.behavior === 'allow' &&
        permission.updatedInput &&
        typeof permission.updatedInput === 'object' &&
        !Array.isArray(permission.updatedInput)
          ? (permission.updatedInput as Record<string, unknown>)
          : tool.call.input

      const toolAbort = createChildAbortController(this.#siblingAbortController)
      toolAbort.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbort.signal.reason !== 'sibling_error' &&
            !this.#ctx.abortController.signal.aborted &&
            !this.#discarded
          ) {
            this.#ctx.abortController.abort(toolAbort.signal.reason)
          }
        },
        { once: true },
      )

      let thisToolErrored = false
      const executed = await executeOneTool(
        { ...tool.call, input },
        this.#ctx.tools,
        this.#ctx.wire,
        this.#ctx.sessionId,
        this.#ctx.getDefinition,
        toolAbort.signal,
      )

      const abortReason = this.#getAbortReason(tool)
      // The tool already ran: keep its real (possibly partial) output so the
      // model knows what happened instead of believing it never executed.
      if (
        abortReason &&
        abortReason !== 'user_interrupted' &&
        !thisToolErrored
      ) {
        tool.result = this.#syntheticResult(tool, abortReason)
      } else {
        tool.result = executed
        if (executed.isError && !abortReason) {
          thisToolErrored = true
          if (tool.call.toolName === BASH_TOOL_NAME) {
            this.#hasErrored = true
            this.#erroredToolDescription = this.#describeTool(tool)
            this.#siblingAbortController.abort('sibling_error')
          }
        }
      }

      tool.status = 'completed'
      this.#updateInterruptibleState()
      if (this.#progressResolve) {
        this.#progressResolve()
        this.#progressResolve = undefined
      }
    }

    tool.promise = run().finally(() => {
      this.#processQueue()
    })
  }

  #describeTool(tool: TrackedTool): string {
    const input = tool.call.input
    const summary =
      input.command ?? input.file_path ?? input.pattern ?? input.path ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated =
        summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.call.toolName}(${truncated})`
    }
    return tool.call.toolName
  }

  #updateInterruptibleState(): void {
    const executing = this.#tools.filter(t => t.status === 'executing')
    this.#ctx.setHasInterruptibleToolInProgress?.(
      executing.length > 0 &&
        executing.every(t => this.#getInterruptBehavior(t) === 'cancel'),
    )
  }

  #markComplete(toolUseId: string): void {
    this.#ctx.setInProgressToolUseIDs?.((prev: Set<string>) => {
      const next = new Set(prev)
      next.delete(toolUseId)
      return next
    })
  }

  #hasCompleted(): boolean {
    return this.#tools.some(t => t.status === 'completed')
  }

  #hasExecuting(): boolean {
    return this.#tools.some(t => t.status === 'executing')
  }

  #hasUnfinished(): boolean {
    return this.#tools.some(t => t.status !== 'yielded')
  }
}
