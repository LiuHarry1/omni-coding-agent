import { getInvokedSkillsForAgent } from '../skills/invoked-skills.js'
import type { CompactEnrichment } from '../services/compact/index.js'
import { ensureMessageUuid } from '../services/session-memory/index.js'
import { extractPartialResult } from '../tools/AgentTool/finalizeAgentTool.js'
import { finalizeInterruptedTurn } from '../utils/interrupt.js'
import type { TodoItem } from './types.js'
import type { IProvider } from './llm/types.js'
import type { ConcurrencyPolicyFn } from './concurrency-policy.js'
import type {
  QueryOptions,
  QueryResult,
  QueryStopReason,
} from './query/types.js'
import {
  MAX_TRUNCATION_RECOVERIES,
  agentLogTag,
  buildTruncationReminder,
  escalatedMaxOutputTokens,
  getMaxOutputTokens,
  syncToolSet,
} from './query/helpers.js'
import {
  hookResultMessages,
  hookStopNotice,
  hookStoppedMessage,
} from './hooks/messages.js'
import { productionDeps } from './query/deps.js'
import { emitTurnEnd } from './query/post-turn.js'
import { createDumpRecorder } from './query/run-step.js'
import type { Continue, Terminal } from './query/transitions.js'
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
 * Everything the loop carries from one iteration to the next. Each continue
 * site assigns a whole new value, so a new field has to be decided at every one.
 */
type State = {
  /** 1-based; the step index on the wire and in logs is `turnCount - 1`. */
  turnCount: number
  /** Consecutive steps that stopped at the output token limit. */
  maxOutputTokensRecoveryCount: number
  /** Raised output cap for continuations; undefined uses the default. */
  maxOutputTokensOverride: number | undefined
  /** The endpoint refused a raised cap; continuations stay at the default. */
  outputCapRejected: boolean
  /** The main model stayed overloaded; requests go to the fallback model. */
  usingFallbackModel: boolean
  /** The user approved a plan and no implementation tool has run since. */
  planBuildPending: boolean
  /** Changes when the permission mode does. */
  systemPrompt: string
  /** Text of the latest step that produced any. */
  finalText: string
  /**
   * The model is answering Stop hook feedback. Passed to the next Stop hook
   * as `stop_hook_active` so it can let the turn end instead of looping.
   */
  stopHookActive: boolean
  /** Why the previous iteration continued; undefined on the first. */
  transition: Continue | undefined
}

