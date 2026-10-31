import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamChatTurn, streamDurableRun, agentApi } = vi.hoisted(() => ({
  streamChatTurn: vi.fn(),
  streamDurableRun: vi.fn(),
  agentApi: {
    listSessions: vi.fn(async () => ({ sessions: [] })),
    getSessionMessages: vi.fn(),
    getScheduledTasks: vi.fn(async () => ({ tasks: [] })),
  },
}))
vi.mock('./chat/stream-chat.js', () => ({
  streamChatTurn,
  streamDurableRun,
  streamSessionLive: vi.fn(),
}))
vi.mock('../lib/api/agent.js', () => ({
  agentApi,
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
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = handle => clearTimeout(handle)

const { useChatStore } = await import('./chat-store.js')

describe('chat hydration guards', () => {
  beforeEach(() => {
    values.clear()
    streamChatTurn.mockReset()
    streamDurableRun.mockReset()
    agentApi.getSessionMessages.mockReset()
    agentApi.getScheduledTasks.mockReset()
    agentApi.getScheduledTasks.mockResolvedValue({ tasks: [] })
    useChatStore.setState({
      currentSessionId: null,
      sessionLoading: false,
      bubbleOrder: [],
      bubblesById: {},
      activeTurnId: null,
      isStreaming: false,
      abortController: null,
      currentRunId: null,
      lastRunSeq: 0,
      runConnectionStatus: 'idle',
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

  it('hydrates the transcript then resumes an active run after checkpoint_seq', async () => {
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [{ type: 'user', id: 'u1', content: 'durable task' }],
      active_run: {
        run_id: 'run-active',
        status: 'running',
        last_seq: 7,
        checkpoint_seq: 4,
      },
    })
    streamDurableRun.mockImplementation(async options => {
      options.onEvent({
        type: 'stream_event',
        delta: { kind: 'text', text: 'resumed' },
        __eventId: '5',
      })
      options.onEvent({
        type: 'result',
        subtype: 'success',
        reason: 'done',
        __eventId: '6',
      })
      return { runId: options.runId, lastSeq: 6 }
    })

    await useChatStore.getState().switchSession('session-with-active-run')
    await vi.waitFor(() => expect(streamDurableRun).toHaveBeenCalledOnce())

    expect(streamDurableRun.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-active',
      afterSeq: 4,
    })
    await vi.waitFor(() =>
      expect(useChatStore.getState().isStreaming).toBe(false),
    )
  })
})
