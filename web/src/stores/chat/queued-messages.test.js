import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = {
  queueMessage: vi.fn(async () => ({ queued: true })),
  removeQueuedMessage: vi.fn(async () => ({ removed: true })),
}
vi.mock('../../lib/api/agent.js', () => ({ agentApi: api }))

const { createQueuedMessageActions, nextQueuedBatch } =
  await import('./queued-messages.js')

/** The queue actions over a plain object standing in for the chat store. */
function storeWith(initial = {}) {
  let state
  const get = () => state
  const set = update => {
    const patch = typeof update === 'function' ? update(state) : update
    state = { ...state, ...patch }
  }
  state = {
    currentSessionId: 'session-1',
    isStreaming: true,
    sessionLoading: false,
    sessionReadOnly: false,
    sendMessage: vi.fn(async () => {}),
    ...createQueuedMessageActions(set, get),
    ...initial,
  }
  return { get, set }
}

const texts = get => get().queuedMessages.map(m => m.text)

beforeEach(() => {
  api.queueMessage.mockClear()
  api.removeQueuedMessage.mockClear()
})

describe('nextQueuedBatch', () => {
  const q = (...items) => items.map((text, i) => ({ id: `m${i}`, text }))

  it('is null for an empty queue', () => {
    expect(nextQueuedBatch([])).toBeNull()
  })

  it('joins plain messages into one', () => {
    expect(nextQueuedBatch(q('fix a', 'and b'))).toEqual({
      text: 'fix a\n\nand b',
      rest: [],
    })
  })

  it('sends a slash command on its own', () => {
    expect(nextQueuedBatch(q('/compact', 'then continue'))).toEqual({
      text: '/compact',
      rest: [{ id: 'm1', text: 'then continue' }],
    })
  })

  it('stops before a slash command', () => {
    expect(nextQueuedBatch(q('fix a', 'and b', '/compact', 'more'))).toEqual({
      text: 'fix a\n\nand b',
      rest: [
        { id: 'm2', text: '/compact' },
        { id: 'm3', text: 'more' },
      ],
    })
  })
})

describe('queueMessage', () => {
  it('keeps the message and mirrors it to the running turn', () => {
    const { get } = storeWith()

    get().queueMessage('  also fix b.ts  ')

    expect(texts(get)).toEqual(['also fix b.ts'])
    expect(api.queueMessage).toHaveBeenCalledWith('session-1', {
      id: get().queuedMessages[0].id,
      message: 'also fix b.ts',
    })
    expect(get().sendMessage).not.toHaveBeenCalled()
  })

  it('sends at once when no turn is running', () => {
    const { get } = storeWith({ isStreaming: false })

    get().queueMessage('hello')

    expect(get().sendMessage).toHaveBeenCalledWith('hello')
    expect(texts(get)).toEqual([])
    expect(api.queueMessage).not.toHaveBeenCalled()
  })

  it('keeps a slash command for after the turn without mirroring it', () => {
    const { get } = storeWith()

    get().queueMessage('/compact')

    expect(texts(get)).toEqual(['/compact'])
    expect(api.queueMessage).not.toHaveBeenCalled()
  })

  it('ignores empty text and read-only sessions', () => {
    const { get } = storeWith()
    get().queueMessage('   ')
    expect(texts(get)).toEqual([])

    const readOnly = storeWith({ sessionReadOnly: true })
    readOnly.get().queueMessage('hello')
    expect(texts(readOnly.get)).toEqual([])
  })

  it('survives the server refusing the mirror', async () => {
    api.queueMessage.mockRejectedValueOnce(new Error('HTTP 409'))
    const { get } = storeWith()

    get().queueMessage('hello')
    await Promise.resolve()

    expect(texts(get)).toEqual(['hello'])
  })
})

describe('removeQueuedMessage', () => {
  it('takes the message back here and on the server', () => {
    const { get } = storeWith()
    get().queueMessage('one')
    get().queueMessage('two')
    const [first] = get().queuedMessages

    get().removeQueuedMessage(first.id)

    expect(texts(get)).toEqual(['two'])
    expect(api.removeQueuedMessage).toHaveBeenCalledWith('session-1', first.id)
  })

  it('does nothing for a message that already left the queue', () => {
    const { get } = storeWith()

    get().removeQueuedMessage('gone')

    expect(api.removeQueuedMessage).not.toHaveBeenCalled()
  })
})

describe('flushQueuedMessages', () => {
  it('sends what the turn did not get to once it is over', () => {
    const { get, set } = storeWith()
    get().queueMessage('one')
    get().queueMessage('two')

    get().flushQueuedMessages()
    expect(get().sendMessage).not.toHaveBeenCalled()

    set({ isStreaming: false })
    get().flushQueuedMessages()

    expect(get().sendMessage).toHaveBeenCalledWith('one\n\ntwo')
    expect(texts(get)).toEqual([])
  })

  it('leaves what follows a slash command for the turn after', () => {
    const { get, set } = storeWith()
    get().queueMessage('/compact')
    get().queueMessage('then continue')
    set({ isStreaming: false })

    get().flushQueuedMessages()

    expect(get().sendMessage).toHaveBeenCalledWith('/compact')
    expect(texts(get)).toEqual(['then continue'])
  })

  it('sends nothing for an empty queue', () => {
    const { get } = storeWith({ isStreaming: false })

    get().flushQueuedMessages()

    expect(get().sendMessage).not.toHaveBeenCalled()
  })
})

describe('_returnQueuedMessagesToComposer', () => {
  it('moves the queued text into a draft and clears the server copy', () => {
    const { get } = storeWith()
    get().queueMessage('one')
    get().queueMessage('two')
    const ids = get().queuedMessages.map(m => m.id)

    get()._returnQueuedMessagesToComposer()

    expect(texts(get)).toEqual([])
    expect(get().restoredDraft.text).toBe('one\n\ntwo')
    expect(api.removeQueuedMessage.mock.calls).toEqual([
      ['session-1', ids[0]],
      ['session-1', ids[1]],
    ])

    get().consumeRestoredDraft()
    expect(get().restoredDraft).toBeNull()
  })

  it('leaves the draft alone when nothing is queued', () => {
    const { get } = storeWith()

    get()._returnQueuedMessagesToComposer()

    expect(get().restoredDraft).toBeNull()
  })
})
