import { describe, expect, it } from 'vitest'
import { ServerMessageSchema } from '../../protocol/src/server.js'
import type { OutgoingMessage } from '../../protocol/src/wire.js'
import { WireEmitter } from './wire-emitter.js'

describe('turn activity protocol', () => {
  it('accepts generic turn state messages', () => {
    expect(
      ServerMessageSchema.parse({
        type: 'system',
        subtype: 'turn_state',
        state: 'preparing',
        detail_code: 'extensions.load',
        label: 'Loading extensions',
        session_id: 'session-1',
      }),
    ).toMatchObject({
      state: 'preparing',
      detail_code: 'extensions.load',
    })
  })

  it('deduplicates identical state updates and follows streamed activity', () => {
    const messages: OutgoingMessage[] = []
    const wire = new WireEmitter(
      { emit: message => messages.push(message) },
      'session-1',
    )

    wire.turnState('preparing', 'turn.accepted')
    wire.turnState('preparing', 'turn.accepted')
    wire.reasoningStart()
    wire.textDelta('hello')

    expect(
      messages
        .filter(
          message =>
            message.type === 'system' && message.subtype === 'turn_state',
        )
        .map(message => ('state' in message ? message.state : undefined)),
    ).toEqual(['preparing', 'thinking', 'responding'])
  })
})
