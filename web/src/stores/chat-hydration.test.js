import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamChatTurn } = vi.hoisted(() => ({ streamChatTurn: vi.fn() }))
vi.mock('./chat/stream-chat.js', () => ({
  streamChatTurn,
  streamSessionLive: vi.fn(),
}))
vi.mock('../lib/api/agent.js', () => ({
  agentApi: {
    listSessions: vi.fn(async () => ({ sessions: [] })),
  },
}))
vi.mock('./chat/ide-bridge.js', () => ({
  refreshIdeAfterAgentTurn: vi.fn(),
}))

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
  clear: () => values.clear(),
}

const { useChatStore } = await import('./chat-store.js')

describe('chat hydration guards', () => {
  beforeEach(() => {
    values.clear()
    streamChatTurn.mockReset()
    useChatStore.setState({
      currentSessionId: null,
      sessionLoading: false,
      bubbleOrder: [],
      bubblesById: {},
      activeTurnId: null,
      isStreaming: false,
      abortController: null,
    })
  })

  it('does not submit while session hydration is active', async () => {
    useChatStore.setState({ sessionLoading: true })
    await useChatStore.getState().sendMessage('wait for hydration')
    expect(streamChatTurn).not.toHaveBeenCalled()
    expect(useChatStore.getState().bubbleOrder).toEqual([])
  })

  it('keeps the optimistic user bubble across stale-session retry', async () => {
    streamChatTurn.mockImplementation(async options => {
      options.onSessionNotFound()
      return {
        sessionId: 'replacement-session',
        permissionMode: null,
        agentType: undefined,
      }
    })
    useChatStore.setState({ currentSessionId: 'stale-session' })

    await useChatStore.getState().sendMessage('keep this message')

    const state = useChatStore.getState()
    const userBubbles = state.bubbleOrder
      .map(id => state.bubblesById[id])
      .filter(bubble => bubble?.kind === 'user')
    expect(userBubbles).toHaveLength(1)
    expect(userBubbles[0]?.content).toBe('keep this message')
    expect(state.currentSessionId).toBe('replacement-session')
  })
})
