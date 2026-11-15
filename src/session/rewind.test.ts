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

    expect(previewRewind(session, 'u2')).toEqual({
      canRestoreFiles: true,
      changedFiles: [file],
    })
    expect(() => rewindSession(session, 'u1', { restoreFiles: true })).toThrow(
      /No file snapshot/,
    )
    expect(rewindSession(session, 'u2', { restoreFiles: true }).files).toEqual({
      restored: [file],
      deleted: [],
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('before')
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
