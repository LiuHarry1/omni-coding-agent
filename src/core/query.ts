import { getInvokedSkillsForAgent } from '../skills/invoked-skills.js'
import type { CompactEnrichment } from '../services/compact/index.js'
import { ensureMessageUuid } from '../services/session-memory/index.js'
import { extractPartialResult } from '../tools/AgentTool/finalizeAgentTool.js'
import { finalizeInterruptedTurn } from '../utils/interrupt.js'
import type { TodoItem } from './types.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type {
  QueryOptions,
  QueryResult,
  QueryStopReason,
} from './query/types.js'
import {
  MAX_TRUNCATION_RECOVERIES,
  agentLogTag,
  autoCompleteTodos,
  buildTruncationReminder,
  escalatedMaxOutputTokens,
  getMaxOutputTokens,
  syncToolSet,
} from './query/helpers.js'
import { productionDeps } from './query/deps.js'
import { emitTurnEnd } from './query/post-turn.js'
import { createDumpRecorder } from './query/run-step.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import { getActiveModelMessages } from '../services/compact/index.js'

/** Plan approved — any of these in the same turn counts as implementation started. */
const PLAN_IMPLEMENTATION_TOOLS = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  BASH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
])

/**
 * Unified agent query loop.
 * Callers seed `messages` before invoking; `runAgent` appends the user turn.
 */
