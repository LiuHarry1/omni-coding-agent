/**
 * Turn timing: stamped on the message that opened the turn, persisted, and
 * shown as the web "Worked for …" duration after a reload.
 *
 * Run: npx tsx src/tests/test-turn-timing.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AssistantMessage, Message, UserMessage } from '../core/types.js'
import {
  appendMessage,
  createSession,
  deleteSession,
} from '../session/index.js'
import { sessionJsonlToUIMessages } from '../server/session-ui.js'
import { stampTurnTiming } from '../turn/turn-timing.js'
import { messagesToBubbles } from '../../web/src/lib/bubbles/messages-to-bubbles.js'
import { buildFlatElements } from '../../web/src/lib/bubbles/flat-elements.js'

const span = { startTime: 10_000, endTime: 19_400 }
function reply(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

{
  // Meta preludes go first; the message built from the input gets the span.
  const prelude: UserMessage = {
    role: 'user',
    content: 'attachment',
    isMeta: true,
  }
  const composer: UserMessage = { role: 'user', content: 'go' }
  stampTurnTiming([prelude, composer, reply('done')], {
    isMeta: false,
    ...span,
  })
  assert.equal(composer.turnStartTime, 10_000)
  assert.equal(composer.turnEndTime, 19_400)
  assert.equal(prelude.turnStartTime, undefined)
}

{
  // Scheduled turns open with a meta message.
  const scheduled: UserMessage = {
    role: 'user',
    content: 'scheduled prompt',
    isMeta: true,
  }
  stampTurnTiming([scheduled, reply('done')], { isMeta: true, ...span })
  assert.equal(scheduled.turnStartTime, 10_000)
}

{
  // Opening message already persisted (mid-turn compaction): a user message
  // after the reply, such as an interrupt marker, must not take the span.
  const interrupt: UserMessage = { role: 'user', content: 'interrupted' }
  stampTurnTiming([reply('partial'), interrupt], { isMeta: false, ...span })
  assert.equal(interrupt.turnStartTime, undefined)
}

const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-timing-'))
const sessionsToDelete: string[] = []

try {
  // Disk → reload → transcript: the reloaded turn keeps its Worked duration.
  const session = createSession({ agentHome, cwd: process.cwd() })
  sessionsToDelete.push(session.id)
  const turn: Message[] = [
    { role: 'user', content: 'read the config' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the config first.' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'Read',
          input: { file_path: 'config.json' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'Read',
          output: { type: 'text', value: '{}' },
        },
      ],
    },
    reply('The config is empty.'),
  ]
  stampTurnTiming(turn, { isMeta: false, ...span })
  for (const message of turn) appendMessage(session.id, message)

  const ui = sessionJsonlToUIMessages(session.id) as Array<
    Record<string, unknown>
  >
  const uiUser = ui.find(m => m.type === 'user')
  assert.equal(uiUser?.turnStartTime, 10_000)
  assert.equal(uiUser?.turnEndTime, 19_400)

  const { bubbleOrder, bubblesById } = messagesToBubbles(ui)
  const flat = buildFlatElements(bubbleOrder, bubblesById) as Array<{
    type: string
    durationMs?: number
    durationLabel?: string
  }>
  const worked = flat.find(el => el.type === 'work_group')
  assert.ok(worked, 'narration + tool fold into Worked after reload')
  assert.equal(worked.durationMs, 9_400)
  assert.equal(worked.durationLabel, 'for 10s')

  console.log('turn-timing tests OK')
} finally {
  for (const sessionId of sessionsToDelete) deleteSession(sessionId)
  fs.rmSync(agentHome, { recursive: true, force: true })
}
