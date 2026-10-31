import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  registerSessionLocation,
  unregisterSessionLocation,
} from '../../core/session-paths.js'
import { upsertSessionIndexEntry } from '../../session/session-index.js'
import { getAppDirName } from '../../utils/app-dir.js'
import {
  appendRunEvent,
  createRunState,
  findActiveRunStateForSession,
  readRunState,
  removeRunsForSession,
  writeRunState,
} from './run-store.js'
import type { DurableRunState, StoredRunEvent } from './types.js'

describe('durable run index', () => {
  let agentHome: string
  let sessionId: string

  const indexPath = () =>
    path.join(agentHome, getAppDirName(), 'run-index.json')

  const makeRun = (runId = `run-${Date.now()}`): DurableRunState => {
    const now = Date.now()
    return {
      version: 1,
      runId,
      sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      attempt: 1,
      agentHome,
      cwd: '/workspace',
      lastSeq: 0,
      checkpointSeq: 0,
    }
  }

  beforeEach(() => {
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-run-index-'))
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
    unregisterSessionLocation(sessionId)
    fs.rmSync(agentHome, { recursive: true, force: true })
  })

  it('sets and clears the active pointer on terminal state and session removal', () => {
    const first = makeRun('run-first')
    createRunState(first)
    expect(
      JSON.parse(fs.readFileSync(indexPath(), 'utf8')).activeBySession[
        sessionId
      ],
    ).toBe(first.runId)

    first.status = 'finished'
    first.endedAt = Date.now()
    writeRunState(first)
    expect(
      JSON.parse(fs.readFileSync(indexPath(), 'utf8')).activeBySession[
        sessionId
      ],
    ).toBeUndefined()
    expect(findActiveRunStateForSession(sessionId, agentHome)).toBeNull()

    const second = makeRun('run-second')
    createRunState(second)
    removeRunsForSession(sessionId, agentHome)
    const index = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
    expect(index.runs).toEqual({})
    expect(index.activeBySession[sessionId]).toBeUndefined()
  })

  it('rebuilds an old index and heals a dangling active pointer', () => {
    const run = makeRun('run-live')
    createRunState(run)

    const oldIndex = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
    delete oldIndex.activeBySession
    fs.writeFileSync(indexPath(), JSON.stringify(oldIndex))
    expect(findActiveRunStateForSession(sessionId, agentHome)?.runId).toBe(
      run.runId,
    )

    const dangling = JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
    dangling.activeBySession[sessionId] = 'missing-run'
    fs.writeFileSync(indexPath(), JSON.stringify(dangling))
    expect(findActiveRunStateForSession(sessionId, agentHome)?.runId).toBe(
      run.runId,
    )
    expect(
      JSON.parse(fs.readFileSync(indexPath(), 'utf8')).activeBySession[
        sessionId
      ],
    ).toBe(run.runId)
  })

  it('tail-reads a large final event and ignores a torn trailing row', () => {
    const run = makeRun('run-tail')
    createRunState(run)
    const row: StoredRunEvent = {
      version: 1,
      runId: run.runId,
      seq: 7,
      timestamp: Date.now(),
      event: {
        type: 'stream_event',
        session_id: sessionId,
        delta: { kind: 'text', text: 'x'.repeat(24 * 1024) },
      },
    }
    appendRunEvent(run, row)

    const runDir = path.dirname(
      path.join(
        agentHome,
        getAppDirName(),
        'projects',
        'project',
        sessionId,
        'runs',
        run.runId,
        'state.json',
      ),
    )
    fs.appendFileSync(
      path.join(runDir, 'events.jsonl'),
      `{"version":1,"runId":"${run.runId}","seq":999,"event":"${'y'.repeat(
        12 * 1024,
      )}`,
    )

    expect(readRunState(run.runId, agentHome)?.lastSeq).toBe(7)
  })
})
