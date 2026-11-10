import type { RunAgentFn, Session } from '../core/types.js'
import { createSession, getSession } from '../session/index.js'
import type { SSETransport } from '../core/types.js'
import { runChatTurn } from '../turn/run-chat-turn.js'
import type { AcpTurnSink } from './translate-outbound.js'
import { createAcpTransport } from './translate-outbound.js'
import { isCloudWorkspacesEnabled } from '../execution/providers/cloud/config.js'
import { parseCloudEnvironmentId } from '../execution/providers/cloud/cloud-provider.js'

export interface AcpSessionRecord {
  session: Session
  cwd: string
  emitHandshake: boolean
  abortController: AbortController | null
}

export class AcpSessionRegistry {
  readonly #records = new Map<string, AcpSessionRecord>()

  create(cwd: string): AcpSessionRecord {
    const session = createSession()
    const record: AcpSessionRecord = {
      session,
      cwd,
      emitHandshake: true,
      abortController: null,
    }
    this.#records.set(session.id, record)
    return record
  }

  get(sessionId: string): AcpSessionRecord | undefined {
    const existing = getSession(sessionId)
    if (!existing) return this.#records.get(sessionId)
    const record = this.#records.get(sessionId)
    if (record) {
      record.session = existing
      return record
    }
    const created: AcpSessionRecord = {
      session: existing,
      cwd: process.cwd(),
      emitHandshake: false,
      abortController: null,
    }
    this.#records.set(sessionId, created)
    return created
  }

  cancel(sessionId: string): void {
    this.#records.get(sessionId)?.abortController?.abort()
  }
}

export async function runAcpPromptTurn(input: {
  record: AcpSessionRecord
  message: string
  images?: string[]
  runAgent: RunAgentFn
  sink: AcpTurnSink
  signal: AbortSignal
}): Promise<{
  stopReason: 'end_turn' | 'cancelled' | 'refusal'
  error?: string
}> {
  const { record, message, images, runAgent, sink, signal } = input
  const transport = createAcpTransport(sink) as SSETransport
  if (
    isCloudWorkspacesEnabled() &&
    !parseCloudEnvironmentId(record.session.workspace?.environmentId)
  ) {
    throw new Error(
      'ACP cannot run in the Cloud profile without a bound Cloud WorkspaceHandle.',
    )
  }
  const cwd = record.session.workspace?.cwd ?? record.cwd

  if (record.emitHandshake) {
    await sink.emitInitHandshake(
      cwd,
      record.session.permissionMode?.mode ?? 'agent',
    )
    record.emitHandshake = false
  }

  const abortController = new AbortController()
  record.abortController = abortController
  const onAbort = () => abortController.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    const result = await runChatTurn({
      message,
      session: record.session,
      cwd,
      runAgent,
      transport,
      images,
      emitHandshake: false,
      abortSignal: abortController.signal,
    })

    if (signal.aborted || abortController.signal.aborted) {
      return { stopReason: 'cancelled' }
    }

    if (result.reason === 'skill_fork') {
      return { stopReason: 'end_turn' }
    }

    if (result.error) {
      return { stopReason: 'refusal', error: result.error.message }
    }

    return { stopReason: 'end_turn' }
  } finally {
    signal.removeEventListener('abort', onAbort)
    record.abortController = null
    sink.markTurnDone()
  }
}
