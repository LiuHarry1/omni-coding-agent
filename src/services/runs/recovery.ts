import { randomUUID } from 'crypto'
import { EventBus } from '../../core/event-bus.js'
import type {
  AssistantContentPart,
  Message,
  RunAgentFn,
  ToolResultPart,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../../server/quota.js'
import { attachUsageTelemetry, flushUsage } from '../../server/telemetry.js'
import {
  appendMessage,
  appendUnknownToolResults,
  getSession,
} from '../../session/index.js'
import { listSessionAgentHomes } from '../../session/session-index.js'
import {
  runChatTurn,
  type RunChatTurnInput,
  type RunChatTurnResult,
} from '../../turn/run-chat-turn.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  adoptInterruptedRun,
  checkpointDurableRun,
  failDurableRun,
  finalizeCancelledRun,
  startDurableRun,
} from './run-manager.js'
import {
  calibrateActiveRunPointers,
  listRunStates,
  readRunEvents,
} from './run-store.js'
import type { DurableRunState } from './types.js'
import { isTerminalRunStatus } from './types.js'

const MAX_RECOVERY_ATTEMPTS = 3
export const UNKNOWN_TOOL_RESULT =
  'Outcome unknown because the Worker or control plane disconnected before ' +
  'the result was acknowledged. Inspect the workspace or external system ' +
  'before deciding whether to retry this operation.'

type EventRepairResult = {
  repaired: number
  unknown: number
  throughSeq: number
}

/**
 * A Worker may execute a tool before the model SDK commits that step to the
 * transcript. Durable wire events are the write-ahead intent/result ledger
 * for that crash window.
 */
export function repairUncheckpointedRunEvents(
  state: DurableRunState,
  messages: Message[],
): EventRepairResult {
  const rows = readRunEvents(state, state.checkpointSeq)
  const existingCalls = new Set<string>()
  const existingResults = new Set<string>()
  for (const message of messages) {
    if (!isRoleMessage(message)) continue
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type !== 'tool-call') continue
        existingCalls.add(part.toolCallId)
      }
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') existingResults.add(part.toolCallId)
      }
    }
  }

  const calls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >()
  const results = new Map<
    string,
    {
      result: string
      toolUseResult?: unknown
      isError?: boolean
    }
  >()
  let throughSeq = state.checkpointSeq
  for (const row of rows) {
    const event = row.event as unknown as Record<string, unknown>
    if (typeof event.parent_tool_use_id === 'string') continue
    if (
      event.type === 'tool_call' &&
      typeof event.tool_use_id === 'string' &&
      typeof event.name === 'string'
    ) {
      const rawInput = event.args
      const input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : { value: rawInput }
      calls.set(event.tool_use_id, {
        name: event.name,
        input,
      })
      throughSeq = Math.max(throughSeq, row.seq)
    } else if (
      event.type === 'tool_result' &&
      typeof event.tool_use_id === 'string'
    ) {
      const rawResult = event.result
      let result: string
      if (typeof rawResult === 'string') result = rawResult
      else {
        try {
          result = JSON.stringify(rawResult ?? '')
        } catch {
          result = String(rawResult ?? '')
        }
      }
      results.set(event.tool_use_id, {
        result,
        toolUseResult: event.tool_use_result,
        isError: event.is_error === true,
      })
      throughSeq = Math.max(throughSeq, row.seq)
    }
  }

  const missingCalls = [...calls.entries()].filter(
    ([toolCallId]) => !existingCalls.has(toolCallId),
  )
  if (missingCalls.length > 0) {
    const content: AssistantContentPart[] = missingCalls.map(
      ([toolCallId, call]) => ({
        type: 'tool-call',
        toolCallId,
        toolName: call.name,
        input: call.input,
      }),
    )
    const assistant: Message = {
      role: 'assistant',
      uuid: randomUUID(),
      content,
    }
    messages.push(assistant)
    appendMessage(state.sessionId, assistant)
    for (const [toolCallId] of missingCalls) existingCalls.add(toolCallId)
  }

  const recoveredResults: ToolResultPart[] = []
  let unknown = 0
  for (const [toolCallId, call] of calls) {
    if (existingResults.has(toolCallId)) continue
    const known = results.get(toolCallId)
    if (known) {
      recoveredResults.push({
        type: 'tool-result',
        toolCallId,
        toolName: call.name,
        output: { type: 'text', value: known.result },
        toolUseResult: known.toolUseResult,
        isError: known.isError,
      })
    } else {
      unknown++
      recoveredResults.push({
        type: 'tool-result',
        toolCallId,
        toolName: call.name,
        output: { type: 'text', value: UNKNOWN_TOOL_RESULT },
        toolUseResult: { status: 'unknown', reason: 'worker_lost' },
        isError: true,
      })
    }
  }
  if (recoveredResults.length > 0) {
    const toolMessage: Message = {
      role: 'tool',
      uuid: randomUUID(),
      content: recoveredResults,
    }
    messages.push(toolMessage)
    appendMessage(state.sessionId, toolMessage)
  }

  return {
    repaired: missingCalls.length + recoveredResults.length,
    unknown,
    throughSeq,
  }
}

