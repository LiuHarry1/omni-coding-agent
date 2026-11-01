import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudWorkspacesApi, chatState } = vi.hoisted(() => ({
  cloudWorkspacesApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
  },
  chatState: {
    clearSession: vi.fn(),
    refreshSessions: vi.fn(),
    currentSessionId: null,
    bubbleOrder: [],
  },
}))

vi.mock('../lib/api/cloud-workspaces.js', () => ({
  cloudWorkspacesApi,
}))
vi.mock('./chat-store.js', () => ({
  useChatStore: { getState: () => chatState },
}))

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}

const { useWorkspaceContextStore } =
  await import('./workspace-context-store.js')
const { useCloudWorkspaceStore } = await import('./cloud-workspace-store.js')

const workspaces = [
  {
    id: 'one',
    name: 'One',
    status: 'ready',
    environmentId: 'cloud:one',
    cwd: '/workspace/repo',
  },
  {
    id: 'two',
    name: 'Two',
    status: 'ready',
    environmentId: 'cloud:two',
    cwd: '/workspace/repo',
  },
]

describe('cloud workspace context alignment', () => {
  beforeEach(() => {
    values.clear()
    cloudWorkspacesApi.list.mockReset()
    cloudWorkspacesApi.get.mockReset()
    cloudWorkspacesApi.create.mockReset()
    cloudWorkspacesApi.remove.mockReset()
    cloudWorkspacesApi.list.mockResolvedValue({
      enabled: true,
      workspaces,
      limit: 5,
    })
    useWorkspaceContextStore.getState().clear()
    chatState.clearSession.mockClear()
    chatState.refreshSessions.mockClear()
    chatState.currentSessionId = null
    chatState.bubbleOrder = []
    useCloudWorkspaceStore.setState({
      enabled: false,
      loaded: false,
      workspaces: [],
      limit: null,
      currentId: null,
      pendingId: null,
    })
  })

  it('aligns currentId when session context restores a cloud handle', async () => {
    await useCloudWorkspaceStore.getState().load()
    expect(useCloudWorkspaceStore.getState().currentId).toBe('one')

    useWorkspaceContextStore
      .getState()
      .apply(
        { environmentId: 'cloud:two', cwd: '/workspace/repo' },
        { label: 'Session workspace', profile: 'cloud' },
      )

    expect(useCloudWorkspaceStore.getState().currentId).toBe('two')
    expect(useWorkspaceContextStore.getState()).toMatchObject({
      handle: {
        environmentId: 'cloud:two',
        cwd: '/workspace/repo',
      },
      label: 'Session workspace',
    })

    expect(() =>
      useWorkspaceContextStore.getState().apply({
        environmentId: 'cloud:stale',
        cwd: '/workspace/repo',
      }),
    ).not.toThrow()
    await vi.waitFor(() =>
      expect(useWorkspaceContextStore.getState().handle).toEqual({
        environmentId: 'cloud:one',
        cwd: '/workspace/repo',
      }),
    )
    expect(useCloudWorkspaceStore.getState().currentId).toBe('one')
  })

  it('clears a deleted current handle and selects a ready fallback', async () => {
    cloudWorkspacesApi.remove.mockResolvedValue({ ok: true })
    await useCloudWorkspaceStore.getState().load()
    chatState.currentSessionId = 'bound-session'
    chatState.bubbleOrder = ['user:1']

    await useCloudWorkspaceStore.getState().remove('one')

    expect(chatState.clearSession).toHaveBeenCalledOnce()
    expect(useCloudWorkspaceStore.getState().currentId).toBe('two')
    expect(useWorkspaceContextStore.getState().handle).toEqual({
      environmentId: 'cloud:two',
      cwd: '/workspace/repo',
    })
  })

  it('does not auto-switch a historical chat when creation finishes', async () => {
    vi.useFakeTimers()
    try {
      await useCloudWorkspaceStore.getState().load()
      chatState.currentSessionId = 'bound-session'
      chatState.bubbleOrder = ['user:1']
      cloudWorkspacesApi.create.mockResolvedValue({
        workspace: {
          id: 'three',
          name: 'Three',
          status: 'provisioning',
          environmentId: 'cloud:three',
          cwd: '/workspace/repo',
        },
      })
      cloudWorkspacesApi.get.mockResolvedValue({
        workspace: {
          id: 'three',
          name: 'Three',
          status: 'ready',
          environmentId: 'cloud:three',
          cwd: '/workspace/repo',
        },
      })

      await useCloudWorkspaceStore.getState().create({ name: 'Three' })
      await vi.advanceTimersByTimeAsync(1600)

      expect(useCloudWorkspaceStore.getState().currentId).toBe('one')
      expect(useWorkspaceContextStore.getState().handle?.environmentId).toBe(
        'cloud:one',
      )
      expect(chatState.clearSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
