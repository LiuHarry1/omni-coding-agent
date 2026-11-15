import { describe, expect, it } from 'vitest'
import type { Message } from '../core/types.js'
import { historyNotifications } from './history.js'

describe('ACP session history', () => {
  it('replays user text, agent text and thinking, and tool calls with results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'list files', uuid: 'u1' },
      { role: 'user', content: 'model-only', uuid: 'meta', isMeta: true },
      {
        role: 'assistant',
        uuid: 'a1',
        content: [
          { type: 'reasoning', text: 'look around' },
          { type: 'text', text: 'Listing.' },
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        uuid: 'r1',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'Bash',
            output: { type: 'text', value: 'a.txt' },
          },
        ],
      },
    ]
    const updates = historyNotifications('s1', messages, '/w').map(
      n => n.update,
    )
    expect(updates.map(u => u.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ])
    expect(updates[0]).toMatchObject({
      messageId: 'u1',
      content: { type: 'text', text: 'list files' },
    })
    expect(updates[3]).toMatchObject({
      toolCallId: 't1',
      rawInput: { command: 'ls' },
    })
    expect(updates[4]).toMatchObject({
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
    })
  })
})
