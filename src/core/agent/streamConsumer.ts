import type { streamText } from 'ai'
import type { WireEmitter } from '../wire-emitter.js'
import {
  appendPreviewDelta,
  maybeStartPreview,
  type PreviewState,
} from './previewStream.js'
import { formatToolError } from './toolErrors.js'

import type {
  ExecutedToolResult,
  ToolCallRef,
} from '../../services/tools/tool_execution.js'
import type { StreamingToolExecutor } from '../../services/tools/StreamingToolExecutor.js'

export interface StreamResult {
  text: string
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }>
  toolResults: ExecutedToolResult[]
  /** True only when the provider stream ended with a definitive finish event. */
  completedCleanly: boolean
  /** User-facing explanation when completedCleanly is false. */
  completionError?: string
  /** True when the upstream stream was aborted mid-turn (salvage path). */
  aborted?: boolean
  /** Where the abort landed: mid-response, or after the step's tools ran. */
  abortPhase?: 'streaming' | 'tools'
  /** Provider stopped at the output token limit (`finishReason: 'length'`). */
  truncated?: boolean
  /** Tools whose arguments were cut off by the limit; they never ran. */
  truncatedToolNames?: string[]
  /** The endpoint refused the raised output cap; the step ran at the default. */
  outputCapRejected?: boolean
}

export const TRUNCATED_TOOL_INPUT_RESULT =
  'Output token limit reached before the tool arguments were complete. This call did not run.'

const CONTENT_EVENT_TYPES = new Set([
  'reasoning-start',
  'reasoning-delta',
  'text-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-call',
])

function streamPartText(e: { text?: string; delta?: string }): string {
  const t = e.text
  const d = e.delta
  if (typeof t === 'string' && t.length > 0) return t
  if (typeof d === 'string' && d.length > 0) return d
  return typeof t === 'string' ? t : typeof d === 'string' ? d : ''
}

function readInputDelta(event: unknown): { id?: string; delta?: string } {
  const e = event as {
    id?: string
    toolCallId?: string
    delta?: string
    inputTextDelta?: string
  }
  return { id: e.id ?? e.toolCallId, delta: e.inputTextDelta ?? e.delta }
}

export interface ConsumeStreamOptions {
  /** Streaming tool execution — start tools as tool_use blocks arrive. */
  streamingExecutor?: StreamingToolExecutor
}

function drainStreamingResults(
  executor: StreamingToolExecutor | undefined,
  toolResults: ExecutedToolResult[],
): void {
  if (!executor) return
  for (const result of executor.getCompletedResults()) {
    toolResults.push(result)
  }
}

