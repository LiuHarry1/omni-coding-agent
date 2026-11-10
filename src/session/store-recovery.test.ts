import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSessionTranscriptPath } from './store.js'
import { createSession, forgetSession, getSession } from './store.js'

describe('session transcript recovery', () => {
  let home = ''
  let sessionId = ''

  afterEach(() => {
    if (sessionId) forgetSession(sessionId)
    if (home) fs.rmSync(home, { recursive: true, force: true })
  })

  it('ignores only a torn final row and reports intermediate corruption', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-jsonl-recovery-'))
    const session = createSession({ agentHome: home, cwd: home })
    sessionId = session.id
    const transcript = getSessionTranscriptPath(sessionId)!
    const intact = fs.readFileSync(transcript, 'utf-8')
    fs.appendFileSync(transcript, '{"type":"message"')

    forgetSession(sessionId)
    expect(getSession(sessionId, { agentHome: home })?.id).toBe(sessionId)
    expect(fs.readFileSync(transcript, 'utf-8')).toBe(intact)

    forgetSession(sessionId)
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'session_title', title: 'after damage' })}\n`,
    )
    expect(getSession(sessionId, { agentHome: home })?.id).toBe(sessionId)

    forgetSession(sessionId)
    fs.appendFileSync(
      transcript,
      `{"type":"message"\n${JSON.stringify({ type: 'session_title', title: 'x' })}\n`,
    )
    expect(() => getSession(sessionId, { agentHome: home })).toThrow(
      /Corrupt session transcript.*line 3/,
    )
  })

  it('keeps a workspace binding whose legacy projectKey no longer matches', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bound-key-'))
    const repo = path.join(home, 'repo')
    fs.mkdirSync(repo)
    const session = createSession({ agentHome: home, cwd: home })
    sessionId = session.id
    fs.appendFileSync(
      getSessionTranscriptPath(sessionId)!,
      `${JSON.stringify({
        type: 'workspace_bound',
        workspace: { environmentId: 'local', cwd: repo },
        projectKey: 'computed-from-an-old-git-root',
        timestamp: Date.now(),
      })}\n`,
    )

    forgetSession(sessionId)
    expect(getSession(sessionId, { agentHome: home })?.workspace).toEqual({
      environmentId: 'local',
      cwd: repo,
    })
  })
})
