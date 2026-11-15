import { ensureMessageUuid } from '../../services/session-memory/index.js'
import { consumeMemoryPrefetchIfReady } from '../../services/auto-memory/prefetch.js'
import { getAttachmentMessages } from '../../utils/attachments.js'
import type {
  AgentLifecycleSnapshot,
  AgentOptions,
  AnyTool,
  Message,
} from '../types.js'
import type { IProvider } from '../../services/llm/types.js'
import type { StreamResult } from '../agent/streamConsumer.js'
import { agentLogTag, activateDeferredTools } from './helpers.js'
import type { QueryStopReason } from './types.js'
import { getActiveModelMessages } from '../../services/compact/index.js'

export async function postTurn(input: {
  step: number
  stepResult: StreamResult
  messages: Message[]
  activeTools: Record<string, AnyTool>
  deferredPool?: Record<string, AnyTool>
  eventBus: AgentOptions['eventBus']
  memoryPrefetch?: AgentOptions['memoryPrefetch']
  toolUseContext?: AgentOptions['toolUseContext']
  sessionId?: string
  onAfterStep?: (ctx: AgentLifecycleSnapshot) => void
  activeSystemPrompt: string
  provider: IProvider
  resolvedModel: string
  cwd?: string
  logLabel?: string
}): Promise<void> {
  const {
    step,
    stepResult,
    messages,
    activeTools,
    deferredPool,
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
  } = input

  try {
    const memAtts = await consumeMemoryPrefetchIfReady(
      memoryPrefetch,
      toolUseContext?.readFileState,
      step,
    )
    for (const att of memAtts) {
      messages.push(ensureMessageUuid(att))
    }
    if (memAtts.length > 0) {
      console.log(
        `[${agentLogTag(logLabel)}] relevant_memories attached count=${memAtts.length} step=${step}`,
      )
    }
  } catch (e) {
    console.warn(
      `[${agentLogTag(logLabel)}] memory prefetch consume failed: ${
        e instanceof Error ? e.message : e
      }`,
    )
  }

  if (sessionId && onAfterStep) {
    onAfterStep({
      messages: getActiveModelMessages(messages, sessionId),
      systemPrompt: activeSystemPrompt,
      tools: { ...activeTools },
      provider,
      model: resolvedModel,
      sessionId,
      cwd,
    })
  }

  if (deferredPool) {
    const newlyDiscovered = new Set<string>()
    activateDeferredTools(
      stepResult.toolCalls,
      deferredPool,
      activeTools,
      newlyDiscovered,
    )
    if (newlyDiscovered.size > 0) {
      eventBus.emit('tools_discovered', {
        tools: [...newlyDiscovered],
      })
    }
  }

  if (toolUseContext) {
    for await (const att of getAttachmentMessages(
      null,
      toolUseContext,
      messages,
    )) {
      messages.push(ensureMessageUuid(att))
    }
  }
}

export function emitTurnEnd(
  sessionId: string | undefined,
  onTurnEnd: AgentOptions['onTurnEnd'] | undefined,
  snapshot: AgentLifecycleSnapshot,
  reason: QueryStopReason,
): void {
  // A cancelled/error turn stays behind the extraction cursor. The next
  // successfully finalized turn can still extract the useful complete range.
  if (
    sessionId &&
    onTurnEnd &&
    (reason === 'completed' || reason === 'max_steps')
  ) {
    onTurnEnd(snapshot)
  }
}