export async function consumeStream(
  stream: ReturnType<typeof streamText>,
  wire: WireEmitter,
  timing?: { firstEventMs: number },
  subagentNames?: Set<string>,
  options?: ConsumeStreamOptions,
): Promise<StreamResult> {
  const isSubagentName = (n?: string): boolean =>
    !!(n && subagentNames && subagentNames.has(n))

  const toolCalls: StreamResult['toolCalls'] = []
  const toolResults: StreamResult['toolResults'] = []
  const streamingExecutor = options?.streamingExecutor
  let text = ''
  let reasoningStarted = false
  let streamError: unknown
  let hasStreamError = false
  let streamAborted = false
  let sawFinish = false
  let finishReason: string | undefined
  let rawFinishReason: string | undefined

  const previewStates = new Map<string, PreviewState>()
  const startedInputs = new Map<string, string | undefined>()
  // Calls whose arguments never parsed (cut off or malformed JSON). Providers
  // close them as a string-input `tool-call` followed by a `tool-error`; they
  // are settled after the stream, once the finish reason names the cause.
  const unparsedInputs = new Map<
    string,
    { toolName: string; error?: unknown }
  >()

  /** Calls the SDK rejected that the executor validates and reports itself. */
  const executorSettled = new Set<string>()

  const flushReasoning = (): void => {
    if (reasoningStarted) {
      wire.reasoningEnd()
      reasoningStarted = false
    }
  }

  const synthesizePair = (
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
  ): void => {
    wire.toolCall({
      tool_use_id: id,
      name,
      args: input,
      is_subagent: isSubagentName(name),
    })
    wire.toolResult({ tool_use_id: id, result, is_error: true })
    toolCalls.push({ toolCallId: id, toolName: name, input })
    toolResults.push({ toolCallId: id, toolName: name, result })
    previewStates.delete(id)
    startedInputs.delete(id)
  }

  try {
    for await (const event of stream.fullStream) {
      if (
        timing &&
        !timing.firstEventMs &&
        CONTENT_EVENT_TYPES.has(event.type)
      ) {
        timing.firstEventMs = Date.now()
      }
      switch (event.type) {
        case 'reasoning-start':
          reasoningStarted = true
          wire.reasoningStart()
          break

        case 'reasoning-delta': {
          if (!reasoningStarted) {
            reasoningStarted = true
            wire.reasoningStart()
          }
          const delta = streamPartText(event)
          if (delta) wire.reasoningDelta(delta)
          break
        }

        case 'reasoning-end':
          flushReasoning()
          break

        case 'text-delta': {
          flushReasoning()
          const delta = streamPartText(event)
          if (delta) {
            text += delta
            wire.textDelta(delta)
          }
          break
        }

        case 'tool-input-start': {
          flushReasoning()
          const e = event as {
            id?: string
            toolCallId?: string
            toolName?: string
          }
          const id = e.id ?? e.toolCallId
          if (!id) break
          startedInputs.set(id, e.toolName)
          wire.toolInputStart({
            tool_use_id: id,
            name: e.toolName ?? 'unknown',
            is_subagent: isSubagentName(e.toolName),
          })
          const preview = maybeStartPreview(e.toolName)
          if (preview) previewStates.set(id, preview)
          break
        }

        case 'tool-input-delta': {
          const { id, delta } = readInputDelta(event)
          if (!id || !delta) break

          wire.toolInputDelta(id, delta.length)

          const state = previewStates.get(id)
          if (state) {
            const newlyDecoded = appendPreviewDelta(state, delta)
            if (newlyDecoded) {
              wire.toolInputPreviewDelta(id, newlyDecoded)
            }
          }
          break
        }

        case 'tool-call':
          flushReasoning()
          if (typeof event.input === 'string') {
            // Never run a tool on raw, unparsed arguments.
            startedInputs.set(event.toolCallId, event.toolName)
            unparsedInputs.set(event.toolCallId, { toolName: event.toolName })
            break
          }
          {
            // The SDK flags a call it could not match to a tool schema and
            // follows it with a `tool-error`. The executor may still resolve
            // the name (`bash` for `Bash`) and re-checks the arguments, so it
            // owns the outcome; without one, the `tool-error` settles the call.
            const rejectedBySdk =
              (event as { invalid?: boolean }).invalid === true
            if (rejectedBySdk && !streamingExecutor) break
            wire.toolCall({
              tool_use_id: event.toolCallId,
              name: event.toolName,
              args: event.input,
              is_subagent: isSubagentName(event.toolName),
            })
            const ref: ToolCallRef = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input as Record<string, unknown>,
              ...(rejectedBySdk ? { unvalidated: true } : {}),
            }
            toolCalls.push(ref)
            streamingExecutor?.addTool(ref)
            if (rejectedBySdk) executorSettled.add(event.toolCallId)
          }
          previewStates.delete(event.toolCallId)
          startedInputs.delete(event.toolCallId)
          break

        case 'tool-error': {
          const e = event as {
            toolCallId: string
            toolName: string
            error?: unknown
            input?: unknown
          }
          if (executorSettled.has(e.toolCallId)) break
          const unparsed = unparsedInputs.get(e.toolCallId)
          if (unparsed) {
            unparsed.error = e.error
            break
          }
          synthesizePair(
            e.toolCallId,
            e.toolName,
            (e.input ?? {}) as Record<string, unknown>,
            `Error: ${formatToolError(e.toolName, e.error)}`,
          )
          break
        }

        case 'tool-result': {
          // StreamingToolExecutor + executeOneTool own wire.toolResult (incl.
          // tool_use_result). Ignore SDK tool-result events so we don't paint
          // a TUR-less result that Grep/Glob cards treat as broken.
          startedInputs.delete(event.toolCallId)
          break
        }

        case 'error':
          streamError = event.error
          hasStreamError = true
          break

        case 'abort':
          streamAborted = true
          break

        case 'finish':
          sawFinish = true
          finishReason = event.finishReason
          rawFinishReason = event.rawFinishReason
          break
      }
      // Drain completed tool results after every stream event so
      // the UI sees tool_result while the model is still generating.
      drainStreamingResults(streamingExecutor, toolResults)
    }
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        (err as { name?: string }).name === 'AbortError')
    if (!aborted) throw err

    flushReasoning()
    // Incomplete tool-input streams: close with interrupt results.
    for (const [id, toolName] of startedInputs.entries()) {
      synthesizePair(id, toolName ?? 'unknown', {}, 'Interrupted by user')
    }
    return {
      text,
      toolCalls,
      toolResults,
      completedCleanly: false,
      aborted: true,
    }
  }

  flushReasoning()

  if (streamAborted) {
    for (const [id, toolName] of startedInputs.entries()) {
      synthesizePair(id, toolName ?? 'unknown', {}, 'Interrupted by user')
    }
    return {
      text,
      toolCalls,
      toolResults,
      completedCleanly: false,
      aborted: true,
    }
  }

  // Without content, the SDK's own rejection is a generic NoOutputGeneratedError
  // that hides the cause (e.g. context-length overflow), so the caller could
  // only treat it as transient. Surface the original error for classification.
  if (hasStreamError) {
    // An input-start is not usable output: without the completed tool-call,
    // retry/compaction must still see the provider error.
    if (!text && toolCalls.length === 0) {
      throw streamError
    }
  }

  drainStreamingResults(streamingExecutor, toolResults)

  const truncated = sawFinish && !hasStreamError && finishReason === 'length'
  const cutToolNames = new Set<string>()
  for (const [id, { toolName, error }] of unparsedInputs) {
    if (truncated) cutToolNames.add(toolName)
    synthesizePair(
      id,
      toolName,
      {},
      truncated
        ? TRUNCATED_TOOL_INPUT_RESULT
        : `Error: ${formatToolError(toolName, error ?? 'Tool arguments were not valid JSON.')}`,
    )
  }

  const incompleteToolNames = [
    ...new Set(
      [...startedInputs.values()].map(toolName => toolName ?? 'unknown'),
    ),
  ]
  const hasIncompleteToolInput = incompleteToolNames.length > 0
  const hasAmbiguousFinish =
    finishReason === 'other' && rawFinishReason === undefined
  const completedCleanly =
    sawFinish &&
    !hasStreamError &&
    !hasIncompleteToolInput &&
    finishReason !== 'error' &&
    !hasAmbiguousFinish

  let completionError: string | undefined
  if (hasIncompleteToolInput) {
    completionError =
      `Upstream stream ended before tool arguments completed ` +
      `(${incompleteToolNames.join(', ')}).`
  } else if (hasStreamError) {
    completionError = `Upstream stream failed after partial output: ${String(
      streamError,
    )}`
  } else if (!sawFinish) {
    completionError =
      'Upstream stream ended before a finish signal was received.'
  } else if (finishReason === 'error') {
    completionError = 'Upstream stream finished with an error.'
  } else if (hasAmbiguousFinish) {
    completionError =
      'Upstream stream ended without a definitive finish reason.'
  }

  // Partial tool inputs are preview-only. Never turn them into model history:
  // there is no complete tool call to pair with a synthetic result.
  for (const [id, toolName] of startedInputs) {
    previewStates.delete(id)
    // Wire-only: settle the card the UI opened on tool-input-start.
    if (truncated) {
      cutToolNames.add(toolName ?? 'unknown')
      wire.toolResult({
        tool_use_id: id,
        result: TRUNCATED_TOOL_INPUT_RESULT,
        is_error: true,
      })
    }
  }
  startedInputs.clear()

  return {
    text,
    toolCalls,
    toolResults,
    completedCleanly,
    ...(completionError ? { completionError } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(cutToolNames.size > 0 ? { truncatedToolNames: [...cutToolNames] } : {}),
  }
}
