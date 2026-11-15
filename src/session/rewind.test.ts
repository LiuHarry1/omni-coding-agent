import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message, Session } from '../core/types.js'
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from '../utils/fileHistory.js'
import { replayTranscriptMessages } from './compact-replay.js'
import {
  RewindError,
  forkSession,
  previewRewind,
  rewindSession,
} from './rewind.js'
import {
  appendMessage,
  appendModeChange,
  createSession,
  forgetSession,
  getSession,
} from './store.js'

const uuids = (messages: Message[]) => messages.map(m => m.uuid)

let home = ''
let session: Session
const opened: string[] = []

function say(target: Session, uuid: string, role: 'user' | 'assistant') {
  const message = { role, content: `text ${uuid}`, uuid } as Message
  target.messages.push(message)
  appendMessage(target.id, message)
}

function reload(id: string): Session {
  forgetSession(id)
  return getSession(id, { agentHome: home })!
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-rewind-'))
  session = createSession({ agentHome: home, cwd: home })
  opened.push(session.id)
  say(session, 'u1', 'user')
  say(session, 'a1', 'assistant')
  say(session, 'u2', 'user')
  say(session, 'a2', 'assistant')
})

afterEach(() => {
  for (const id of opened.splice(0)) forgetSession(id)
  fs.rmSync(home, { recursive: true, force: true })
})

