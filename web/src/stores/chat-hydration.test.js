import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamChatTurn, streamDurableRun, agentApi } = vi.hoisted(() => ({
  streamChatTurn: vi.fn(),
  streamDurableRun: vi.fn(),
  agentApi: {
    listSessions: vi.fn(async () => ({ sessions: [] })),
    getSessionMessages: vi.fn(),
    getScheduledTasks: vi.fn(async () => ({ tasks: [] })),
    setSessionMode: vi.fn(async () => ({})),
    setSessionAgent: vi.fn(async () => ({})),
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
const { useWorkspaceContextStore } =
  await import('./workspace-context-store.js')

function deferred() {
  let resolve
  const promise = new Promise(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('chat hydration guards', () => {
  beforeEach(() => {
    values.clear()
    streamChatTurn.mockReset()
    streamDurableRun.mockReset()
    agentApi.getSessionMessages.mockReset()
    agentApi.getScheduledTasks.mockReset()
    agentApi.getScheduledTasks.mockResolvedValue({ tasks: [] })
    agentApi.setSessionMode.mockClear()
    agentApi.setSessionAgent.mockClear()
    useWorkspaceContextStore.getState().clear()
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
      agentMode: 'agent',
      agentType: null,
      agentPicker: null,
    })
  })

  it('does not submit while session hydration is active', async () => {
    useChatStore.setState({ sessionLoading: true })
    await useChatStore.getState().sendMessage('wait for hydration')
    expect(streamChatTurn).not.toHaveBeenCalled()
    expect(useChatStore.getState().bubbleOrder).toEqual([])
  })

  it('keeps session loading active until workspace restoration finishes', async () => {
    const workspaceSync = deferred()
    const originalSync = useWorkspaceContextStore.getState().syncFromSession
    const syncFromSession = vi.fn(() => workspaceSync.promise)
    useWorkspaceContextStore.setState({ syncFromSession })
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [{ type: 'user', id: 'u1', content: 'bound message' }],
    })

    try {
      const switching = useChatStore.getState().switchSession('bound-session')
      await Promise.resolve()

      expect(useChatStore.getState().sessionLoading).toBe(true)
      expect(useChatStore.getState().bubbleOrder).toEqual([])
      await useChatStore.getState().sendMessage('must wait')
      expect(streamChatTurn).not.toHaveBeenCalled()

      workspaceSync.resolve({
        environmentId: 'cloud:bound',
        cwd: '/workspace/repo',
      })
      await switching
      expect(useChatStore.getState().sessionLoading).toBe(false)
      expect(useChatStore.getState().bubbleOrder).not.toEqual([])
    } finally {
      useWorkspaceContextStore.setState({ syncFromSession: originalSync })
    }
  })

  it('does not reload the transcript when a live turn learns its session id', async () => {
    useChatStore.setState({
      currentSessionId: 'live-session',
      isStreaming: true,
      bubbleOrder: ['user:1'],
      bubblesById: {
        'user:1': { id: 'user:1', kind: 'user', content: 'still here' },
      },
    })

    await useChatStore.getState().switchSession('live-session')

    expect(agentApi.getSessionMessages).not.toHaveBeenCalled()
    expect(useChatStore.getState().isStreaming).toBe(true)
    expect(useChatStore.getState().bubblesById['user:1']?.content).toBe(
      'still here',
    )
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

  it('builds chat requests from the workspace context snapshot', async () => {
    useWorkspaceContextStore.getState().apply(
      {
        environmentId: 'ssh:dev-box',
        cwd: '/srv/project',
      },
      { label: 'Dev box:/srv/project' },
    )
    streamChatTurn.mockResolvedValue({
      sessionId: 'remote-session',
      runId: null,
      lastSeq: 0,
      permissionMode: null,
      agentType: undefined,
    })

    await useChatStore.getState().sendMessage('use the remote workspace')

    expect(streamChatTurn).toHaveBeenCalledOnce()
    expect(streamChatTurn.mock.calls[0]?.[0]?.body).toMatchObject({
      message: 'use the remote workspace',
      workspace: '/srv/project',
      environmentId: 'ssh:dev-box',
    })
    expect(useChatStore.getState()).not.toHaveProperty('workspace')
    expect(useChatStore.getState()).not.toHaveProperty('workspaceHandle')
  })

  it('clears chat history before selecting a different workspace', () => {
    useWorkspaceContextStore
      .getState()
      .apply({ environmentId: 'local', cwd: '/first' })
    useChatStore.setState({
      currentSessionId: 'bound-session',
      bubbleOrder: ['user:1'],
      bubblesById: {
        'user:1': { id: 'user:1', kind: 'user', content: 'existing' },
      },
    })

    expect(
      useWorkspaceContextStore
        .getState()
        .select({ environmentId: 'local', cwd: '/second' }),
    ).toBe(true)

    expect(useChatStore.getState().currentSessionId).toBeNull()
    expect(useChatStore.getState().bubbleOrder).toEqual([])
    expect(useWorkspaceContextStore.getState().cwd).toBe('/second')
  })

  it('keeps the current workspace when starting a new chat', () => {
    useWorkspaceContextStore
      .getState()
      .apply({ environmentId: 'local', cwd: '/keep-me' })

    useChatStore.getState().clearSession()

    expect(useWorkspaceContextStore.getState().cwd).toBe('/keep-me')
  })

  it('uses workspace context for session mode and agent updates', () => {
    useWorkspaceContextStore
      .getState()
      .apply({ environmentId: 'ssh:dev', cwd: '/remote/repo' })
    useChatStore.setState({
      currentSessionId: 'bound-session',
      agentPicker: null,
    })

    useChatStore.getState().setAgentMode('ask')
    useChatStore.getState().setAgentType('reviewer')

    expect(agentApi.setSessionMode).toHaveBeenCalledWith({
      session_id: 'bound-session',
      mode: 'ask',
      workspace: '/remote/repo',
    })
    expect(agentApi.setSessionAgent).toHaveBeenCalledWith({
      session_id: 'bound-session',
      agentType: 'reviewer',
      workspace: '/remote/repo',
    })
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
