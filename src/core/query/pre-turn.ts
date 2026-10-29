import {
  applyMicroCompactProjection,
  compactIfNeeded,
  isSummarizingCompactSource,
  tokenCountWithEstimation,
} from '../../services/compact/index.js'
import type {
  CompactEnrichment,
  CompactOutcome,
} from '../../services/compact/index.js'
import type {
  AgentOptions,
  AnyTool,
  Message,
  RunAgentFn,
  TodoItem,
} from '../types.js'
import type { IProvider } from '../llm/types.js'
import { createCacheSafeParams } from '../forked-agent.js'
import type { WireEmitter } from '../wire-emitter.js'
import type { CompactionConfig, SessionMemoryConfig } from '../types.js'
import { agentLogTag, attachTodoReminderAfterCompaction } from './helpers.js'
import { getMessagesAfterCompactBoundary } from '../messages/compact-boundary.js'

export function applyFullCompaction(
  messages: Message[],
  appendMessages: Message[],
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
  sessionId?: string,
): Message[] {
  const appendStart = messages.length
  messages.push(...appendMessages)
  attachTodoReminderAfterCompaction(messages, currentTodos)
  onFullCompaction?.(messages.slice(appendStart))
  // The preserved tail is rebuilt from raw history; its micro-clears must be
  // reapplied or the request carries every payload compaction just dropped.
  return applyMicroCompactProjection(
    getMessagesAfterCompactBoundary(messages),
    sessionId,
  )
}

/**
 * Apply compactIfNeeded's outcome. Microcompact returns an ephemeral model
 * view. Session-memory / full compact append events to the complete
 * transcript and return its newly projected active view.
 */
export function applyCompactOutcome(
  messages: Message[],
  outcome: CompactOutcome,
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
  sessionId?: string,
): Message[] {
  if (outcome.source === 'none') {
    return outcome.messages
  }
  if (outcome.source === 'micro') {
    return outcome.messages
  }
  return applyFullCompaction(
    messages,
    outcome.appendMessages ?? outcome.messages,
    currentTodos,
    onFullCompaction,
    sessionId,
  )
}

export async function preTurn(input: {
  messages: Message[]
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  step: number
  resolvedModel: string
  provider: IProvider
  currentTodos: TodoItem[]
  cwd?: string
  compaction?: CompactionConfig
  sessionMemory?: SessionMemoryConfig
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
  logLabel?: string
  readFileState?: import('../../utils/read/types.js').ReadFileState
  runAgent?: RunAgentFn
  systemPrompt: string
  tools: Record<string, AnyTool>
}): Promise<Message[]> {
  const activeMessages = applyMicroCompactProjection(
    getMessagesAfterCompactBoundary(input.messages),
    input.sessionId,
  )
  const cacheSafeParams = input.runAgent
    ? createCacheSafeParams({
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        provider: input.provider,
        model: input.resolvedModel,
        messages: activeMessages,
      })
    : undefined
  const compactStart = Date.now()
  const outcome = await compactIfNeeded(
    activeMessages,
    input.eventBus,
    input.wire,
    input.resolvedModel,
    input.cwd ?? process.cwd(),
    input.currentTodos,
    {
      enrichment: input.compactEnrichment,
      sessionMemory: input.sessionMemory,
      readFileState: input.readFileState,
      runAgent: input.runAgent,
      cacheSafeParams,
    },
    input.compaction,
    input.provider,
    input.sessionId,
  )
  const managed = applyCompactOutcome(
    input.messages,
    outcome,
    input.currentTodos,
    input.onFullCompaction,
    input.sessionId,
  )
  const compactMs = Date.now() - compactStart

  const counted = tokenCountWithEstimation(managed)
  const tokenLabel =
    counted.source === 'real+est'
      ? `${counted.total.toLocaleString()} tokens ` +
        `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
      : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`
  const tag = agentLogTag(input.logLabel)
  const compactNote =
    outcome.source === 'none'
      ? ''
      : isSummarizingCompactSource(outcome.source)
        ? `, compaction=${compactMs}ms source=${outcome.source}`
        : `, microcompact=${compactMs}ms`
  console.log(
    `[${tag}] step ${input.step} start -- ${managed.length} active msgs (${input.messages.length} transcript), ${tokenLabel}, ` +
      `model=${input.resolvedModel}, llm=${input.provider.describe()}` +
      (compactMs > 50 || outcome.source !== 'none' ? compactNote : ''),
  )
  return managed
}
