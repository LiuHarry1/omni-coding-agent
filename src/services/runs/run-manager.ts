import { randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import { abortTurn, clearTurnAbort } from '../../core/turn-abort-registry.js'
import type { QueryStopReason } from '../../core/query/types.js'
import { endTurn, tryBeginTurn } from '../../session/store.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  createRunState,
  findActiveRunStateForSession,
  findRunState,
  readRunState,
  writeRunState,
} from './run-store.js'
import { DurableRunTransport } from './run-transport.js'
import type {
  CreateDurableRunInput,
  DurableRunState,
  StoredRunEvent,
} from './types.js'
import { isTerminalRunStatus } from './types.js'

export class RunAlreadyActiveError extends Error {
  constructor(
    readonly sessionId: string,
    readonly runId?: string,
  ) {
    super(`A run is already active for session ${sessionId}`)
  }
}

export interface DurableRunExecutionResult {
  finalText: string
  error: Error | null
  reason?: string
  queryReason?: QueryStopReason
  interrupted?: boolean
}

type RunRuntime = {
  state: DurableRunState
  transport: DurableRunTransport
  abortController: AbortController
  promise?: Promise<DurableRunExecutionResult>
}

const runtimes = new Map<string, RunRuntime>()
const activeBySession = new Map<string, string>()

function persistStatus(
  state: DurableRunState,
  status: DurableRunState['status'],
  extra: Partial<DurableRunState> = {},
): void {
  state.status = status
  Object.assign(state, extra)
  state.updatedAt = Date.now()
  writeRunState(state)
}

function observeRunEvent(state: DurableRunState, stored: StoredRunEvent): void {
  if (state.cancelRequestedAt) return
  const message = stored.event
  if (message.type === 'control_request') {
    persistStatus(state, 'requires_action')
    return
  }
  if (
    (state.status === 'requires_action' || state.status === 'recovering') &&
    message.type !== 'keep_alive'
  ) {
    persistStatus(state, 'running')
  }
}

function runtimeForState(state: DurableRunState): RunRuntime {
  const existing = runtimes.get(state.runId)
  if (existing) return existing
  const transport = new DurableRunTransport(state, observeRunEvent)
  const runtime = {
    state,
    transport,
    abortController: new AbortController(),
  }
  if (isTerminalRunStatus(state.status)) transport.end()
  runtimes.set(state.runId, runtime)
  if (!isTerminalRunStatus(state.status)) {
    activeBySession.set(state.sessionId, state.runId)
  }
  return runtime
}

export function createDurableRun(
  input: CreateDurableRunInput,
): DurableRunState {
  const persisted = findActiveRunStateForSession(
    input.sessionId,
    input.agentHome,
  )
  if (persisted) {
    throw new RunAlreadyActiveError(input.sessionId, persisted.runId)
  }
  if (!tryBeginTurn(input.sessionId)) {
    throw new RunAlreadyActiveError(
      input.sessionId,
      activeBySession.get(input.sessionId),
    )
  }
  const now = Date.now()
  const state: DurableRunState = {
    version: 1,
    runId: randomUUID(),
    sessionId: input.sessionId,
    status: 'creating',
    createdAt: now,
    updatedAt: now,
    attempt: 0,
    ownerEmail: input.ownerEmail,
    ownerRole: input.ownerRole,
    agentHome: input.agentHome,
    cwd: input.cwd,
    mode: input.mode,
    agentType: input.agentType,
    requestPayload: input.requestPayload,
    lastSeq: 0,
    checkpointSeq: 0,
  }
  try {
    createRunState(state)
    runtimeForState(state)
    activeBySession.set(state.sessionId, state.runId)
    return state
  } catch (error) {
    endTurn(input.sessionId)
    throw error
  }
}

