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
    uploadChatAttachments: vi.fn(),
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

function tokenFor(payload) {
  return `x.${btoa(JSON.stringify(payload))}.x`
}

describe('chat hydration guards', () => {
  beforeEach(() => {
    values.clear()
    streamChatTurn.mockReset()
    streamDurableRun.mockReset()
    agentApi.getSessionMessages.mockReset()
    agentApi.getScheduledTasks.mockReset()
    agentApi.uploadChatAttachments.mockReset()
    agentApi.getScheduledTasks.mockResolvedValue({ tasks: [] })
    agentApi.setSessionMode.mockClear()
    agentApi.setSessionAgent.mockClear()
    useWorkspaceContextStore.getState().clear()
    useChatStore.setState({
      currentSessionId: null,
      sessionLoading: false,
      sessionReadOnly: false,
      viewingOwnerEmail: null,
      sessions: [],
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
      agentPickerFor: null,
      agentPickerLoaded: false,
      draftSelectionChosen: false,
    })
  })

  it('does not submit while session hydration is active', async () => {
    useChatStore.setState({ sessionLoading: true })
    await useChatStore.getState().sendMessage('wait for hydration')
    expect(streamChatTurn).not.toHaveBeenCalled()
    expect(useChatStore.getState().bubbleOrder).toEqual([])
  })

  it('ignores a stale attachment upload after the turn generation changes', async () => {
    const upload = deferred()
    agentApi.uploadChatAttachments.mockReturnValue(upload.promise)
    useChatStore.setState({
      currentSessionId: 'session-1',
      sessionLoading: false,
      sessionReadOnly: false,
      isStreaming: false,
    })

    const sending = useChatStore.getState().sendMessage('inspect this', [
      {
        file: new File(['data'], 'input.csv', { type: 'text/csv' }),
        name: 'input.csv',
        kind: 'file',
        size: 4,
      },
    ])
    const activeGeneration = useChatStore.getState().turnGeneration
    useChatStore.setState({
      turnGeneration: activeGeneration + 1,
      abortController: null,
      isStreaming: false,
    })
    upload.resolve({ session_id: 'stale-session', files: [] })
    await sending

    expect(streamChatTurn).not.toHaveBeenCalled()
    expect(useChatStore.getState().currentSessionId).toBe('session-1')
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

  it("loads another user's session read-only without restoring its workspace", async () => {
    values.set(
      'coding_agent_auth_token',
      tokenFor({
        sub: 'super@example.com',
        role: 'super',
      }),
    )
    const originalSync = useWorkspaceContextStore.getState().syncFromSession
    const syncFromSession = vi.fn()
    useWorkspaceContextStore.setState({ syncFromSession })
    useChatStore.setState({
      sessions: [
        {
          id: 'foreign-session',
          ownerEmail: 'owner@example.com',
        },
      ],
    })
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [{ type: 'user', id: 'u1', content: 'foreign message' }],
    })

    try {
      await useChatStore.getState().switchSession('foreign-session')

      const state = useChatStore.getState()
      expect(state.sessionReadOnly).toBe(true)
      expect(state.viewingOwnerEmail).toBe('owner@example.com')
      expect(state.bubbleOrder).not.toEqual([])
      expect(syncFromSession).not.toHaveBeenCalled()
      expect(agentApi.getScheduledTasks).not.toHaveBeenCalled()

      await state.sendMessage('must not mutate foreign session')
      expect(streamChatTurn).not.toHaveBeenCalled()
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

  it('starts a new chat in the picker default mode, not the last used one', () => {
    useChatStore.setState({
      currentSessionId: 'ask-session',
      agentMode: 'ask',
      agentPicker: {
        modes: ['agent', 'ask', 'plan'],
        primaries: [],
        default: { mode: 'agent', agentType: null },
      },
    })

    useChatStore.getState().clearSession()

    expect(useChatStore.getState().agentMode).toBe('agent')
    expect(values.has('coding_agent_mode')).toBe(false)
  })

  it('restores the mode stored on the session when switching to it', async () => {
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [{ type: 'user', id: 'u1', content: 'read only question' }],
      mode: 'ask',
      agentType: null,
    })

    await useChatStore.getState().switchSession('ask-session')
    expect(useChatStore.getState().agentMode).toBe('ask')

    useChatStore.getState().clearSession()
    expect(useChatStore.getState().agentMode).toBe('agent')
  })

  const allModes = {
    modes: ['agent', 'ask', 'plan'],
    primaries: [],
    default: { mode: 'plan', agentType: null },
  }

  it('starts an untouched new chat at the picker default', () => {
    useChatStore.getState().applyAgentPicker(allModes)
    expect(useChatStore.getState().agentMode).toBe('plan')
  })

  it('keeps a mode picked in a new chat when the picker reloads', () => {
    useChatStore.getState().applyAgentPicker(allModes)
    useChatStore.getState().setAgentMode('ask')

    useChatStore.getState().applyAgentPicker(allModes)
    expect(useChatStore.getState().agentMode).toBe('ask')

    useChatStore
      .getState()
      .applyAgentPicker({ ...allModes, modes: ['agent', 'plan'] })
    expect(useChatStore.getState().agentMode).toBe('plan')

    useChatStore.getState().clearSession()
    useChatStore.getState().applyAgentPicker(allModes)
    expect(useChatStore.getState().agentMode).toBe('plan')
  })

  it('snaps a restored session mode the loaded picker does not allow', async () => {
    useWorkspaceContextStore
      .getState()
      .apply({ environmentId: 'local', cwd: '/repo' })
    useChatStore.setState({
      agentPicker: { ...allModes, modes: ['agent', 'plan'] },
      agentPickerFor: 'local\u0000/repo',
      agentPickerLoaded: true,
    })
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [],
      mode: 'ask',
      agentType: null,
    })

    await useChatStore.getState().switchSession('ask-session')
    expect(useChatStore.getState().agentMode).toBe('plan')
    expect(agentApi.setSessionMode).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'ask-session', mode: 'plan' }),
    )
  })

  it('leaves a restored mode alone when the picker is for another workspace', async () => {
    useWorkspaceContextStore
      .getState()
      .apply({ environmentId: 'local', cwd: '/repo' })
    useChatStore.setState({
      agentPicker: { ...allModes, modes: ['agent', 'plan'] },
      agentPickerFor: 'local\u0000/other',
      agentPickerLoaded: true,
    })
    agentApi.getSessionMessages.mockResolvedValue({
      messages: [],
      mode: 'ask',
      agentType: null,
    })

    await useChatStore.getState().switchSession('ask-session')
    expect(useChatStore.getState().agentMode).toBe('ask')
    expect(agentApi.setSessionMode).not.toHaveBeenCalled()
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