describe('rewind', () => {
  it('drops the message and what followed, also after a reload', () => {
    expect(rewindSession(session, 'u2')).toEqual({
      prompt: 'text u2',
      files: null,
    })
    expect(uuids(session.messages)).toEqual(['u1', 'a1'])
    expect(uuids(reload(session.id).messages)).toEqual(['u1', 'a1'])

    const again = getSession(session.id, { agentHome: home })!
    say(again, 'u3', 'user')
    expect(uuids(reload(session.id).messages)).toEqual(['u1', 'a1', 'u3'])
  })

  it('can rewind to before the first message', () => {
    rewindSession(session, 'u1')
    expect(reload(session.id).messages).toEqual([])
  })

  it('only rewinds to a user message', () => {
    expect(() => rewindSession(session, 'a1')).toThrow(RewindError)
  })

  it('forgets the files read and rebuilds the todo list', () => {
    session.readFileState = new Map([
      [
        '/tmp/config.ts',
        {
          content: 'port = 3000',
          timestamp: Date.now(),
          offset: 0,
          limit: undefined,
        },
      ],
    ])
    session.todos = [
      { id: 'a', content: 'from a dropped turn', status: 'in_progress' },
    ]
    session.discoveredTools = new Set(['Browser_navigate'])
    session.invokedSkills = new Map([
      [
        ':later-skill',
        {
          skillName: 'later-skill',
          skillPath: '/tmp/later/SKILL.md',
          content: 'body',
          invokedAt: Date.now(),
          agentId: null,
        },
      ],
    ])
    session.skillListingAnnounced = true

    // A TodoWrite that stays after the rewind: the list should come back.
    const keptTodos = [
      { id: 'keep', content: 'still open', status: 'pending' as const },
    ]
    const todoMsg = {
      role: 'tool',
      uuid: 'todo1',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'TodoWrite',
          output: { type: 'text', value: 'Updated' },
          toolUseResult: { todos: keptTodos, message: 'Updated' },
        },
      ],
    } as Message
    session.messages.splice(2, 0, todoMsg)
    appendMessage(session.id, todoMsg)

    rewindSession(session, 'u2')

    expect(session.readFileState.size).toBe(0)
    expect(session.todos).toEqual(keptTodos)
    expect(session.skillListingAnnounced).toBe(false)
    // Not rebuildable from the transcript: kept rather than lost.
    expect([...session.discoveredTools!]).toEqual(['Browser_navigate'])
    expect([...session.invokedSkills!.keys()]).toEqual([':later-skill'])
  })

  it('puts the files back when asked', () => {
    const file = path.join(home, 'f.txt')
    fs.writeFileSync(file, 'before')
    fileHistoryMakeSnapshot(session.id, 'u2')
    fileHistoryTrackEdit(session.id, file)
    fs.writeFileSync(file, 'after')

    const added = path.join(home, 'new.txt')
    fileHistoryTrackEdit(session.id, added)
    fs.writeFileSync(added, 'new')

    expect(previewRewind(session, 'u2')).toEqual({
      canRestoreFiles: true,
      changedFiles: [file, added],
      createdFiles: [added],
    })
    expect(() => rewindSession(session, 'u1', { restoreFiles: true })).toThrow(
      /No file snapshot/,
    )
    expect(rewindSession(session, 'u2', { restoreFiles: true }).files).toEqual({
      restored: [file],
      deleted: [added],
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('before')
    expect(fs.existsSync(added)).toBe(false)
  })

  it('goes back to the mode the message was sent in', () => {
    // u2 was sent in agent mode; the session moved to plan mode afterwards.
    session.permissionMode = { mode: 'plan', preMode: 'agent' }
    appendModeChange(session.id, session)
    say(session, 'u3', 'user')

    rewindSession(session, 'u3')
    expect(session.permissionMode.mode).toBe('plan')

    rewindSession(session, 'u2')
    expect(session.permissionMode).toEqual({ mode: 'agent' })
    expect(reload(session.id).permissionMode).toEqual({ mode: 'agent' })
  })

  it('rewinds to a message the user sent while a turn ran', () => {
    const queued = (prompt: string, uuid: string, extra = {}) => {
      const message = {
        type: 'attachment',
        uuid,
        isMeta: true,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          ...extra,
        },
      } as Message
      session.messages.push(message)
      appendMessage(session.id, message)
    }
    queued('also the tests', 'q1')
    say(session, 'a3', 'assistant')
    queued('<task-notification/>', 'n1', {
      commandMode: 'task-notification',
    })

    // Only what the user typed is somewhere to go back to.
    expect(() => rewindSession(session, 'n1')).toThrow(RewindError)
    expect(rewindSession(session, 'q1').prompt).toBe('also the tests')
    expect(uuids(reload(session.id).messages)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})

describe('fork', () => {
  it('starts a new session with the conversation before the message', () => {
    const { session: fork, prompt } = forkSession(session, 'u2')
    opened.push(fork.id)
    expect(prompt).toBe('text u2')
    expect(fork.id).not.toBe(session.id)
    expect(fork.title).toMatch(/\(fork\)$/)
    expect(uuids(reload(fork.id).messages)).toEqual(['u1', 'a1'])
    expect(uuids(reload(session.id).messages)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('starts in the mode the message was sent in', () => {
    session.permissionMode = { mode: 'ask' }
    appendModeChange(session.id, session)
    const { session: fork } = forkSession(session, 'u2')
    opened.push(fork.id)
    expect(fork.permissionMode.mode).toBe('agent')
    expect(reload(fork.id).permissionMode.mode).toBe('agent')
  })
})

describe('rewind rows', () => {
  it('a later message cancels an earlier rewind', () => {
    const rows = [
      {
        type: 'message',
        role: 'user',
        content: 'a',
        uuid: 'a',
        parentUuid: null,
      },
      {
        type: 'message',
        role: 'user',
        content: 'b',
        uuid: 'b',
        parentUuid: 'a',
      },
      { type: 'rewind', leafUuid: 'a' },
      {
        type: 'message',
        role: 'user',
        content: 'c',
        uuid: 'c',
        parentUuid: 'a',
      },
    ]
    expect(uuids(replayTranscriptMessages(rows).messages)).toEqual(['a', 'c'])
    expect(uuids(replayTranscriptMessages(rows.slice(0, 3)).messages)).toEqual([
      'a',
    ])
  })
})