export async function query(opts: QueryOptions): Promise<QueryResult> {
  const {
    tools,
    systemPrompt,
    eventBus,
    wire,
    messages,
    maxSteps,
    model,
    subagentNames,
    deferredToolPool,
    getToolDefinition,
    canUseTool,
    concurrencyPolicy,
    sessionId,
    toolUseContext,
    refreshTools,
    refreshSystemPrompt,
    provider: configuredProvider,
    cwd,
    compaction,
    sessionMemory,
    onFullCompaction,
    onAfterStep,
    onStepCommitted,
    onTurnEnd,
    logLabel,
    abortSignal,
    memoryPrefetch,
    runAgent,
    turnProfiler,
  } = opts
  const deps = opts.deps ?? productionDeps()

  if (!configuredProvider) {
    throw new Error('query requires a request-scoped provider')
  }
  const provider = configuredProvider
  const resolvedModel = model ?? provider.defaultModelId()

  let finalText = ''
  let currentTodos: TodoItem[] = []
  const unsubTodo = eventBus.on('todo_update', data => {
    currentTodos = (data as { todos: TodoItem[] }).todos
  })

  const activeTools = { ...tools }
  if (toolUseContext) {
    toolUseContext.options.tools = activeTools
  }
  const pool = deferredToolPool ? { ...deferredToolPool } : undefined
  const toolPolicy: ConcurrencyPolicyFn = concurrencyPolicy ?? (() => false)
  let activeSystemPrompt = systemPrompt
  let planBuildPending = false
  /** Consecutive steps that stopped at the output token limit. */
  let truncationRecoveries = 0
  let outputTokensOverride: number | undefined

  const compactEnrichment: CompactEnrichment | undefined = toolUseContext
    ? {
        toolNames: Object.keys(activeTools),
        getInvokedSkills: () =>
          getInvokedSkillsForAgent(toolUseContext.session, null),
      }
    : undefined

  const applyPermissionModeRefresh = (newMode: string) => {
    if (refreshTools) {
      syncToolSet(activeTools, refreshTools())
      console.log(
        `[${agentLogTag(logLabel)}] refreshed tools for mode=${newMode}: ${Object.keys(activeTools).join(', ')}`,
      )
    }
    if (refreshSystemPrompt) {
      void Promise.resolve(refreshSystemPrompt()).then(prompt => {
        activeSystemPrompt = prompt
        console.log(
          `[${agentLogTag(logLabel)}] refreshed system prompt for mode=${newMode}`,
        )
      })
    }
  }

  const unsubPlanReady = eventBus.on('plan_ready', data => {
    if ((data as { approved?: boolean }).approved) {
      planBuildPending = true
    }
  })

  const unsubMode = eventBus.on('mode_changed', data => {
    const newMode = (data as { mode?: string }).mode
    if (!newMode) return
    applyPermissionModeRefresh(newMode)
  })

  const stepLimit =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.POSITIVE_INFINITY

  const dumpPrompts = createDumpRecorder(sessionId, logLabel)
  const finalizeQuery = (
    reason: QueryStopReason,
    text: string,
  ): QueryResult => {
    emitTurnEnd(
      sessionId,
      onTurnEnd,
      {
        messages: getActiveModelMessages(messages, sessionId),
        systemPrompt: activeSystemPrompt,
        tools: { ...activeTools },
        provider,
        model: resolvedModel,
        sessionId,
        cwd,
      },
      reason,
    )
    return { finalText: text, messages, reason }
  }

  try {
    for (let step = 0; step < stepLimit; step++) {
      if (abortSignal?.aborted) {
        const text = finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
        return finalizeQuery('aborted', text)
      }
      wire.stepStart(step)
      const stepStart = Date.now()

      const activeMessages = await deps.preTurn({
        messages,
        eventBus,
        wire,
        step,
        resolvedModel,
        provider,
        currentTodos,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
        logLabel,
        readFileState: toolUseContext?.readFileState,
        runAgent,
        systemPrompt: activeSystemPrompt,
        tools: activeTools,
      })

      if (abortSignal?.aborted) {
        const text = finalizeInterruptedTurn(messages, wire, {
          toolUse: false,
          finalText,
          signal: abortSignal,
        })
        return finalizeQuery('aborted', text)
      }

      wire.turnState('requesting', 'model.request', 'Waiting for model')
      const stepResult = await deps.runStep({
        messages,
        modelMessages: activeMessages,
        tools: activeTools,
        systemPrompt: activeSystemPrompt,
        provider,
        resolvedModel,
        eventBus,
        wire,
        subagentNames,
        step,
        stepStart,
        currentTodos,
        concurrencyPolicy: toolPolicy,
        getToolDefinition,
        canUseTool,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
        logLabel,
        abortSignal,
        readFileState: toolUseContext?.readFileState,
        dumpPrompts,
        runAgent,
        turnProfiler,
        maxOutputTokensOverride: outputTokensOverride,
      })

      if (stepResult === null) {
        if (abortSignal?.aborted) {
          const text = finalizeInterruptedTurn(messages, wire, {
            toolUse: false,
            finalText,
            signal: abortSignal,
          })
          return finalizeQuery('aborted', text)
        }
        const text = extractPartialResult(messages) ?? finalText
        return finalizeQuery('error', text)
      }

      if (stepResult.aborted) {
        const text =
          extractPartialResult(messages) ?? (finalText || stepResult.text || '')
        return finalizeQuery('aborted', text)
      }

      // A truncated step is recoverable even when a tool input was cut off:
      // fall through so the committed prefix gets a continuation nudge below.
      if (!stepResult.completedCleanly && !stepResult.truncated) {
        // runStep has already committed every complete assistant/tool pair.
        // Persist that valid prefix, but never turn an interrupted stream into
        // a successful turn or replay tools that may already have side effects.
        await onStepCommitted?.(messages)
        const text =
          extractPartialResult(messages) ?? (finalText || stepResult.text || '')
        wire.error(
          stepResult.completionError ??
            'Upstream stream ended before the response completed.',
        )
        return finalizeQuery('error', text)
      }

      // Tools are settled; show planning while the step is committed so the UI
      // has no status gap between the last tool row and the next request.
      if (stepResult.toolCalls.length > 0) wire.thinking()

      await deps.postTurn({
        step,
        stepResult,
        messages,
        activeTools,
        deferredPool: pool,
        eventBus,
        memoryPrefetch,
        toolUseContext,
        sessionId,
        onAfterStep,
        activeSystemPrompt,
        provider,
        resolvedModel,
        cwd,
        logLabel,
      })
      await onStepCommitted?.(messages)

      const { text, toolCalls } = stepResult
      if (text) finalText = text

      if (
        planBuildPending &&
        toolCalls.some(tc => PLAN_IMPLEMENTATION_TOOLS.has(tc.toolName))
      ) {
        planBuildPending = false
        console.log(
          '[agent] plan approved -- implementation tool called, skipping build kickoff',
        )
      }

      // A cut that only followed complete tool calls needs no nudge: their
      // results carry the turn forward like any other tool step.
      const cutOff =
        stepResult.truncated &&
        (toolCalls.length === 0 || !!stepResult.truncatedToolNames?.length)
      if (cutOff) {
        if (truncationRecoveries >= MAX_TRUNCATION_RECOVERIES) {
          console.warn(
            `[${agentLogTag(logLabel)}] output token limit hit ${truncationRecoveries + 1} times in a row -- giving up`,
          )
          wire.error(
            `The response stopped at the output token limit ${truncationRecoveries + 1} times in a row and is incomplete. ` +
              'Ask for the remaining part, or split the task into smaller pieces.' +
              (outputTokensOverride === undefined
                ? ' To allow longer responses, set maxOutputTokens on the model in settings.json.'
                : ''),
          )
          return finalizeQuery(
            'error',
            extractPartialResult(messages) ?? finalText,
          )
        }
        truncationRecoveries++
        outputTokensOverride ??= escalatedMaxOutputTokens(
          compaction?.maxOutputTokens ?? getMaxOutputTokens(),
          provider.maxOutputTokenCap?.(),
        )
        messages.push(buildTruncationReminder(stepResult.truncatedToolNames))
        console.log(
          `[${agentLogTag(logLabel)}] output token limit hit -- continuation ${truncationRecoveries}/${MAX_TRUNCATION_RECOVERIES}` +
            (stepResult.truncatedToolNames?.length
              ? ` (dropped tool input: ${stepResult.truncatedToolNames.join(', ')})`
              : '') +
            (outputTokensOverride
              ? `, maxOutputTokens=${outputTokensOverride}`
              : ''),
        )
        wire.thinking()
        continue
      }
      truncationRecoveries = 0
      outputTokensOverride = undefined

      if (toolCalls.length === 0) {
        if (planBuildPending) {
          planBuildPending = false
          messages.push(
            ensureMessageUuid({
              role: 'user',
              content: `<system-reminder>
The user approved your plan and expects implementation to start now.
Do not reply with a summary or status update only -- call TodoWrite, Write, Edit, or Bash to make the first code change from the approved plan.
</system-reminder>`,
            }),
          )
          console.log(
            '[agent] plan approved but no tools called -- forcing implementation step',
          )
          wire.thinking()
          continue
        }
        autoCompleteTodos(currentTodos, eventBus, wire)
        wire.done()
        const completedText = extractPartialResult(messages) ?? finalText
        return finalizeQuery('completed', completedText)
      }
    }

    autoCompleteTodos(currentTodos, eventBus, wire)
    let text = extractPartialResult(messages) ?? finalText
    if (typeof maxSteps === 'number' && maxSteps > 0) {
      console.log(
        `[agent] maxSteps=${maxSteps} reached — forcing final answer (tools disabled)`,
      )
      const summary = await deps.forceFinalAnswerOnMaxSteps({
        messages,
        systemPrompt: activeSystemPrompt,
        provider,
        resolvedModel,
        eventBus,
        wire,
        step: maxSteps,
        currentTodos,
        cwd,
        compaction,
        sessionMemory,
        sessionId,
        onFullCompaction,
        compactEnrichment,
      })
      if (summary) {
        text = summary
        finalText = summary
      } else {
        wire.error(`Reached max steps (${maxSteps})`)
      }
      wire.done()
      return finalizeQuery('max_steps', text)
    }
    wire.done()
    return finalizeQuery('completed', text)
  } finally {
    unsubPlanReady()
    unsubMode()
    unsubTodo()
  }
}