export function repairUnknownToolOutcomes(
  sessionId: string,
  messages: Message[],
): number {
  let repaired = 0
  for (let i = 0; i < messages.length; i++) {
    const assistant = messages[i]
    if (
      !assistant ||
      !isRoleMessage(assistant) ||
      assistant.role !== 'assistant' ||
      !Array.isArray(assistant.content)
    ) {
      continue
    }
    const calls = assistant.content
      .filter(part => part.type === 'tool-call')
      .map(part => ({
        id: part.toolCallId,
        name: part.toolName,
      }))
    if (calls.length === 0) continue

    const next = messages[i + 1]
    const existing =
      next && isRoleMessage(next) && next.role === 'tool'
        ? new Set(
            next.content
              .filter(part => part.type === 'tool-result')
              .map(part => part.toolCallId),
          )
        : new Set<string>()
    const missing = calls.filter(call => !existing.has(call.id))
    if (missing.length === 0) continue

    const results: ToolResultPart[] = missing.map(call => ({
      type: 'tool-result',
      toolCallId: call.id,
      toolName: call.name,
      output: { type: 'text', value: UNKNOWN_TOOL_RESULT },
      toolUseResult: { status: 'unknown', reason: 'worker_lost' },
      isError: true,
    }))
    if (!assistant.uuid) assistant.uuid = randomUUID()

    let toolMessageUuid: string
    if (next && isRoleMessage(next) && next.role === 'tool') {
      if (!next.uuid) next.uuid = randomUUID()
      next.content.push(...results)
      toolMessageUuid = next.uuid
    } else {
      toolMessageUuid = randomUUID()
      messages.splice(i + 1, 0, {
        role: 'tool',
        uuid: toolMessageUuid,
        content: results,
      })
      i++
    }
    appendUnknownToolResults(
      sessionId,
      assistant.uuid,
      toolMessageUuid,
      results,
    )
    repaired += results.length
  }
  return repaired
}

