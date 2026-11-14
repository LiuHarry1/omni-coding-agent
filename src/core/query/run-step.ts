import { streamText } from 'ai'
import {
  applyMicroCompactProjection,
  attachTokenUsage,
  compactIfNeeded,
} from '../../services/compact/index.js'
import type {
  AttachedTokenUsage,
  CompactEnrichment,
} from '../../services/compact/index.js'
import {
  ensureMessageUuid,
  ensureMessageUuids,
} from '../../services/session-memory/index.js'
import {
  isContextLengthError,
  isInvalidRequestError,
  isTransientStreamError,
  parseMaxTokensContextOverflowError,
} from '../stream-errors.js'
import type {
  AgentOptions,
  AssistantMessage,
  Message,
  RoleMessage,
  RunAgentFn,
  TodoItem,
} from '../types.js'
import { createCacheSafeParams } from '../forked-agent.js'
import type { IProvider } from '../llm/types.js'
import {
  ensureToolResultPairing,
  inlineReasoningAsText,
  projectMessagesForApi,
  regroupToolResults,
  sanitizeReasoningParts,
} from '../agent/messageSanitize.js'
import { applyCacheControlBreakpoint } from '../agent/cacheControl.js'
import {
  expandAttachmentMessagesForAPI,
  mergeAdjacentUserMessages,
  smooshSystemReminderSiblings,
} from '../../utils/messages.js'
import { consumeStream, type StreamResult } from '../agent/streamConsumer.js'
import type { WireEmitter } from '../wire-emitter.js'
import { stripToolExecute } from '../agent/prepareTools.js'
import { buildToolMessage } from '../../services/tools/tool_execution.js'
import { enforceToolResultBudget } from '../../services/tool-storage/message-budget.js'
import { StreamingToolExecutor } from '../../services/tools/StreamingToolExecutor.js'
import { allowAllTools, type CanUseToolFn } from '../can-use-tool.js'
import type { ToolUseContext } from '../agent/tool-use-context.js'
import { createAbortController } from '../../utils/abortController.js'
import {
  appendUserInterruption,
  commitPartialStreamToHistory,
} from '../../utils/interrupt.js'
import { abortReasonFromSignal } from '../turn-abort-registry.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import {
  createDumpPromptsRecorder,
  createNoopDumpPromptsRecorder,
  isDumpPromptsEnabled,
  toolsForDump,
  type DumpPromptsRecorder,
} from '../../services/api/dumpPrompts.js'
import type { ConcurrencyPolicyFn } from '../concurrency-policy.js'
import type { AnyTool } from '../types.js'
import {
  agentLogTag,
  getMaxOutputTokens,
  maxTokensOverrideFromError,
  MAX_OVERFLOW_RETRIES,
  MAX_TRANSIENT_RETRIES,
} from './helpers.js'
import { applyCompactOutcome } from './pre-turn.js'
import { getMessagesAfterCompactBoundary } from '../messages/compact-boundary.js'

export interface RunStepArgs {
  /** Complete transcript. New assistant/tool messages are appended here. */
  messages: Message[]
  /** Optional precomputed active projection for this request. */
  modelMessages?: Message[]
  tools: Record<string, AnyTool>
  toolChoice?: 'auto' | 'none' | 'required'
  systemPrompt: string
  provider: IProvider
  resolvedModel: string
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  subagentNames?: Set<string>
  step: number
  stepStart: number
  currentTodos: TodoItem[]
  concurrencyPolicy: ConcurrencyPolicyFn
  getToolDefinition?: AgentOptions['getToolDefinition']
  canUseTool?: CanUseToolFn
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionMemory?: AgentOptions['sessionMemory']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
  logLabel?: string
  abortSignal?: AbortSignal
  readFileState?: import('../../utils/read/types.js').ReadFileState
  dumpPrompts?: DumpPromptsRecorder
  runAgent?: RunAgentFn
  turnProfiler?: AgentOptions['turnProfiler']
  /** Starting max_tokens for this step (raised after an output-limit cut). */
  maxOutputTokensOverride?: number
}

