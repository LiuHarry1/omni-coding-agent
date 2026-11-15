/**
 * Streaming tool executor.
 * Tools start as soon as tool_use blocks arrive during model streaming.
 */
import type { CanUseToolFn } from '../../utils/permissions/can-use-tool.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { BASH_TOOL_NAME } from '../../constants/tool_names.js'
import type { Message, ToolDefinition } from '../../core/types.js'
import { validateToolCall } from '../../core/tool-definition.js'
import {
  hookResultMessages,
  hookStoppedMessage,
} from '../../core/hooks/messages.js'
import type { ToolUseContext } from '../../core/agent/tool-use-context.js'
import {
  executeOneTool,
  validateToolInput,
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
      const tracked: TrackedTool = {
        id: call.toolCallId,
        call: normalizedCall,
        status: 'completed',
        isConcurrencySafe: true,
      }
      this.#rejectTool(
        tracked,
        `Error: No such tool available: ${call.toolName}`,
      )
      this.#tools.push(tracked)
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

  /** Settle a call that will not run with an error result. */
  #rejectTool(
    tool: TrackedTool,
    result: string,
    extra: Pick<
      ExecutedToolResult,
      'followUpMessages' | 'preventContinuation'
    > = {},
  ): void {
    const { toolCallId, toolName } = tool.call
    this.#ctx.wire.toolResult({
      tool_use_id: toolCallId,
      result,
      is_error: true,
    })
    tool.result = { toolCallId, toolName, result, isError: true, ...extra }
    tool.status = 'completed'
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

      // Arguments are checked before the permission prompt, so the user is
      // never asked to approve a call that could not run anyway.
      if (tool.call.unvalidated) {
        const checked = await validateToolInput(
          this.#ctx.tools[tool.call.toolName],
          tool.call.toolName,
          tool.call.input,
        )
        if (!checked.ok) {
          this.#rejectTool(tool, checked.message)
          this.#updateInterruptibleState()
          return
        }
        tool.call = { ...tool.call, input: checked.input }
      }

      const validation = await validateToolCall(
        this.#ctx.tools[tool.call.toolName],
        tool.call.input,
      )
      if (!validation.result) {
        this.#rejectTool(tool, validation.message)
        this.#updateInterruptibleState()
        return
      }

      // PreToolUse hooks see the call after it is known to be well-formed
      // and before anyone is asked to approve it.
      const hooks = this.#ctx.hooks
      const hookMessages: Message[] = []
      let hookPermission:
        { behavior: 'allow' | 'ask'; reason?: string } | undefined
      if (hooks?.has('PreToolUse')) {
        const pre = await hooks.preToolUse(
          {
            toolName: tool.call.toolName,
            toolInput: tool.call.input,
            toolUseId: tool.call.toolCallId,
          },
          this.#siblingAbortController.signal,
        )
        hookMessages.push(...hookResultMessages(pre))
        if (pre.preventContinuation) {
          const reason = hookStoppedMessage(pre)
          this.#rejectTool(
            tool,
            `${pre.hookName} hook stopped continuation: ${reason}`,
            {
              followUpMessages: hookMessages,
              preventContinuation: reason,
            },
          )
          this.#updateInterruptibleState()
          return
        }
        const blocked = pre.blockingErrors[0]
        if (blocked || pre.permissionBehavior === 'deny') {
          this.#rejectTool(
            tool,
            `${pre.hookName} hook error: ${blocked?.blockingError ?? pre.permissionReason ?? 'Blocked by hook'}`,
            { followUpMessages: hookMessages },
          )
          this.#updateInterruptibleState()
          return
        }
        if (pre.updatedInput) {
          // The hook rewrote the arguments; they must still fit the tool.
          const rechecked = await validateToolInput(
            this.#ctx.tools[tool.call.toolName],
            tool.call.toolName,
            pre.updatedInput,
          )
          if (!rechecked.ok) {
            this.#rejectTool(tool, rechecked.message, {
              followUpMessages: hookMessages,
            })
            this.#updateInterruptibleState()
            return
          }
          tool.call = { ...tool.call, input: rechecked.input }
          const revalidated = await validateToolCall(
            this.#ctx.tools[tool.call.toolName],
            tool.call.input,
          )
          if (!revalidated.result) {
            this.#rejectTool(tool, revalidated.message, {
              followUpMessages: hookMessages,
            })
            this.#updateInterruptibleState()
            return
          }
        }
        if (pre.permissionBehavior) {
          hookPermission = {
            behavior: pre.permissionBehavior,
            reason: pre.permissionReason,
          }
        }
      }

      const permission = await this.#canUseTool(
        tool.call.toolName,
        tool.call.input,
        { toolUseId: tool.call.toolCallId, hookPermission },
      )
      if (permission.behavior === 'deny') {
        this.#rejectTool(tool, permission.message, {
          followUpMessages: hookMessages,
        })
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

      // PostToolUse hooks run for a tool that finished; their feedback and
      // context follow its result in the transcript.
      if (
        hooks?.has('PostToolUse') &&
        !executed.isError &&
        !this.#getAbortReason(tool)
      ) {
        const post = await hooks.postToolUse(
          {
            toolName: tool.call.toolName,
            toolInput: input,
            toolResponse: executed.toolUseResult ?? executed.result,
            toolUseId: tool.call.toolCallId,
          },
          toolAbort.signal,
        )
        hookMessages.push(...hookResultMessages(post, { blockingErrors: true }))
        if (post.preventContinuation) {
          executed.preventContinuation = hookStoppedMessage(post)
        }
      }
      if (hookMessages.length > 0) {
        executed.followUpMessages = [
          ...(executed.followUpMessages ?? []),
          ...hookMessages,
        ]
      }

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
    }

    // Every exit path (deny, pre-run abort, normal) must clear the waiter, or
    // getRemainingResults stops awaiting and spins the event loop.
    tool.promise = run().finally(() => {
      if (this.#progressResolve) {
        this.#progressResolve()
        this.#progressResolve = undefined
      }
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