export function startDurableRun(
  runId: string,
  execute: (
    transport: DurableRunTransport,
    state: DurableRunState,
    signal: AbortSignal,
  ) => Promise<DurableRunExecutionResult>,
): Promise<DurableRunExecutionResult> {
  const runtime = getRuntime(runId)
  if (!runtime) throw new Error(`Run not found: ${runId}`)
  if (runtime.promise) return runtime.promise

  runtime.state.attempt += 1
  persistStatus(
    runtime.state,
    runtime.state.status === 'recovering' ? 'recovering' : 'running',
    {
      startedAt: runtime.state.startedAt ?? Date.now(),
      endedAt: undefined,
      error: undefined,
    },
  )

  const promise = runWithRequestScope(
    {
      agentHome: runtime.state.agentHome,
      cwd: runtime.state.cwd,
    },
    async () => {
      let result: DurableRunExecutionResult
      try {
        result = await execute(
          runtime.transport,
          runtime.state,
          runtime.abortController.signal,
        )
        if (runtime.state.cancelRequestedAt) {
          persistStatus(runtime.state, 'cancelled', {
            finalText: result.finalText,
            error: undefined,
            reason: 'user-cancel',
            endedAt: Date.now(),
          })
        } else if (result.interrupted) {
          persistStatus(runtime.state, 'interrupted', {
            finalText: result.finalText,
            reason: result.reason ?? 'interrupted',
            endedAt: Date.now(),
          })
        } else if (result.queryReason === 'error' || result.error) {
          persistStatus(runtime.state, 'error', {
            finalText: result.finalText,
            error:
              result.error?.message ??
              'Agent query failed before producing a final response.',
            reason: result.reason ?? 'error',
            endedAt: Date.now(),
          })
        } else {
          persistStatus(runtime.state, 'finished', {
            finalText: result.finalText,
            reason: result.reason ?? 'done',
            endedAt: Date.now(),
          })
        }
        return result
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        result = { finalText: '', error: err, reason: 'error' }
        if (runtime.state.cancelRequestedAt) {
          persistStatus(runtime.state, 'cancelled', {
            error: undefined,
            reason: 'user-cancel',
            endedAt: Date.now(),
          })
        } else {
          persistStatus(runtime.state, 'error', {
            error: err.message,
            reason: 'error',
            endedAt: Date.now(),
          })
        }
        return result
      } finally {
        runtime.transport.end()
        activeBySession.delete(runtime.state.sessionId)
        clearTurnAbort(runtime.state.sessionId)
        endTurn(runtime.state.sessionId)
        const cleanup = setTimeout(() => {
          if (
            runtimes.get(runtime.state.runId) === runtime &&
            isTerminalRunStatus(runtime.state.status)
          ) {
            runtimes.delete(runtime.state.runId)
          }
        }, 0)
        cleanup.unref?.()
      }
    },
  )
  runtime.promise = promise
  void promise.catch(() => {})
  return promise
}

export function getDurableRunState(
  runId: string,
  agentHome?: string,
): DurableRunState | null {
  return runtimes.get(runId)?.state ?? findRunState(runId, agentHome)
}

export function getActiveRunForSession(
  sessionId: string,
  agentHome?: string,
): DurableRunState | null {
  const runId = activeBySession.get(sessionId)
  if (runId) return getDurableRunState(runId, agentHome)
  return findActiveRunStateForSession(sessionId, agentHome)
}

export function attachDurableRunStream(
  runId: string,
  res: ServerResponse,
  afterSeq = 0,
  headers: Record<string, string> = {},
  agentHome?: string,
): (() => void) | null {
  const runtime = getRuntime(runId, agentHome)
  if (!runtime) return null
  const cleanup = runtime.transport.attachSSE(res, afterSeq, headers)
  if (isTerminalRunStatus(runtime.state.status)) runtimes.delete(runId)
  return cleanup
}

export function cancelDurableRun(runId: string, agentHome?: string): boolean {
  const runtime = getRuntime(runId, agentHome)
  if (!runtime) return false
  if (isTerminalRunStatus(runtime.state.status)) {
    runtimes.delete(runId)
    return false
  }
  persistStatus(runtime.state, 'running', {
    cancelRequestedAt: runtime.state.cancelRequestedAt ?? Date.now(),
    endedAt: undefined,
  })
  runtime.abortController.abort('user-cancel')
  abortTurn(runtime.state.sessionId, 'user-cancel')
  if (!runtime.promise) {
    finalizeCancelledRun(runtime.state)
  }
  return true
}

