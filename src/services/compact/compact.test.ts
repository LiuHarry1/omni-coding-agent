import { describe, expect, it } from 'vitest'
import type { RoleMessage } from '../../core/types.js'
import { stripMediaForSummary } from './compact.js'

describe('stripMediaForSummary', () => {
  it('replaces images and documents in user messages and tool results', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
          { type: 'file', data: 'JVBE', mediaType: 'application/pdf' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'browser_screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Screenshot taken' },
                { type: 'image-data', data: 'AAAA', mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ] as unknown as RoleMessage[]

    expect(stripMediaForSummary(messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'text', text: '[image]' },
          { type: 'text', text: '[document]' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'browser_screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Screenshot taken' },
                { type: 'text', text: '[image]' },
              ],
            },
          },
        ],
      },
      messages[2],
    ])
  })
})
