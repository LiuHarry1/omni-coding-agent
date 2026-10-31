import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import {
  registerSessionLocation,
  unregisterSessionLocation,
} from '../../core/session-paths.js'
import { upsertSessionIndexEntry } from '../../session/session-index.js'
import { deleteSession } from '../../session/store.js'
import {
  adoptInterruptedRun,
  attachDurableRunStream,
  cancelDurableRun,
  checkpointDurableRun,
  createDurableRun,
  getDurableRunState,
  prepareDurableRunOpening,
  resetRunManagerForTesting,
  RunAlreadyActiveError,
  startDurableRun,
} from './run-manager.js'
import { createRunState, readRunEvents, readRunState } from './run-store.js'
import type { DurableRunState } from './types.js'

class RecordingResponse extends EventEmitter {
  headersSent = false
  writableEnded = false
  destroyed = false
  statusCode = 0
  headers: Record<string, string> = {}
  chunks: string[] = []

  writeHead(status: number, headers: Record<string, string>): this {
    this.headersSent = true
    this.statusCode = status
    this.headers = headers
    return this
  }

  write(value: string): boolean {
    if (this.writableEnded || this.destroyed) return false
    this.chunks.push(String(value))
    return true
  }

  end(): this {
    this.writableEnded = true
    this.emit('finish')
    return this
  }

  destroy(): this {
    this.destroyed = true
    this.emit('close')
    return this
  }
}