export function cancelActiveRunForSession(
  sessionId: string,
  agentHome?: string,
): { ok: boolean; runId?: string } {
  const state = getActiveRunForSession(sessionId, agentHome)
  if (!state) {
    return { ok: abortTurn(sessionId, 'user-cancel') }
  }
  return {
    ok: cancelDurableRun(state.runId, state.agentHome),
    runId: state.runId,
  }
}

export function checkpointDurableRun(
  runId: string,
  patch: {
    checkpointSeq?: number
    openingMessageUuid?: string
    lastMessageUuid?: string
  } = {},
): void {
  const runtime = getRuntime(runId)
  if (!runtime) return
  runtime.state.checkpointSeq = patch.checkpointSeq ?? runtime.state.lastSeq
  if (patch.openingMessageUuid) {
    runtime.state.openingMessageUuid ??= patch.openingMessageUuid
    runtime.state.requestPayload = undefined
  }
  if (patch.lastMessageUuid) {
    runtime.state.lastMessageUuid = patch.lastMessageUuid
  }
  runtime.state.updatedAt = Date.now()
  writeRunState(runtime.state)
}

/**
 * Record the opening UUID before appending its transcript row. The accepted
 * request payload remains until checkpointDurableRun confirms that append.
 */
export function prepareDurableRunOpening(
  runId: string,
  openingMessageUuid: string,
): void {
  const runtime = getRuntime(runId)
  if (!runtime || runtime.state.openingMessageUuid) return
  runtime.state.openingMessageUuid = openingMessageUuid
  runtime.state.updatedAt = Date.now()
  writeRunState(runtime.state)
}

export function adoptInterruptedRun(state: DurableRunState): boolean {
  if (isTerminalRunStatus(state.status)) return false
  if (!tryBeginTurn(state.sessionId)) return false
  const runtime = runtimeForState(state)
  activeBySession.set(state.sessionId, state.runId)
  persistStatus(runtime.state, 'recovering', {
    reason: 'process-restart',
    endedAt: undefined,
  })
  return true
}

export function failDurableRun(state: DurableRunState, error: string): void {
  const runtime = runtimes.get(state.runId)
  const target = runtime?.state ?? state
  persistStatus(target, 'error', {
    error,
    reason: 'recovery-failed',
    endedAt: Date.now(),
  })
  runtime?.transport.end()
  if (activeBySession.get(state.sessionId) === state.runId) {
    activeBySession.delete(state.sessionId)
    endTurn(state.sessionId)
  }
  runtimes.delete(state.runId)
}

/** Settle a persisted cancellation without trying to resume its old process. */
export function finalizeCancelledRun(state: DurableRunState): void {
  const runtime = runtimes.get(state.runId)
  const target = runtime?.state ?? state
  persistStatus(target, 'cancelled', {
    error: undefined,
    reason: 'user-cancel',
    endedAt: Date.now(),
  })
  runtime?.transport.end()
  if (activeBySession.get(state.sessionId) === state.runId) {
    activeBySession.delete(state.sessionId)
    clearTurnAbort(state.sessionId)
    endTurn(state.sessionId)
  }
  runtimes.delete(state.runId)
}

export function waitForDurableRun(
  runId: string,
): Promise<DurableRunExecutionResult> | null {
  return runtimes.get(runId)?.promise ?? null
}

function getRuntime(runId: string, agentHome?: string): RunRuntime | null {
  const existing = runtimes.get(runId)
  if (existing) return existing
  const state = readRunState(runId, agentHome)
  return state ? runtimeForState(state) : null
}

export function resetRunManagerForTesting(): void {
  for (const runtime of runtimes.values()) {
    runtime.transport.end()
    endTurn(runtime.state.sessionId)
  }
  runtimes.clear()
  activeBySession.clear()
}
