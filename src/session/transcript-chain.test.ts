import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../core/types.js'
import { replayTranscriptMessages } from './compact-replay.js'
import {
  appendMessage,
  createSession,
  forgetSession,
  getSession,
  getSessionTranscriptPath,
  setChainTip,
} from './store.js'

const row = (uuid: string, parentUuid?: string | null) => ({
  type: 'message',
  role: 'user',
  content: uuid,
  uuid,
  ...(parentUuid !== undefined ? { parentUuid } : {}),
})
const uuids = (messages: Message[]) => messages.map(m => m.uuid)

describe('transcript parentUuid chain', () => {
  it('follows the chain back from the latest message', () => {
    const { messages, leafUuid } = replayTranscriptMessages([
      row('a', null),
      row('b', 'a'),
      row('c', 'b'),
      // Rewound to "a", then continued.
      row('d', 'a'),
    ])
    expect(uuids(messages)).toEqual(['a', 'd'])
    expect(leafUuid).toBe('d')
  })

  it('replays rows from before parentUuid in file order', () => {
    expect(
      uuids(replayTranscriptMessages([row('a'), row('b')]).messages),
    ).toEqual(['a', 'b'])
    // Old rows, then new ones chained onto the last old one.
    expect(
      uuids(
        replayTranscriptMessages([row('a'), row('b'), row('c', 'b')]).messages,
      ),
    ).toEqual(['a', 'b', 'c'])
  })

  it('falls back to file order when a link cannot be followed', () => {
    expect(
      uuids(
        replayTranscriptMessages([row('a', null), row('b', 'missing')])
          .messages,
      ),
    ).toEqual(['a', 'b'])
  })
})

describe('store writes parentUuid', () => {
  let home = ''
  let sessionId = ''

  afterEach(() => {
    if (sessionId) forgetSession(sessionId)
    if (home) fs.rmSync(home, { recursive: true, force: true })
  })

  it('chains rows and drops a rewound branch on reload', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-chain-'))
    const session = createSession({ agentHome: home, cwd: home })
    sessionId = session.id
    const say = (uuid: string): Message => {
      const message = { role: 'user', content: uuid, uuid } as Message
      session.messages.push(message)
      appendMessage(sessionId, message)
      return message
    }
    say('one')
    say('two')
    say('three')
    session.messages.splice(1)
    setChainTip(sessionId, 'one')
    say('four')

    const rows = fs
      .readFileSync(getSessionTranscriptPath(sessionId)!, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(r => r.type === 'message')
    expect(rows.map(r => [r.uuid, r.parentUuid])).toEqual([
      ['one', null],
      ['two', 'one'],
      ['three', 'two'],
      ['four', 'one'],
    ])

    forgetSession(sessionId)
    const reloaded = getSession(sessionId, { agentHome: home })!
    expect(uuids(reloaded.messages)).toEqual(['one', 'four'])
    say('five')
    forgetSession(sessionId)
    expect(uuids(getSession(sessionId, { agentHome: home })!.messages)).toEqual(
      ['one', 'four', 'five'],
    )
  })
})
