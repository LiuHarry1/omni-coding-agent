import { describe, expect, it } from 'vitest'
import { expandAttachmentMessagesForAPI } from '../messages.js'
import type { Message } from '../../core/types.js'

describe('tool_use_summary for the model', () => {
  it('is left out of what the model reads', () => {
    const messages: Message[] = [
      { role: 'user', content: 'work' },
      {
        type: 'attachment',
        uuid: 'label-1',
        timestamp: '2026-11-14T00:00:00.000Z',
        isMeta: true,
        attachment: {
          type: 'tool_use_summary',
          summary: 'Read config.json',
          precedingToolUseIds: ['call-1'],
        },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]

    const forModel = expandAttachmentMessagesForAPI(messages)

    expect(forModel).toEqual([messages[0], messages[2]])
    expect(JSON.stringify(forModel)).not.toContain('Read config.json')
  })
})
