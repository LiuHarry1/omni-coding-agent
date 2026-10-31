import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRoleMessage, type Message } from '../../core/types.js'
import { registerSessionLocation } from '../../core/session-paths.js'
import {
  appendMessage,
  forgetSession,
  getSession,
} from '../../session/index.js'
import { upsertSessionIndexEntry } from '../../session/session-index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  getDurableRunState,
  resetRunManagerForTesting,
  waitForDurableRun,
} from './run-manager.js'
import { appendRunEvent, createRunState } from './run-store.js'
import type { DurableRunState } from './types.js'
import {
  recoverDurableRuns,
  repairUncheckpointedRunEvents,
  repairUnknownToolOutcomes,
  UNKNOWN_TOOL_RESULT,
} from './recovery.js'

describe('durable run semantic recovery', () => {
  let agentHome: string
  let sessionId: string

  beforeEach(() => {
    resetRunManagerForTesting()
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-recovery-test-'))
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
    forgetSession(sessionId)
    fs.rmSync(agentHome, { recursive: true, force: true })
  })

  it('records an unresolved side effect as unknown and restores it on replay', () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          uuid: 'assistant-with-unacked-tool',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'Bash',
              input: { command: 'touch result.txt' },
            },
          ],
        },
      ]
      appendMessage(sessionId, messages[0]!)

      expect(repairUnknownToolOutcomes(sessionId, messages)).toBe(1)
      expect(repairUnknownToolOutcomes(sessionId, messages)).toBe(0)
      const tool = messages[1]
      expect(tool && isRoleMessage(tool) ? tool.role : undefined).toBe('tool')
      if (!tool || !isRoleMessage(tool) || tool.role !== 'tool') {
        throw new Error('tool result not inserted')
      }
      expect(tool.content[0]?.isError).toBe(true)
      expect(tool.content[0]?.toolUseResult).toEqual({
        status: 'unknown',
        reason: 'worker_lost',
      })
      expect(
        tool.content[0]?.output.type === 'text'
          ? tool.content[0].output.value
          : '',
      ).toBe(UNKNOWN_TOOL_RESULT)

      forgetSession(sessionId)
      const restored = getSession(sessionId, { agentHome })
      expect(restored?.messages).toHaveLength(2)
      const restoredTool = restored?.messages[1]
      expect(
        restoredTool && isRoleMessage(restoredTool)
          ? restoredTool.role
          : undefined,
      ).toBe('tool')
      if (
        !restoredTool ||
        !isRoleMessage(restoredTool) ||
        restoredTool.role !== 'tool'
      ) {
        throw new Error('unknown result was not replayed')
      }
      expect(restoredTool.content[0]?.toolUseResult).toEqual({
        status: 'unknown',
        reason: 'worker_lost',
      })
    }))

  it('reconstructs an uncheckpointed tool intent as unknown from durable events', () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, () => {
      const now = Date.now()
      const state: DurableRunState = {
        version: 1,
        runId: `mid-step-crash-${now}`,
        sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attempt: 1,
        agentHome,
        cwd: '/workspace',
        lastSeq: 1,
        checkpointSeq: 0,
      }
      createRunState(state)
      appendRunEvent(state, {
        version: 1,
        runId: state.runId,
        seq: 1,
        timestamp: now,
        event: {
          type: 'tool_call',
          session_id: sessionId,
          tool_use_id: 'uncheckpointed-shell',
          name: 'Bash',
          args: { command: 'deploy-side-effect' },
        },
      })

      const messages: Message[] = []
      const repaired = repairUncheckpointedRunEvents(state, messages)
      expect(repaired).toMatchObject({
        repaired: 2,
        unknown: 1,
        throughSeq: 1,
      })
      expect(messages).toHaveLength(2)
      const tool = messages[1]
      if (!tool || !isRoleMessage(tool) || tool.role !== 'tool') {
        throw new Error('unknown event result was not reconstructed')
      }
      expect(tool.content[0]?.toolUseResult).toEqual({
        status: 'unknown',
        reason: 'worker_lost',
      })

      forgetSession(sessionId)
      expect(getSession(sessionId, { agentHome })?.messages).toHaveLength(2)
    }))

  it('scans a non-terminal sidecar and resumes it with a new attempt', async () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, async () => {
      const opening: Message = {
        role: 'user',
        uuid: 'opening-message',
        content: 'finish the durable task',
      }
      appendMessage(sessionId, opening)
      const now = Date.now()
      const state: DurableRunState = {
        version: 1,
        runId: `restart-run-${now}`,
        sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attempt: 1,
        agentHome,
        cwd: '/workspace',
        openingMessageUuid: 'opening-message',
        requestPayload: { message: 'finish the durable task' },
        lastSeq: 0,
        checkpointSeq: 0,
      }
      createRunState(state)

      let recoveryInput:
        { message: string; isMeta?: boolean; durableRunId?: string } | undefined
      const count = await recoverDurableRuns(async () => '', {
        agentHomes: [agentHome],
        runTurn: async input => {
          recoveryInput = input
          return { finalText: 'recovered', error: null }
        },
      })
      expect(count).toBe(1)
      await waitForDurableRun(state.runId)
      expect(recoveryInput?.isMeta).toBe(true)
      expect(recoveryInput?.message).toContain('previous agent process stopped')
      expect(recoveryInput?.durableRunId).toBe(state.runId)
      const recovered = getDurableRunState(state.runId, agentHome)
      expect(recovered?.attempt).toBe(2)
      expect(recovered?.status).toBe('finished')
    }))

  it('settles persisted cancellation intent without resuming the run', async () => {
    const now = Date.now()
    const state: DurableRunState = {
      version: 1,
      runId: `cancelled-before-restart-${now}`,
      sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      cancelRequestedAt: now,
      attempt: 1,
      agentHome,
      cwd: '/workspace',
      lastSeq: 0,
      checkpointSeq: 0,
    }
    createRunState(state)
    let resumed = false

    const count = await recoverDurableRuns(async () => '', {
      agentHomes: [agentHome],
      runTurn: async () => {
        resumed = true
        return { finalText: '', error: null }
      },
    })

    expect(count).toBe(0)
    expect(resumed).toBe(false)
    expect(getDurableRunState(state.runId, agentHome)).toMatchObject({
      status: 'cancelled',
      reason: 'user-cancel',
    })
  })

  it('replays the accepted request when its opening UUID was prepared but not appended', async () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, async () => {
      appendMessage(sessionId, {
        role: 'user',
        uuid: 'prior-turn',
        content: 'an earlier completed request',
      })
      const now = Date.now()
      const state: DurableRunState = {
        version: 1,
        runId: `pre-append-crash-${now}`,
        sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attempt: 1,
        agentHome,
        cwd: '/workspace',
        openingMessageUuid: 'opening-not-yet-appended',
        requestPayload: { message: 'do not duplicate me' },
        lastSeq: 0,
        checkpointSeq: 0,
      }
      createRunState(state)

      let recoveredInput: { message: string; isMeta?: boolean } | undefined
      await recoverDurableRuns(async () => '', {
        agentHomes: [agentHome],
        runTurn: async input => {
          recoveredInput = input
          return { finalText: 'recovered', error: null }
        },
      })
      await waitForDurableRun(state.runId)

      expect(recoveredInput).toMatchObject({
        message: 'do not duplicate me',
        isMeta: false,
      })
    }))

  it('recovers only the newest Run and terminalizes stale sidecars', async () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, async () => {
      const opening: Message = {
        role: 'user',
        uuid: 'opening-for-conflict',
        content: 'latest task wins',
      }
      appendMessage(sessionId, opening)
      const now = Date.now()
      const makeState = (
        runId: string,
        createdAt: number,
      ): DurableRunState => ({
        version: 1,
        runId,
        sessionId,
        status: 'running',
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        attempt: 1,
        agentHome,
        cwd: '/workspace',
        openingMessageUuid: opening.uuid,
        lastSeq: 0,
        checkpointSeq: 0,
      })
      const stale = makeState('stale-run', now)
      const latest = makeState('latest-run', now + 1)
      createRunState(stale)
      createRunState(latest)

      let recoveredRunId: string | undefined
      const count = await recoverDurableRuns(async () => '', {
        agentHomes: [agentHome],
        runTurn: async input => {
          recoveredRunId = input.durableRunId
          return { finalText: 'latest recovered', error: null }
        },
      })
      expect(count).toBe(1)
      await waitForDurableRun(latest.runId)

      expect(recoveredRunId).toBe(latest.runId)
      expect(getDurableRunState(stale.runId, agentHome)?.status).toBe('error')
      expect(getDurableRunState(latest.runId, agentHome)?.status).toBe(
        'finished',
      )
    }))
})
