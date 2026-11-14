import { describe, expect, it } from 'vitest'
import { buildTruncationReminder } from '../../core/query/helpers.js'
import type { Message } from '../../core/types.js'
import { extractPartialResult } from './finalizeAgentTool.js'

const user = (content: string): Message => ({ role: 'user', content })
const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})
const toolCallOnly = (): Message => ({
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: {} },
  ],
})

describe('extractPartialResult', () => {
  it('returns the latest assistant text, skipping tool-call-only turns', () => {
    expect(
      extractPartialResult([
        user('go'),
        assistant('first'),
        assistant('summary'),
        toolCallOnly(),
      ]),
    ).toBe('summary')
  })

  it('joins an answer split by output-limit continuations', () => {
    expect(
      extractPartialResult([
        user('write a report'),
        assistant('## Report\nThe first par'),
        buildTruncationReminder(),
        assistant('t continues here'),
        buildTruncationReminder(),
        assistant(' and ends.'),
      ]),
    ).toBe('## Report\nThe first part continues here and ends.')
  })

  it('looks past meta injections between the pieces', () => {
    expect(
      extractPartialResult([
        user('go'),
        assistant('Hel'),
        { role: 'user', content: 'memory', isMeta: true },
        buildTruncationReminder(),
        assistant('lo'),
      ]),
    ).toBe('Hello')
  })

  it('does not join across an ordinary user turn', () => {
    expect(
      extractPartialResult([
        user('one'),
        assistant('older answer'),
        user('two'),
        assistant('newer answer'),
      ]),
    ).toBe('newer answer')
  })

  it('does not join across a reminder for a dropped tool call', () => {
    expect(
      extractPartialResult([
        user('go'),
        assistant('Writing the file.'),
        buildTruncationReminder(['Write']),
        assistant('Done.'),
      ]),
    ).toBe('Done.')
  })

  it('stops the chain at a tool exchange', () => {
    expect(
      extractPartialResult([
        user('go'),
        assistant('cut off before the call'),
        buildTruncationReminder(),
        toolCallOnly(),
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'Read',
              output: { type: 'text', value: 'ok' },
            },
          ],
        },
        assistant('final'),
      ]),
    ).toBe('final')
  })
})
