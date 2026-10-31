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
import { agentLogTag, autoCompleteTodos, syncToolSet } from './query/helpers.js'
import { preTurn } from './query/pre-turn.js'
import { postTurn, emitTurnEnd } from './query/post-turn.js'
import { runStep, createDumpRecorder } from './query/run-step.js'
import { forceFinalAnswerOnMaxSteps } from './query/force-final-answer.js'
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
  } = opts

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

      const activeMessages = await preTurn({
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

      const stepResult = await runStep({
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

      await postTurn({
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

      wire.thinking()
    }

    autoCompleteTodos(currentTodos, eventBus, wire)
    let text = extractPartialResult(messages) ?? finalText
    if (typeof maxSteps === 'number' && maxSteps > 0) {
      console.log(
        `[agent] maxSteps=${maxSteps} reached — forcing final answer (tools disabled)`,
      )
      const summary = await forceFinalAnswerOnMaxSteps({
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