/** A response cut off before any visible output must not leave empty text blocks. */
function withoutEmptyAssistantContent(msgs: RoleMessage[]): RoleMessage[] {
  return msgs.flatMap((m): RoleMessage[] => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return [m]
    const content = m.content.filter(p => !(p.type === 'text' && !p.text))
    if (content.length === 0) return []
    return content.length === m.content.length ? [m] : [{ ...m, content }]
  })
}

/**
 * The step's tool calls in stream order, as the executor ran them (it may
 * have resolved a misspelled name). Calls the consumer settled itself, such
 * as ones with unparsed arguments, never reach the executor and are kept.
 */
export function withExecutorToolCalls(
  streamed: StreamResult['toolCalls'],
  executed: StreamResult['toolCalls'],
): StreamResult['toolCalls'] {
  const executedById = new Map(executed.map(tc => [tc.toolCallId, tc]))
  return streamed.map(tc => executedById.get(tc.toolCallId) ?? tc)
}

export function shouldAttemptReactiveCompaction(
  contextLengthAttempts: number,
  error: unknown,
): boolean {
  return contextLengthAttempts === 0 && isContextLengthError(error)
}

/**
 * One LLM round-trip, including reactive compaction / transient retry.
 */
export async function runStep(args: RunStepArgs): Promise<StreamResult> {
  const {
    messages,
    tools,
    toolChoice,
    systemPrompt,
    provider,
    resolvedModel,
    eventBus,
    wire,
    subagentNames,
    step,
    stepStart,
    concurrencyPolicy,
    getToolDefinition,
    canUseTool,
    cwd,
    compaction,
    sessionId,
    logLabel,
    abortSignal,
    turnProfiler,
  } = args

  const dumpPrompts = args.dumpPrompts ?? createNoopDumpPromptsRecorder()
  const apiTools = stripToolExecute(tools)
  const executors = tools

  let ctxLengthAttempt = 0
  let overflowAttempt = 0
  let lastOverflowTotal: number | undefined
  // The raised cap comes from settings and may be more than this endpoint
  // accepts; it is dropped for the rest of the step if a request is refused.
  let raisedOutputCap = args.maxOutputTokensOverride
  let maxTokensOverride: number | undefined = raisedOutputCap
  const outputCapOutcome = (): Pick<StreamResult, 'outputCapRejected'> =>
    args.maxOutputTokensOverride !== undefined && raisedOutputCap === undefined
      ? { outputCapRejected: true }
      : {}
  let transientAttempt = 0
  let reactiveCompacted = false
  let requestStart = Date.now()
  let activeModelMessages =
    args.modelMessages ??
    applyMicroCompactProjection(
      getMessagesAfterCompactBoundary(messages),
      sessionId,
    )

  const toolAbortController = createAbortController()
  if (abortSignal) {
    if (abortSignal.aborted) {
      toolAbortController.abort(abortSignal.reason)
    } else {
      abortSignal.addEventListener(
        'abort',
        () => toolAbortController.abort(abortSignal.reason),
        { once: true },
      )
    }
  }

  let streamingExecutor: StreamingToolExecutor | null = null
  const createStreamingExecutor = (): StreamingToolExecutor => {
    const toolUseContext: ToolUseContext = {
      tools: executors,
      wire,
      sessionId,
      logLabel,
      getDefinition: getToolDefinition,
      abortController: toolAbortController,
      concurrencyPolicy,
    }
    return new StreamingToolExecutor(
      canUseTool ?? allowAllTools,
      toolUseContext,
    )
  }
  streamingExecutor = createStreamingExecutor()

  while (true) {
    try {
      const apiMessages = applyCacheControlBreakpoint(
        projectMessagesForApi(
          ensureToolResultPairing(
            smooshSystemReminderSiblings(
              mergeAdjacentUserMessages(
                regroupToolResults(
                  expandAttachmentMessagesForAPI(
                    inlineReasoningAsText(activeModelMessages),
                  ),
                ),
              ),
            ),
          ),
          provider,
        ),
        provider,
      ) as RoleMessage[]

      const dumpTs = dumpPrompts.dumpRequest({
        model: resolvedModel,
        system: systemPrompt,
        messages: apiMessages,
        tools: toolsForDump(apiTools),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        provider: provider.describe(),
        step,
        logLabel: logLabel ?? 'main',
      })

      const stream = streamText({
        model: provider.chatModel(resolvedModel),
        system: systemPrompt,
        messages: apiMessages,
        tools: apiTools,
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        // Precedence: retry override > call override > model default.
        // Do not cap against a local prompt estimate on the first request.
        maxOutputTokens:
          maxTokensOverride ??
          compaction?.maxOutputTokens ??
          getMaxOutputTokens(),
        maxRetries: 3,
        ...(abortSignal ? { abortSignal } : {}),
        ...provider.streamTextExtras(),
      })

      // streamText is lazy — the request goes out when consumeStream pulls.
      profileCheckpoint('turn_api_request_sent')
      turnProfiler?.checkpoint('api_request', { step })
      const timing = { firstEventMs: 0 }
      const stepResult = await consumeStream(
        stream,
        wire,
        timing,
        subagentNames,
        {
          streamingExecutor: streamingExecutor ?? undefined,
        },
      )
      const ttftMs = timing.firstEventMs
        ? timing.firstEventMs - requestStart
        : -1
      profileCheckpoint(`turn_stream_done_ttft=${ttftMs}ms`)
      turnProfiler?.checkpoint('stream_complete', {
        step,
        ttft_ms: ttftMs,
      })

      if (stepResult.aborted) {
        if (streamingExecutor) {
          for await (const result of streamingExecutor.getRemainingResults()) {
            stepResult.toolResults.push(result)
          }
        }
        commitPartialStreamToHistory(messages, stepResult, wire)
        appendUserInterruption(messages, wire, {
          toolUse: false,
          signal: abortSignal,
        })
        return {
          ...stepResult,
          aborted: true,
          abortPhase: 'streaming',
          toolCalls: [],
          toolResults: [],
        }
      }

      if (streamingExecutor) {
        for await (const result of streamingExecutor.getRemainingResults()) {
          stepResult.toolResults.push(result)
        }
        stepResult.toolCalls = withExecutorToolCalls(
          stepResult.toolCalls,
          streamingExecutor.getAllToolCalls(),
        )
      }

      const response = await stream.response
      const sdkMessages = withoutEmptyAssistantContent(
        (response.messages as unknown as RoleMessage[]).filter(
          m => m.role !== 'tool',
        ),
      )
      sanitizeReasoningParts(sdkMessages)
      const roundId = response.id
      const receivedAt = Date.now()
      for (const m of sdkMessages) {
        if (m.role === 'assistant') {
          if (roundId) (m as AssistantMessage).id = roundId
          ;(m as AssistantMessage).timestamp = receivedAt
        }
      }
      messages.push(...sdkMessages)
      ensureMessageUuids(sdkMessages)

      if (stepResult.toolResults.length > 0) {
        // These results become one message; bound them together before it is
        // committed, so what the model sees never changes afterwards.
        stepResult.toolResults = enforceToolResultBudget(
          stepResult.toolResults,
          sessionId,
        )
        messages.push(
          ensureMessageUuid(buildToolMessage(stepResult.toolResults)),
        )
        for (const tr of stepResult.toolResults) {
          if (tr.followUpMessages?.length) {
            for (const fm of tr.followUpMessages) {
              messages.push(ensureMessageUuid(fm))
            }
          }
        }
      }

      if (abortSignal?.aborted) {
        appendUserInterruption(messages, wire, {
          toolUse: true,
          signal: abortSignal,
        })
        return { ...stepResult, aborted: true, abortPhase: 'tools' }
      }

      let usage: AttachedTokenUsage = {}
      try {
        usage = (await stream.usage) ?? {}
      } catch {
        // telemetry optional
      }
      if (usage.inputTokens != null || usage.totalTokens != null) {
        for (let i = sdkMessages.length - 1; i >= 0; i--) {
          if (sdkMessages[i].role === 'assistant') {
            attachTokenUsage(sdkMessages[i], usage)
            break
          }
        }
      }

      dumpPrompts.dumpResponse(dumpTs, {
        messages: sdkMessages,
        usage,
        toolCalls: stepResult.toolCalls.map(tc => ({
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          input: tc.input,
        })),
        step,
        logLabel: logLabel ?? 'main',
      })

      logStepCompletion({
        step,
        stepStart,
        requestStart,
        firstEventMs: timing.firstEventMs,
        sdkMessages,
        toolCallsLen: stepResult.toolCalls.length,
        usage,
        reactiveCompacted,
        eventBus,
        model: resolvedModel,
        provider: provider.describe(),
        sessionId,
        logLabel,
      })
      return { ...stepResult, ...outputCapOutcome() }
    } catch (err) {
      if (
        abortSignal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        appendUserInterruption(messages, wire, {
          toolUse: false,
          signal: abortSignal,
          reason: abortReasonFromSignal(abortSignal),
        })
        return {
          text: '',
          toolCalls: [],
          toolResults: [],
          completedCleanly: false,
          aborted: true,
          abortPhase: 'streaming',
        }
      }
      // First shrink max_tokens and retry the same request. If the remaining
      // output budget is below the floor, or retries are exhausted, fall
      // through to reactive compaction instead of failing a recoverable turn.
      const overflow = parseMaxTokensContextOverflowError(err)
      if (overflow) {
        // A shrink that leaves the reported total unchanged means the input
        // figure tracks our max_tokens rather than the prompt; stop shrinking.
        const total = overflow.inputTokens + overflow.maxTokens
        const stalled = lastOverflowTotal === total
        lastOverflowTotal = total
        const adjusted = stalled ? undefined : maxTokensOverrideFromError(err)
        if (adjusted !== undefined && overflowAttempt < MAX_OVERFLOW_RETRIES) {
          overflowAttempt++
          const errMsg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[${agentLogTag(logLabel)}] step ${step} max_tokens overflow -> retry with maxOutputTokens=${adjusted} (attempt ${overflowAttempt}/${MAX_OVERFLOW_RETRIES}). ${errMsg}`,
          )
          maxTokensOverride = adjusted
          requestStart = Date.now()
          streamingExecutor?.discard()
          streamingExecutor = createStreamingExecutor()
          continue
        }
      }
      if (shouldAttemptReactiveCompaction(ctxLengthAttempt, err)) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[${agentLogTag(logLabel)}] step ${step} hit context-length error -> reactive aggressive compaction. ${errMsg}`,
        )
        eventBus.emit('compaction_reactive', { error: errMsg })
        const cacheSafeParams = args.runAgent
          ? createCacheSafeParams({
              systemPrompt,
              tools,
              provider,
              model: resolvedModel,
              messages: activeModelMessages,
            })
          : undefined
        const recompacted = await compactIfNeeded(
          activeModelMessages,
          eventBus,
          wire,
          resolvedModel,
          cwd ?? process.cwd(),
          args.currentTodos,
          {
            force: true,
            aggressive: true,
            enrichment: args.compactEnrichment,
            sessionMemory: args.sessionMemory,
            readFileState: args.readFileState,
            runAgent: args.runAgent,
            cacheSafeParams,
          },
          compaction,
          provider,
          sessionId,
        )
        activeModelMessages = applyCompactOutcome(
          messages,
          recompacted,
          args.currentTodos,
          args.onFullCompaction,
          sessionId,
        )
        maxTokensOverride = raisedOutputCap
        overflowAttempt = 0
        lastOverflowTotal = undefined
        ctxLengthAttempt++
        reactiveCompacted = true
        requestStart = Date.now()
        streamingExecutor?.discard()
        streamingExecutor = createStreamingExecutor()
        continue
      }
      if (
        transientAttempt < MAX_TRANSIENT_RETRIES &&
        isTransientStreamError(err)
      ) {
        transientAttempt++
        const backoffMs = 500 * Math.pow(3, transientAttempt - 1)
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[${agentLogTag(logLabel)}] step ${step} transient stream error (attempt ${transientAttempt}/${MAX_TRANSIENT_RETRIES}), retrying in ${backoffMs}ms: ${errMsg}`,
        )
        eventBus.emit('transient_retry', {
          attempt: transientAttempt,
          max: MAX_TRANSIENT_RETRIES,
          backoffMs,
          error: errMsg,
        })
        await new Promise(r => setTimeout(r, backoffMs))
        requestStart = Date.now()
        streamingExecutor?.discard()
        streamingExecutor = createStreamingExecutor()
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      if (raisedOutputCap !== undefined && isInvalidRequestError(err)) {
        console.warn(
          `[${agentLogTag(logLabel)}] step ${step} request refused with maxOutputTokens=${raisedOutputCap} -> retrying at the default. ` +
            `If this repeats, lower maxOutputTokens for this model in settings.json. ${message}`,
        )
        raisedOutputCap = undefined
        maxTokensOverride = undefined
        overflowAttempt = 0
        lastOverflowTotal = undefined
        requestStart = Date.now()
        streamingExecutor?.discard()
        streamingExecutor = createStreamingExecutor()
        continue
      }
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? ` (${err.cause.message})`
          : ''
      console.error(
        `[${agentLogTag(logLabel)}] step ${step} failed: ${message}${cause}`,
      )
      // The caller ends the turn and reports this; nothing was committed.
      return {
        text: '',
        toolCalls: [],
        toolResults: [],
        completedCleanly: false,
        completionError: `Upstream stream failed: ${message}${cause}. Try again or check your proxy logs.`,
        ...outputCapOutcome(),
      }
    }
  }
}

interface LogArgs {
  step: number
  stepStart: number
  requestStart: number
  firstEventMs: number
  sdkMessages: RoleMessage[]
  toolCallsLen: number
  usage: AttachedTokenUsage
  reactiveCompacted: boolean
  eventBus: AgentOptions['eventBus']
  model: string
  provider?: string
  sessionId?: string
  logLabel?: string
}

function logStepCompletion(a: LogArgs): void {
  const fmt = (n: number | undefined): string =>
    typeof n === 'number' ? n.toLocaleString() : '?'
  const totalMs = Date.now() - a.requestStart
  const ttfb = a.firstEventMs ? a.firstEventMs - a.requestStart : -1
  const generationMs = ttfb >= 0 ? totalMs - ttfb : -1
  const reasoningCount = a.sdkMessages.reduce(
    (n, m) =>
      n +
      (m.role === 'assistant' && Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'reasoning').length
        : 0),
    0,
  )
  const usageParts = [
    `in=${fmt(a.usage.inputTokens)}`,
    `out=${fmt(a.usage.outputTokens)}`,
  ]
  if (
    typeof a.usage.reasoningTokens === 'number' &&
    a.usage.reasoningTokens > 0
  ) {
    usageParts.push(`reasoning=${fmt(a.usage.reasoningTokens)}`)
  }
  if (
    typeof a.usage.cachedInputTokens === 'number' &&
    a.usage.cachedInputTokens > 0
  ) {
    usageParts.push(`cached=${fmt(a.usage.cachedInputTokens)}`)
  }
  const tag = agentLogTag(a.logLabel)
  console.log(
    `[${tag}] step ${a.step} done -- total=${totalMs}ms ` +
      `(ttfb=${ttfb}ms upstream-wait, gen=${generationMs}ms streaming), ` +
      `usage[${usageParts.join(' ')}], ` +
      `reasoning_blocks=${reasoningCount}, tool_calls=${a.toolCallsLen}, ` +
      `step_total=${Date.now() - a.stepStart}ms` +
      (a.reactiveCompacted ? ', reactive_compaction=yes' : ''),
  )

  a.eventBus.emit('usage', {
    step: a.step,
    sessionId: a.sessionId,
    model: a.model,
    provider: a.provider,
    inputTokens: a.usage.inputTokens ?? 0,
    outputTokens: a.usage.outputTokens ?? 0,
    cachedInputTokens: a.usage.cachedInputTokens ?? 0,
    reasoningTokens: a.usage.reasoningTokens ?? 0,
    totalTokens:
      a.usage.totalTokens ??
      (a.usage.inputTokens ?? 0) + (a.usage.outputTokens ?? 0),
    latencyMs: totalMs,
    ttfbMs: ttfb >= 0 ? ttfb : undefined,
    toolCalls: a.toolCallsLen,
  })
}

export function createDumpRecorder(
  sessionId: string | undefined,
  logLabel?: string,
): DumpPromptsRecorder {
  const dumpKey = logLabel
    ? `${sessionId ?? 'unknown'}__${logLabel}`
    : (sessionId ?? 'unknown')
  return isDumpPromptsEnabled()
    ? createDumpPromptsRecorder(dumpKey)
    : createNoopDumpPromptsRecorder()
}
