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

/** Mutators over a plain state object with a turn in progress. */
function liveTurn(initial = {}) {
  let state = {
    ...emptyTranscript(),
    isStreaming: true,
    activeTurnId: 'turn-1',
    queuedMessages: [],
    scheduledTurnActive: false,
    ...initial,
  }
  const get = () => state
  const set = update => {
    const patch = typeof update === 'function' ? update(state) : update
    state = { ...state, ...patch }
  }
  const mutators = createAssistantMutators(set, get)
  // Thinking placeholders are not what these tests look at.
  state._setThinking = () => {}
  const kinds = () =>
    state.bubbleOrder.map(id => {
      const b = state.bubblesById[id]
      return b.kind === 'user' ? `user:${b.content}` : b.kind
    })
  return { mutators, get, set, kinds }
}

describe('_onQueuedCommand', () => {
  const withWork = () => {
    const turn = liveTurn({ queuedMessages: [{ id: 'q1', text: 'also b' }] })
    turn.set(s =>
      appendBubble(
        appendBubble(s, {
          id: 'user-1',
          kind: 'user',
          content: 'fix a',
          turnStartTime: 1000,
        }),
        {
          id: toolBubbleId('call-1'),
          kind: 'tool',
          turnId: 'turn-1',
          toolCallId: 'call-1',
          name: 'Read',
          status: 'done',
        },
      ),
    )
    return turn
  }

  it('moves the message from the queue into the transcript', () => {
    const { mutators, get, kinds } = withWork()

    mutators._onQueuedCommand({
      command_mode: 'prompt',
      prompt: 'also b',
      command_uuid: 'q1',
    })

    expect(kinds()).toEqual(['user:fix a', 'tool', 'user:also b'])
    expect(get().queuedMessages).toEqual([])
    const added = get().bubblesById[get().bubbleOrder.at(-1)]
    expect(added.queued).toBe(true)
    expect(typeof added.turnStartTime).toBe('number')
  })

  it('starts a new stretch of work and closes the timing of the one before', () => {
    const { mutators, get } = withWork()

    mutators._onQueuedCommand({ command_mode: 'prompt', prompt: 'also b' })

    expect(get().activeTurnId).not.toBe('turn-1')
    expect(get().activeTurnId).toBeTruthy()
    expect(typeof get().bubblesById['user-1'].turnEndTime).toBe('number')
  })

  it('shows a message this client did not queue as well', () => {
    const { mutators, get, kinds } = withWork()

    mutators._onQueuedCommand({
      command_mode: 'prompt',
      prompt: 'from another tab',
      command_uuid: 'other',
    })

    expect(kinds().at(-1)).toBe('user:from another tab')
    expect(get().queuedMessages).toEqual([{ id: 'q1', text: 'also b' }])
  })

  it.each([
    ['a task notification', { command_mode: 'task-notification', prompt: 'x' }],
    ['empty text', { command_mode: 'prompt', prompt: '  ' }],
    ['no payload', undefined],
  ])('shows nothing for %s', (_name, event) => {
    const { mutators, get, kinds } = withWork()

    mutators._onQueuedCommand(event)

    expect(kinds()).toEqual(['user:fix a', 'tool'])
    expect(get().activeTurnId).toBe('turn-1')
  })
})

describe('_beginQueuedTurn', () => {
  it('opens a turn under a notice listing what finished', () => {
    const { mutators, get, kinds } = liveTurn({
      isStreaming: false,
      activeTurnId: null,
    })

    mutators._beginQueuedTurn({
      command_mode: 'task-notification',
      summaries: [
        'Agent "audit" completed',
        '',
        'Background command "npm test" completed',
      ],
    })

    expect(kinds()).toEqual(['task_notification'])
    expect(get().bubblesById[get().bubbleOrder[0]].summaries).toEqual([
      'Agent "audit" completed',
      'Background command "npm test" completed',
    ])
    expect(get()).toMatchObject({
      isStreaming: true,
      scheduledTurnActive: true,
    })
    expect(get().activeTurnId).toBeTruthy()
  })

  it('does not cut into a turn that is already on screen', () => {
    const { mutators, get, kinds } = liveTurn()

    mutators._beginQueuedTurn({ summaries: ['x'] })

    expect(kinds()).toEqual([])
    expect(get().activeTurnId).toBe('turn-1')
  })
})