async function recoverOne(
  state: DurableRunState,
  runAgent: RunAgentFn,
  runTurn: (input: RunChatTurnInput) => Promise<RunChatTurnResult>,
): Promise<void> {
  await runWithRequestScope(
    { agentHome: state.agentHome, cwd: state.cwd },
    async () => {
      if (state.attempt >= MAX_RECOVERY_ATTEMPTS) {
        failDurableRun(
          state,
          `Recovery attempt limit reached (${MAX_RECOVERY_ATTEMPTS})`,
        )
        return
      }
      const session = getSession(state.sessionId, {
        agentHome: state.agentHome,
      })
      if (!session) {
        failDurableRun(state, 'Session missing during run recovery')
        return
      }
      if (shouldEnforceQuota(state.ownerEmail, state.ownerRole)) {
        try {
          const quota = await checkQuota(state.ownerEmail!)
          if (quota.exceeded) {
            failDurableRun(
              state,
              'Daily token limit exceeded during run recovery',
            )
            return
          }
        } catch (error) {
          console.warn(
            `[quota] recovery status check failed: ${(error as Error).message}`,
          )
        }
      }
      const hadPendingInteraction = state.status === 'requires_action'
      if (!adoptInterruptedRun(state)) {
        failDurableRun(
          state,
          'Another Run already owns this Session during recovery',
        )
        return
      }

      try {
        const eventRepair = repairUncheckpointedRunEvents(
          state,
          session.messages,
        )
        const unknownCount =
          eventRepair.unknown +
          repairUnknownToolOutcomes(session.id, session.messages)
        if (eventRepair.repaired > 0) {
          checkpointDurableRun(state.runId, {
            checkpointSeq: eventRepair.throughSeq,
            lastMessageUuid: [...session.messages]
              .reverse()
              .find(message => typeof message.uuid === 'string')?.uuid,
          })
        }
        const hasOpeningMessage =
          !!state.openingMessageUuid &&
          session.messages.some(
            message => message.uuid === state.openingMessageUuid,
          )
        if (!hasOpeningMessage && !state.requestPayload?.message) {
          failDurableRun(
            state,
            'Original request missing before recovery checkpoint',
          )
          return
        }
        const recoveryPrompt = `<system-reminder>
The previous agent process stopped before this run reached a terminal state.
Continue the original user task from the durable transcript and current workspace.
${
  unknownCount > 0
    ? `${unknownCount} tool operation(s) have an unknown outcome. Inspect their effects before retrying; never assume they did not run.`
    : 'Verify the current workspace state before continuing.'
}
${
  hadPendingInteraction
    ? 'The previous permission or user-input request expired with the process. Ask for that interaction again before depending on it.'
    : ''
}
</system-reminder>`

        const eventBus = new EventBus()
        const turnUsage = { tokens: 0 }
        const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)
        const unsubTelemetry = attachUsageTelemetry(eventBus, {
          sessionId: session.id,
          userEmail: state.ownerEmail,
        })
        const quotaEventId = `${session.id}:run:${state.runId}:attempt:${state.attempt + 1}`

        void startDurableRun(
          state.runId,
          async (transport, _state, abortSignal) => {
            try {
              return await runTurn({
                message: hasOpeningMessage
                  ? recoveryPrompt
                  : state.requestPayload!.message,
                session,
                cwd: state.cwd,
                runAgent,
                transport,
                images: hasOpeningMessage
                  ? undefined
                  : state.requestPayload?.images,
                attachments: hasOpeningMessage
                  ? undefined
                  : state.requestPayload?.attachments,
                isMeta: hasOpeningMessage,
                mode: state.mode,
                eventBus,
                durableRunId: state.runId,
                abortSignal,
              })
            } finally {
              unsubTurnTokens()
              unsubTelemetry()
              if (
                shouldEnforceQuota(state.ownerEmail, state.ownerRole) &&
                turnUsage.tokens > 0
              ) {
                try {
                  await commitQuota(
                    state.ownerEmail!,
                    turnUsage.tokens,
                    quotaEventId,
                  )
                } catch (error) {
                  console.warn(
                    `[quota] recovery commit failed: ${(error as Error).message}`,
                  )
                }
              }
              void flushUsage()
            }
          },
        )
      } catch (error) {
        failDurableRun(
          state,
          `Recovery setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    },
  )
}

/** Discover and resume non-terminal runs after the server execution plane boots. */
export async function recoverDurableRuns(
  runAgent: RunAgentFn,
  options: {
    agentHomes?: string[]
    runTurn?: (input: RunChatTurnInput) => Promise<RunChatTurnResult>
  } = {},
): Promise<number> {
  const seen = new Set<string>()
  const recoveries: Promise<void>[] = []
  const runTurn = options.runTurn ?? runChatTurn
  for (const agentHome of options.agentHomes ?? listSessionAgentHomes()) {
    calibrateActiveRunPointers(agentHome)
    const bySession = new Map<string, DurableRunState[]>()
    for (const state of listRunStates(agentHome)) {
      const states = bySession.get(state.sessionId) ?? []
      states.push(state)
      bySession.set(state.sessionId, states)
    }
    for (const states of bySession.values()) {
      states.sort(
        (a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId),
      )
      const latest = states[0]
      if (!latest) continue
      for (const state of states) {
        if (seen.has(state.runId) || isTerminalRunStatus(state.status)) continue
        seen.add(state.runId)
        if (state.cancelRequestedAt) {
          finalizeCancelledRun(state)
          continue
        }
        if (state !== latest) {
          failDurableRun(
            state,
            `Superseded by newer Run ${latest.runId} during recovery`,
          )
          continue
        }
        recoveries.push(recoverOne(state, runAgent, runTurn))
      }
    }
  }
  await Promise.all(recoveries)
  return recoveries.length
}
