import { describe, expect, it, vi } from 'vitest'

// The IDE bridge pulls in stores that need a browser.
vi.mock('./ide-bridge.js', () => ({ notifyIdeFilesystemFromTool: vi.fn() }))

const { createAssistantMutators } = await import('./assistant-mutators.js')
import {
  appendBubble,
  emptyTranscript,
  toolBubbleId,
} from '../../lib/bubbles/messages-to-bubbles.js'

/** Mutators over a plain state object standing in for the chat store. */
function transcriptWith(toolCallIds) {
  let state = emptyTranscript()
  for (const toolCallId of toolCallIds) {
    state = appendBubble(state, {
      id: toolBubbleId(toolCallId),
      kind: 'tool',
      turnId: 'turn-1',
      toolCallId,
      name: 'Read',
      status: 'done',
    })
  }
  const get = () => state
  const set = update => {
    const patch = typeof update === 'function' ? update(state) : update
    state = { ...state, ...patch }
  }
  const mutators = createAssistantMutators(set, get)
  const summaryOf = toolCallId =>
    state.bubblesById[toolBubbleId(toolCallId)]?.batchSummary
  return { mutators, summaryOf, get }
}

describe('_setToolUseSummary', () => {
  it('labels the tool calls of the batch and no others', () => {
    const { mutators, summaryOf } = transcriptWith(['a', 'b', 'c'])

    mutators._setToolUseSummary({
      summary: 'Read two files',
      preceding_tool_use_ids: ['a', 'b'],
    })
    mutators._flushStreamBatch()

    expect(summaryOf('a')).toBe('Read two files')
    expect(summaryOf('b')).toBe('Read two files')
    expect(summaryOf('c')).toBeUndefined()
  })

  it('ignores tool calls that are not in the transcript', () => {
    const { mutators, summaryOf, get } = transcriptWith(['a'])
    const before = get()

    mutators._setToolUseSummary({
      summary: 'Ran tests',
      preceding_tool_use_ids: ['gone'],
    })
    mutators._flushStreamBatch()

    expect(summaryOf('a')).toBeUndefined()
    expect(get().bubblesById).toBe(before.bubblesById)
  })

  it.each([
    ['no label', { preceding_tool_use_ids: ['a'] }],
    ['no tool calls', { summary: 'Ran tests' }],
  ])('does nothing for an event with %s', (_name, event) => {
    const { mutators, summaryOf } = transcriptWith(['a'])

    mutators._setToolUseSummary(event)
    mutators._flushStreamBatch()

    expect(summaryOf('a')).toBeUndefined()
  })
})