function stopReasonOf(terminal: Terminal): QueryStopReason {
  switch (terminal.reason) {
    case 'completed':
    case 'hook_stopped':
    case 'stop_hook_prevented':
      return 'completed'
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'aborted'
    case 'max_turns':
      return 'max_steps'
    case 'model_error':
    case 'max_output_tokens':
      return 'error'
  }
}

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
    hooks,
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
  const fallback = opts.fallbackProvider
    ? {
        provider: opts.fallbackProvider,
        model: opts.fallbackProvider.defaultModelId(),
      }
    : undefined
  /** The model requests go to: the fallback once the loop has switched to it. */
  const modelFor = (
    usingFallbackModel: boolean,
  ): { provider: IProvider; model: string } =>
    usingFallbackModel && fallback
      ? fallback
      : { provider, model: resolvedModel }

  let currentTodos: TodoItem[] = toolUseContext?.session.todos ?? []
  const unsubTodo = eventBus.on('todo_update', data => {
    currentTodos = (data as { todos: TodoItem[] }).todos
  })

  const activeTools = { ...tools }
  if (toolUseContext) {
    toolUseContext.options.tools = activeTools
  }
  const pool = deferredToolPool ? { ...deferredToolPool } : undefined
  const toolPolicy: ConcurrencyPolicyFn = concurrencyPolicy ?? (() => false)

  const compactEnrichment: CompactEnrichment | undefined = toolUseContext
    ? {
        toolNames: Object.keys(activeTools),
        getInvokedSkills: () =>
          getInvokedSkillsForAgent(toolUseContext.session, null),
      }
    : undefined

  /**
   * Raised by tools while a step runs. The handlers only take notes; the
   * loop folds them into `state` when the next iteration starts.
   */
  const pendingEvents: { planApproved: boolean; mode: string | undefined } = {
    planApproved: false,
    mode: undefined,
  }

  const unsubPlanReady = eventBus.on('plan_ready', data => {
    if ((data as { approved?: boolean }).approved) {
      pendingEvents.planApproved = true
    }
  })

  const unsubMode = eventBus.on('mode_changed', data => {
    const newMode = (data as { mode?: string }).mode
    if (!newMode) return
    // The tool set cannot wait for the step boundary: it is the only thing
    // keeping a Write queued behind EnterPlanMode in this step from running.
    if (refreshTools) {
      syncToolSet(activeTools, refreshTools())
      console.log(
        `[${agentLogTag(logLabel)}] refreshed tools for mode=${newMode}: ${Object.keys(activeTools).join(', ')}`,
      )
    }
    pendingEvents.mode = newMode
  })

  const applyPendingEvents = async (current: State): Promise<State> => {
    const { planApproved, mode } = pendingEvents
    if (!planApproved && mode === undefined) return current
    pendingEvents.planApproved = false
    pendingEvents.mode = undefined

    let nextSystemPrompt = current.systemPrompt
    if (mode !== undefined && refreshSystemPrompt) {
      try {
        nextSystemPrompt = await refreshSystemPrompt()
        console.log(
          `[${agentLogTag(logLabel)}] refreshed system prompt for mode=${mode}`,
        )
      } catch (err) {
        console.warn(
          `[${agentLogTag(logLabel)}] system prompt refresh for mode=${mode} failed -- keeping the previous prompt: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return {
      turnCount: current.turnCount,
      maxOutputTokensRecoveryCount: current.maxOutputTokensRecoveryCount,
      maxOutputTokensOverride: current.maxOutputTokensOverride,
      outputCapRejected: current.outputCapRejected,
      usingFallbackModel: current.usingFallbackModel,
      planBuildPending: current.planBuildPending || planApproved,
      systemPrompt: nextSystemPrompt,
      finalText: current.finalText,
      stopHookActive: current.stopHookActive,
      transition: current.transition,
    }
  }

  const stepLimit =
    typeof maxSteps === 'number' && maxSteps > 0
      ? maxSteps
      : Number.POSITIVE_INFINITY

  const dumpPrompts = createDumpRecorder(sessionId, logLabel)

  let state: State = {
    turnCount: 1,
    maxOutputTokensRecoveryCount: 0,
    maxOutputTokensOverride: undefined,
    outputCapRejected: false,
    usingFallbackModel: false,
    planBuildPending: false,
    systemPrompt,
    finalText: '',
    stopHookActive: false,
    transition: undefined,
  }
  const transitions: Continue[] = []

  /**
   * The only way out of the loop. Emits the turn's single result event (an
   * abort has its interrupt marker instead) and returns the outcome. Todos
   * are left as the model last wrote them on every exit.
   */
  const finish = (terminal: Terminal, text: string): QueryResult => {
    switch (terminal.reason) {
      case 'completed':
        wire.done()
        break
      case 'hook_stopped':
      case 'stop_hook_prevented':
        // Say why the turn ended here; nothing else on screen would.
        wire.textDelta(`\n\n${terminal.notice}`)
        wire.done()
        break
      case 'max_turns':
        if (terminal.summarized) wire.done()
        else wire.error(`Reached max steps (${stepLimit})`)
        break
      case 'model_error':
        wire.error(terminal.error)
        break
      case 'max_output_tokens': {
        const hits = state.maxOutputTokensRecoveryCount + 1
        wire.error(
          `The response stopped at the output token limit ${hits} times in a row and is incomplete. ` +
            'Ask for the remaining part, or split the task into smaller pieces.' +
            (state.maxOutputTokensOverride === undefined &&
            !state.outputCapRejected
              ? ' To allow longer responses, set maxOutputTokens on the model in settings.json.'
              : ''),
        )
        break
      }
      case 'aborted_streaming':
      case 'aborted_tools':
        // The interrupt marker was written where the abort was noticed.
        break
    }
    const reason = stopReasonOf(terminal)
    emitTurnEnd(
      sessionId,
      onTurnEnd,
      {
        messages: getActiveModelMessages(messages, sessionId),
        systemPrompt: state.systemPrompt,
        tools: { ...activeTools },
        ...modelFor(state.usingFallbackModel),
        sessionId,
        cwd,
      },
      reason,
    )
    return { finalText: text, messages, reason, terminal, transitions }
  }

  try {
    while (true) {
      state = await applyPendingEvents(state)
      const {
        turnCount,
        maxOutputTokensRecoveryCount,
        maxOutputTokensOverride,
        outputCapRejected: capRejectedBefore,
        usingFallbackModel,
        planBuildPending,
        systemPrompt: activeSystemPrompt,
        finalText: priorText,
        stopHookActive,
        transition,
      } = state
      if (transition) transitions.push(transition)
      const step = turnCount - 1
      const requestModel = modelFor(usingFallbackModel)

      /** Abort noticed between requests: nothing in flight to salvage. */
      const finishInterrupted = (): QueryResult =>
        finish(
          { reason: 'aborted_streaming' },
          finalizeInterruptedTurn(messages, wire, {
            toolUse: false,
            finalText: priorText,
            signal: abortSignal,
          }),
        )

      if (turnCount > stepLimit) {
        const text = extractPartialResult(messages) ?? priorText
        console.log(
          `[agent] maxSteps=${stepLimit} reached — forcing final answer (tools disabled)`,
        )
        const summary = await deps.forceFinalAnswerOnMaxSteps({
          messages,
          systemPrompt: activeSystemPrompt,
          provider: requestModel.provider,
          resolvedModel: requestModel.model,
          eventBus,
          wire,
          step: stepLimit,
          currentTodos,
          cwd,
          compaction,
          sessionMemory,
          sessionId,
          onFullCompaction,
          compactEnrichment,
        })
        return finish(
          { reason: 'max_turns', turnCount, summarized: summary !== '' },
          summary || text,
        )
      }

      if (abortSignal?.aborted) return finishInterrupted()
      wire.stepStart(step)
      const stepStart = Date.now()

      const activeMessages = await deps.preTurn({
        messages,
        eventBus,
        wire,
        step,
        resolvedModel: requestModel.model,
        provider: requestModel.provider,
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

      if (abortSignal?.aborted) return finishInterrupted()

      wire.turnState('requesting', 'model.request', 'Waiting for model')
      const stepResult = await deps.runStep({
        messages,
        modelMessages: activeMessages,
        tools: activeTools,
        systemPrompt: activeSystemPrompt,
        provider: requestModel.provider,
        resolvedModel: requestModel.model,
        fallback: usingFallbackModel ? undefined : fallback,
        eventBus,
        wire,
        subagentNames,
        step,
        stepStart,
        currentTodos,
        concurrencyPolicy: toolPolicy,
        getToolDefinition,
        canUseTool,
        hooks,
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
        maxOutputTokensOverride,
      })

      if (stepResult.aborted) {
        return finish(
          {
            reason:
              stepResult.abortPhase === 'tools'
                ? 'aborted_tools'
                : 'aborted_streaming',
          },
          extractPartialResult(messages) ??
            (priorText || stepResult.text || ''),
        )
      }

      // The switch holds for the rest of the query. What was learned about
      // the main model's output cap says nothing about the fallback's.
      const fellBack = stepResult.modelFallback === true
      const onFallbackModel = usingFallbackModel || fellBack
      const stepModel = modelFor(onFallbackModel)
      // Recorded at once so an exit from this very step reports the model
      // that actually answered.
      if (fellBack) state = { ...state, usingFallbackModel: true }

      // A truncated step is recoverable even when a tool input was cut off:
      // fall through so the committed prefix gets a continuation nudge below.
      if (!stepResult.completedCleanly && !stepResult.truncated) {
        // An abort that raced the failure is still an abort.
        if (abortSignal?.aborted) return finishInterrupted()
        // runStep has already committed every complete assistant/tool pair.
        // Persist that valid prefix, but never turn an interrupted stream into
        // a successful turn or replay tools that may already have side effects.
        await onStepCommitted?.(messages)
        return finish(
          {
            reason: 'model_error',
            error:
              stepResult.completionError ??
              'Upstream stream ended before the response completed.',
          },
          extractPartialResult(messages) ??
            (priorText || stepResult.text || ''),
        )
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
        provider: stepModel.provider,
        resolvedModel: stepModel.model,
        cwd,
        logLabel,
      })
      await onStepCommitted?.(messages)

      const { toolCalls } = stepResult
      const finalText = stepResult.text || priorText

      // A PreToolUse / PostToolUse hook answered `continue: false`. The tool
      // results are committed; the model is not asked again.
      if (stepResult.hookStopped !== undefined) {
        return finish(
          {
            reason: 'hook_stopped',
            notice: hookStopNotice(stepResult.hookStopped),
          },
          extractPartialResult(messages) ?? finalText,
        )
      }

      // Implementation has begun, so no kickoff is owed -- also when the
      // approval arrived during this very step and is still waiting in
      // `pendingEvents`.
      const implementing = toolCalls.some(tc =>
        PLAN_IMPLEMENTATION_TOOLS.has(tc.toolName),
      )
      if (implementing && (planBuildPending || pendingEvents.planApproved)) {
        pendingEvents.planApproved = false
        console.log(
          '[agent] plan approved -- implementation tool called, skipping build kickoff',
        )
      }
      const kickoffOwed = planBuildPending && !implementing
      const outputCapRejected =
        !fellBack &&
        (capRejectedBefore || stepResult.outputCapRejected === true)

      // A cut that only followed complete tool calls needs no nudge: their
      // results carry the turn forward like any other tool step.
      const cutOff =
        stepResult.truncated &&
        (toolCalls.length === 0 || !!stepResult.truncatedToolNames?.length)
      if (cutOff) {
        if (maxOutputTokensRecoveryCount >= MAX_TRUNCATION_RECOVERIES) {
          console.warn(
            `[${agentLogTag(logLabel)}] output token limit hit ${maxOutputTokensRecoveryCount + 1} times in a row -- giving up`,
          )
          return finish(
            { reason: 'max_output_tokens' },
            extractPartialResult(messages) ?? finalText,
          )
        }
        const attempt = maxOutputTokensRecoveryCount + 1
        const override = outputCapRejected
          ? undefined
          : ((fellBack ? undefined : maxOutputTokensOverride) ??
            escalatedMaxOutputTokens(
              compaction?.maxOutputTokens ?? getMaxOutputTokens(),
              stepModel.provider.maxOutputTokenCap?.(),
            ))
        messages.push(buildTruncationReminder(stepResult.truncatedToolNames))
        console.log(
          `[${agentLogTag(logLabel)}] output token limit hit -- continuation ${attempt}/${MAX_TRUNCATION_RECOVERIES}` +
            (stepResult.truncatedToolNames?.length
              ? ` (dropped tool input: ${stepResult.truncatedToolNames.join(', ')})`
              : '') +
            (override ? `, maxOutputTokens=${override}` : ''),
        )
        wire.thinking()
        state = {
          turnCount: turnCount + 1,
          maxOutputTokensRecoveryCount: attempt,
          maxOutputTokensOverride: override,
          outputCapRejected,
          usingFallbackModel: onFallbackModel,
          planBuildPending: kickoffOwed,
          systemPrompt: activeSystemPrompt,
          finalText,
          stopHookActive: false,
          transition: { reason: 'max_output_tokens_recovery', attempt },
        }
        continue
      }

      if (toolCalls.length === 0) {
        if (!kickoffOwed) {
          // The model is done. Stop hooks may end the turn with a reason of
          // their own, or send it back to work with feedback.
          if (hooks?.has('Stop')) {
            wire.turnState('tool-use', 'hooks.stop', 'Running Stop hooks')
            const stop = await hooks.stop(stopHookActive, abortSignal)
            if (abortSignal?.aborted) return finishInterrupted()
            const notes = hookResultMessages(stop)
            for (const note of notes) {
              messages.push(ensureMessageUuid(note))
            }
            if (notes.length > 0) await onStepCommitted?.(messages)
            if (stop.preventContinuation) {
              return finish(
                {
                  reason: 'stop_hook_prevented',
                  notice: hookStopNotice(hookStoppedMessage(stop)),
                },
                extractPartialResult(messages) ?? finalText,
              )
            }
            if (stop.blockingErrors.length > 0) {
              for (const { blockingError } of stop.blockingErrors) {
                messages.push(
                  ensureMessageUuid({
                    role: 'user',
                    content: `Stop hook feedback:\n${blockingError}`,
                    isMeta: true,
                  }),
                )
              }
              await onStepCommitted?.(messages)
              console.log(
                `[${agentLogTag(logLabel)}] Stop hook blocked the ending -- continuing with its feedback`,
              )
              wire.thinking()
              state = {
                turnCount: turnCount + 1,
                maxOutputTokensRecoveryCount: 0,
                maxOutputTokensOverride: undefined,
                outputCapRejected,
                usingFallbackModel: onFallbackModel,
                planBuildPending: false,
                systemPrompt: activeSystemPrompt,
                finalText,
                stopHookActive: true,
                transition: { reason: 'stop_hook_blocking' },
              }
              continue
            }
          }
          return finish(
            { reason: 'completed' },
            extractPartialResult(messages) ?? finalText,
          )
        }
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
        state = {
          turnCount: turnCount + 1,
          maxOutputTokensRecoveryCount: 0,
          maxOutputTokensOverride: undefined,
          outputCapRejected,
          usingFallbackModel: onFallbackModel,
          planBuildPending: false,
          systemPrompt: activeSystemPrompt,
          finalText,
          stopHookActive: false,
          transition: { reason: 'plan_build_kickoff' },
        }
        continue
      }

      state = {
        turnCount: turnCount + 1,
        maxOutputTokensRecoveryCount: 0,
        maxOutputTokensOverride: undefined,
        outputCapRejected,
        usingFallbackModel: onFallbackModel,
        planBuildPending: kickoffOwed,
        systemPrompt: activeSystemPrompt,
        finalText,
        stopHookActive,
        transition: { reason: 'next_turn' },
      }
    }
  } finally {
    unsubPlanReady()
    unsubMode()
    unsubTodo()
  }
}
