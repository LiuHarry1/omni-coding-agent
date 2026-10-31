import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../core/types.js'
import { registerSessionLocation } from '../core/session-paths.js'
import { forgetSession, getSession } from '../session/index.js'
import { upsertSessionIndexEntry } from '../session/session-index.js'
import { runWithRequestScope } from '../utils/request-scope.js'
import {
  persistFullCompactionFromCursor,
  persistMessagesFromCursor,
} from './transcript-checkpoint.js'

describe('transcript checkpoint cursor', () => {
  let agentHome: string
  let sessionId: string

  beforeEach(() => {
    agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-cursor-test-'))
    sessionId = `cursor-${Date.now()}-${Math.random()}`
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
    forgetSession(sessionId)
    fs.rmSync(agentHome, { recursive: true, force: true })
  })

  it('does not duplicate pending messages around a full compaction', () =>
    runWithRequestScope({ agentHome, cwd: '/workspace' }, () => {
      const messages: Message[] = [
        { role: 'user', uuid: 'u1', content: 'request' },
      ]
      let cursor = persistMessagesFromCursor(sessionId, messages, 0)

      messages.push(
        {
          role: 'assistant',
          uuid: 'a1',
          content: [{ type: 'text', text: 'before compact' }],
        },
        {
          role: 'user',
          uuid: 'boundary',
          content: 'compact boundary fixture',
          isMeta: true,
        },
        {
          role: 'user',
          uuid: 'summary',
          content: 'summary fixture',
          isCompactSummary: true,
        },
      )
      cursor = persistFullCompactionFromCursor(
        sessionId,
        messages,
        cursor,
        messages.slice(-2),
      )
      cursor = persistMessagesFromCursor(sessionId, messages, cursor)
      expect(cursor).toBe(4)

      forgetSession(sessionId)
      const restored = getSession(sessionId, { agentHome })
      expect(restored?.messages.map(message => message.uuid)).toEqual([
        'u1',
        'a1',
        'boundary',
        'summary',
      ])
    }))
})
