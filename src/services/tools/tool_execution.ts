/**
 * Tool execution — single-tool execute + tool message assembly.
 * Batching / concurrency is handled by StreamingToolExecutor.
 */
import type {
  AnyTool,
  DualChannelToolResult,
  Message,
  ToolDefinition,
  ToolMessage,
  ToolResultContentBlockParam,
} from '../../core/types.js'
import type { WireEmitter } from '../../core/wire-emitter.js'
import { formatToolError } from '../../core/agent/toolErrors.js'
import { defaultRegistry } from '../../core/tool-registry.js'
import {
  clearToolAbort,
  registerToolAbort,
} from '../../core/tool-abort-registry.js'
import { maybePersistAfterExecute } from '../tool-storage/index.js'
import { projectToolUseResult } from '../../utils/project-tool-use-result.js'
import {
  blocksToToolResultOutputParts,
  hasImageBlock,
  stripImageBlocks,
  toolResultBlocksToText,
} from '../../utils/tool-result-content.js'
import { TOOL_INTERRUPT_RESULT } from '../../utils/interrupt.js'
import { isWorkerChannelLostError } from '../../execution/worker-channel-error.js'

export interface ToolCallRef {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface ExecutedToolResult {
  toolCallId: string
  toolName: string
  /** Text projection — wire, transcript, persistence, compaction. */
  result: string
  /**
   * Model-facing blocks, set only when the mapper returned image content.
   * `result` stays the text projection of these blocks.
   */
  resultBlocks?: ToolResultContentBlockParam[]
  toolUseResult?: unknown
  followUpMessages?: Message[]
  isError?: boolean
}

function isDualChannelReturn(raw: unknown): raw is DualChannelToolResult {
  return (
    !!raw &&
    typeof raw === 'object' &&
    'data' in raw &&
    !('result' in (raw as object))
  )
}

function cancelledToolResult(
  tc: ToolCallRef,
  wire: WireEmitter,
): ExecutedToolResult {
  const errResult = TOOL_INTERRUPT_RESULT
  wire.toolResult({
    tool_use_id: tc.toolCallId,
    result: errResult,
    is_error: true,
  })
  return {
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    result: errResult,
    isError: true,
  }
}

export async function executeOneTool(
  tc: ToolCallRef,
  tools: Record<string, AnyTool>,
  wire: WireEmitter,
  sessionId?: string,
  getDefinition?: (name: string) => ToolDefinition | undefined,
  parentAbort?: AbortSignal,
): Promise<ExecutedToolResult> {
  const tool = tools[tc.toolName] as AnyTool & {
    execute?: (input: unknown, options?: unknown) => Promise<unknown>
  }
  const lookup = getDefinition ?? ((name: string) => defaultRegistry.get(name))

  if (!tool?.execute) {
    const errResult = `Error: Unknown tool: ${tc.toolName}`
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result: errResult,
      is_error: true,
    })
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result: errResult,
    }
  }

  const toolSignal =
    sessionId != null
      ? registerToolAbort(sessionId, tc.toolCallId, parentAbort)
      : parentAbort

  if (toolSignal?.aborted) {
    return cancelledToolResult(tc, wire)
  }

  try {
    const raw = await tool.execute(tc.input, {
      toolCallId: tc.toolCallId,
      messages: [],
      abortSignal: toolSignal,
    })

    // If the tool finished successfully, keep its result even if the turn
    // abort raced in afterward: completed tools stay in the transcript.

    const def = lookup(tc.toolName)
    let result: string
    let resultBlocks: ToolResultContentBlockParam[] | undefined
    let toolUseResult: unknown | undefined
    let followUpMessages: Message[] | undefined
    let isError = false

    if (def?.mapToolResultToToolResultBlockParam && isDualChannelReturn(raw)) {
      followUpMessages = raw.newMessages
      const mapped = def.mapToolResultToToolResultBlockParam(
        raw.data,
        tc.toolCallId,
      )
      isError = mapped.is_error === true
      if (Array.isArray(mapped.content)) {
        const blocks = isError
          ? stripImageBlocks(mapped.content)
          : mapped.content
        if (hasImageBlock(blocks)) resultBlocks = blocks
        result = toolResultBlocksToText(blocks)
      } else {
        result =
          typeof mapped.content === 'string'
            ? mapped.content
            : String(mapped.content ?? '')
      }

      if (def.outputSchema) {
        const forWire = projectToolUseResult(tc.toolName, raw.data)
        const parsed = def.outputSchema.safeParse(forWire)
        if (parsed.success) {
          toolUseResult = parsed.data ?? forWire
        } else {
          console.warn(
            `[tools] ${tc.toolName}: outputSchema validation failed; omitting tool_use_result`,
            parsed.error,
          )
          toolUseResult = undefined
        }
      } else {
        toolUseResult = raw.data
      }
    } else if (typeof raw === 'string') {
      result = raw
      isError = raw.startsWith('Error:')
    } else if (raw && typeof raw === 'object' && 'result' in raw) {
      const structured = raw as {
        result: string
        followUpMessages?: Message[]
        newMessages?: Message[]
      }
      result = structured.result
      followUpMessages = structured.followUpMessages ?? structured.newMessages
      isError = result.startsWith('Error:')
    } else {
      result = JSON.stringify(raw)
    }

    if (!resultBlocks) {
      result = maybePersistAfterExecute(
        sessionId,
        tc.toolCallId,
        tc.toolName,
        result,
      )
    }
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result,
      ...(toolUseResult !== undefined
        ? { tool_use_result: toolUseResult }
        : {}),
      ...(isError ? { is_error: true } : {}),
    })
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
      ...(resultBlocks ? { resultBlocks } : {}),
      toolUseResult,
      followUpMessages,
      ...(isError ? { isError: true } : {}),
    }
  } catch (err) {
    const aborted =
      toolSignal?.aborted || (err instanceof Error && err.name === 'AbortError')
    if (aborted) return cancelledToolResult(tc, wire)
    if (isWorkerChannelLostError(err)) {
      const result =
        'Outcome unknown: the Worker channel was lost before this operation ' +
        'was acknowledged. Inspect the workspace or external state before ' +
        'retrying.'
      const toolUseResult = {
        status: 'unknown' as const,
        reason: 'worker_lost' as const,
      }
      wire.toolResult({
        tool_use_id: tc.toolCallId,
        result,
        tool_use_result: toolUseResult,
        is_error: true,
      })
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result,
        toolUseResult,
        isError: true,
      }
    }
    const result = `Error: ${formatToolError(tc.toolName, err)}`
    wire.toolResult({
      tool_use_id: tc.toolCallId,
      result,
      is_error: true,
    })
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
      isError: true,
    }
  } finally {
    if (sessionId) clearToolAbort(sessionId, tc.toolCallId)
  }
}

export function buildToolMessage(
  results: readonly ExecutedToolResult[],
): ToolMessage {
  return {
    role: 'tool',
    content: results.map(tr => ({
      type: 'tool-result' as const,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: tr.resultBlocks
        ? {
            type: 'content' as const,
            value: blocksToToolResultOutputParts(tr.resultBlocks),
          }
        : { type: 'text' as const, value: tr.result },
      ...(tr.toolUseResult !== undefined
        ? { toolUseResult: tr.toolUseResult }
        : {}),
      ...(tr.isError ? { isError: true } : {}),
    })),
  }
}