describe('durable run lifecycle', () => {
  let agentHome: string
  let sessionId: string

  beforeEach(() => {
    resetRunManagerForTesting()
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-run-test-'))
    sessionId = `session-${Date.now()}-${Math.random()}`
    upsertSessionIndexEntry(
      sessionId,
      { projectKey: 'project', createdAt: Date.now() },
      agentHome,
    )
    registerSessionLocation(sessionId, {
      projectKey: 'project',
      agentHome,
    })
  })

  afterEach(() => {
    resetRunManagerForTesting()
    unregisterSessionLocation(sessionId)
    fs.rmSync(agentHome, { recursive: true, force: true })
  })

  it('keeps running after the first SSE subscriber disconnects and replays by seq', async () => {
    const run = createDurableRun({
      sessionId,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'keep going' },
    })
    const first = new RecordingResponse()
    attachDurableRunStream(
      run.runId,
      first as unknown as ServerResponse,
      0,
      {},
      agentHome,
    )

    let continueRun!: () => void
    const gate = new Promise<void>(resolve => {
      continueRun = resolve
    })
    const execution = startDurableRun(run.runId, async transport => {
      transport.emit({
        type: 'system',
        subtype: 'thinking',
        session_id: sessionId,
      })
      await gate
      transport.emit({
        type: 'stream_event',
        session_id: sessionId,
        delta: { kind: 'text', text: 'finished in background' },
      })
      return { finalText: 'finished in background', error: null }
    })

    first.emit('close')
    expect(getDurableRunState(run.runId, agentHome)?.status).toBe('running')
    continueRun()
    await execution

    const finished = getDurableRunState(run.runId, agentHome)
    expect(finished?.status).toBe('finished')
    expect(readRunEvents(finished!, 0).map(event => event.seq)).toEqual([1, 2])

    const replay = new RecordingResponse()
    attachDurableRunStream(
      run.runId,
      replay as unknown as ServerResponse,
      1,
      {},
      agentHome,
    )
    const body = replay.chunks.join('')
    expect(body).toContain('id: 2\n')
    expect(body).not.toContain('id: 1\n')
    expect(replay.writableEnded).toBe(true)
  })

  it('records query failures as error and deduplicates results per wire scope', async () => {
    const run = createDurableRun({
      sessionId,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'fail upstream' },
    })

    await startDurableRun(run.runId, async transport => {
      transport.emit({
        type: 'result',
        subtype: 'error',
        error: 'upstream failed',
        session_id: sessionId,
      })
      transport.emit({
        type: 'result',
        subtype: 'success',
        reason: 'done',
        session_id: sessionId,
      })
      transport.emit({
        type: 'result',
        subtype: 'success',
        reason: 'done',
        session_id: sessionId,
        parent_tool_use_id: 'subagent-1',
      })
      transport.emit({
        type: 'result',
        subtype: 'error',
        error: 'duplicate nested terminal',
        session_id: sessionId,
        parent_tool_use_id: 'subagent-1',
      })
      transport.emit({
        type: 'result',
        subtype: 'error',
        error: 'other nested terminal',
        session_id: sessionId,
        parent_tool_use_id: 'subagent-2',
      })
      return {
        finalText: '',
        error: null,
        queryReason: 'error',
        reason: 'error',
      }
    })

    const failed = getDurableRunState(run.runId, agentHome)
    expect(failed?.status).toBe('error')
    expect(failed?.reason).toBe('error')
    expect(failed?.error).toContain('Agent query failed')
    const terminals = readRunEvents(failed!, 0).map(event => event.event)
    expect(terminals).toHaveLength(3)
    expect(
      terminals.map(event =>
        'parent_tool_use_id' in event
          ? (event.parent_tool_use_id ?? 'root')
          : 'root',
      ),
    ).toEqual(['root', 'subagent-1', 'subagent-2'])
    expect(terminals[0]).toMatchObject({
      type: 'result',
      subtype: 'error',
      error: 'upstream failed',
    })
  })

  it('terminates only through explicit cancellation', async () => {
    const run = createDurableRun({
      sessionId,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'cancel me' },
    })
    let finishCancellation!: () => void
    const cancellationGate = new Promise<void>(resolve => {
      finishCancellation = resolve
    })
    const execution = startDurableRun(
      run.runId,
      async (_transport, _state, signal) => {
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await cancellationGate
        return {
          finalText: '',
          error: new Error('model failed during cancellation'),
          queryReason: 'error',
          reason: 'error',
        }
      },
    )

    expect(cancelDurableRun(run.runId, agentHome)).toBe(true)
    expect(cancelDurableRun(run.runId, agentHome)).toBe(true)
    const cancelling = readRunState(run.runId, agentHome)
    expect(cancelling?.status).toBe('running')
    expect(cancelling?.cancelRequestedAt).toEqual(expect.any(Number))
    expect(cancelling?.endedAt).toBeUndefined()
    expect(() =>
      createDurableRun({
        sessionId,
        agentHome,
        cwd: '/workspace',
        requestPayload: { message: 'must remain locked' },
      }),
    ).toThrowError(RunAlreadyActiveError)

    finishCancellation()
    await execution
    const cancelled = getDurableRunState(run.runId, agentHome)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.reason).toBe('user-cancel')
    expect(cancelled?.error).toBeUndefined()

    const next = createDurableRun({
      sessionId,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'lock is released' },
    })
    expect(cancelDurableRun(next.runId, agentHome)).toBe(true)
  })

  it('adopts a persisted non-terminal run as a new attempt', async () => {
    const now = Date.now()
    const persisted: DurableRunState = {
      version: 1,
      runId: `run-${now}`,
      sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      attempt: 1,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'resume me' },
      lastSeq: 0,
      checkpointSeq: 0,
    }
    createRunState(persisted)

    expect(() =>
      createDurableRun({
        sessionId,
        agentHome,
        cwd: '/workspace',
        requestPayload: { message: 'must not overlap' },
      }),
    ).toThrowError(RunAlreadyActiveError)
    expect(adoptInterruptedRun(persisted)).toBe(true)
    expect(getDurableRunState(persisted.runId, agentHome)?.status).toBe(
      'recovering',
    )
    await startDurableRun(persisted.runId, async () => ({
      finalText: 'resumed',
      error: null,
    }))
    const recovered = getDurableRunState(persisted.runId, agentHome)
    expect(recovered?.attempt).toBe(2)
    expect(recovered?.status).toBe('finished')
  })

  it('removes Run sidecars when their Session is deleted', () => {
    const run = createDurableRun({
      sessionId,
      agentHome,
      cwd: '/workspace',
      requestPayload: { message: 'delete this session' },
    })
    expect(readRunState(run.runId, agentHome)).not.toBeNull()
    prepareDurableRunOpening(run.runId, 'persisted-opening-message')
    expect(readRunState(run.runId, agentHome)?.requestPayload).toEqual({
      message: 'delete this session',
    })
    checkpointDurableRun(run.runId, {
      openingMessageUuid: 'persisted-opening-message',
    })
    expect(readRunState(run.runId, agentHome)?.requestPayload).toBeUndefined()

    expect(cancelDurableRun(run.runId, agentHome)).toBe(true)
    deleteSession(sessionId)

    expect(readRunState(run.runId, agentHome)).toBeNull()
  })
})
