import { ensureMessageUuid } from '../../services/session-memory/index.js'
import type { CompactEnrichment } from '../../services/compact/index.js'
import type { AgentOptions, Message, TodoItem } from '../types.js'
import type { IProvider } from '../../services/llm/types.js'
import type { WireEmitter } from '../wire-emitter.js'
import { extractPartialResult } from '../../tools/AgentTool/finalizeAgentTool.js'
import { runStep } from './run-step.js'

export async function forceFinalAnswerOnMaxSteps(input: {
  messages: Message[]
  systemPrompt: string
  provider: IProvider
  resolvedModel: string
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  step: number
  currentTodos: TodoItem[]
  cwd?: string
  compaction?: AgentOptions['compaction']
  sessionMemory?: AgentOptions['sessionMemory']
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
}): Promise<string> {
  input.messages.push(
    ensureMessageUuid({
      role: 'user',
      content: `<system-reminder>
You have reached the maximum number of agent steps (${input.step}).
Tool-calling budget is exhausted. Write a clear, self-contained final report of
what you learned and accomplished so far. Respond in plain text / markdown only
— do not call any tools.
</system-reminder>`,
    }),
  )
  input.wire.stepStart(input.step)
  const stepStart = Date.now()
  try {
    const stepResult = await runStep({
      messages: input.messages,
      tools: {},
      toolChoice: 'none',
      systemPrompt: input.systemPrompt,
      provider: input.provider,
      resolvedModel: input.resolvedModel,
      eventBus: input.eventBus,
      wire: input.wire,
      step: input.step,
      stepStart,
      currentTodos: input.currentTodos,
      concurrencyPolicy: () => false,
      cwd: input.cwd,
      compaction: input.compaction,
      sessionMemory: input.sessionMemory,
      sessionId: input.sessionId,
      onFullCompaction: input.onFullCompaction,
      compactEnrichment: input.compactEnrichment,
    })
    const fromStep = stepResult.text.trim()
    if (fromStep) return fromStep
    // A failed request produced no summary; earlier text must not pass for one.
    if (stepResult.completionError) return ''
    return extractPartialResult(input.messages) ?? ''
  } catch (err) {
    console.warn(`[agent] forceFinalAnswerOnMaxSteps failed: ${err}`)
    return extractPartialResult(input.messages) ?? ''
  }
}
