/**
 * Cloud workspaces (CLOUD_WORKSPACES=docker): which container-backed
 * workspace new chats run in. The active handle itself belongs to the
 * workspace context store; this store only owns managed-workspace lifecycle.
 */
import { create } from 'zustand'
import { cloudWorkspacesApi } from '../lib/api/cloud-workspaces.js'
import { useChatStore } from './chat-store.js'
import {
  sameWorkspaceHandle,
  useWorkspaceContextStore,
} from './workspace-context-store.js'

const STORAGE_KEY = 'coding_agent_cloud_workspace'
const POLL_MS = 1500
const CLOUD_PREFIX = 'cloud:'

function cloudHandle(ws) {
  return ws ? { environmentId: ws.environmentId, cwd: ws.cwd } : null
}

function cloudIdFromHandle(handle) {
  const environmentId = handle?.environmentId || ''
  return environmentId.startsWith(CLOUD_PREFIX)
    ? environmentId.slice(CLOUD_PREFIX.length)
    : null
}

function storedCurrentId() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null
  } catch {
    return null
  }
}

function persistCurrentId(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Selection still works when persistent storage is unavailable.
  }
}

export const useCloudWorkspaceStore = create((set, get) => {
  const polling = new Set()

  const upsert = ws =>
    set(s => ({
      workspaces: s.workspaces.some(w => w.id === ws.id)
        ? s.workspaces.map(w => (w.id === ws.id ? ws : w))
        : [ws, ...s.workspaces],
    }))

  const rememberCurrent = ws => {
    const id = ws?.id ?? null
    persistCurrentId(id)
    set({ currentId: id })
  }

  const setCurrent = (ws, { userSelection = false } = {}) => {
    if (!ws) {
      rememberCurrent(null)
      return true
    }
    const context = useWorkspaceContextStore.getState()
    const apply = userSelection ? context.select : context.apply
    const applied = apply(cloudHandle(ws), {
      label: ws.name,
      profile: 'cloud',
    })
    if (!applied) return false
    rememberCurrent(ws)
    return true
  }

  const recoverMissing = (id, nextWorkspaces) => {
    const rest =
      nextWorkspaces ??
      get().workspaces.filter(workspace => workspace.id !== id)
    set(s => ({
      workspaces: rest,
      pendingId: s.pendingId === id ? null : s.pendingId,
    }))

    const context = useWorkspaceContextStore.getState()
    const contextRemoved = cloudIdFromHandle(context.handle) === id
    const selectionRemoved = get().currentId === id
    if (!contextRemoved && !selectionRemoved) return false

    if (contextRemoved) {
      const chat = useChatStore.getState()
      if (chat.currentSessionId || chat.bubbleOrder.length > 0) {
        chat.clearSession()
      }
      context.clear()
    }
    rememberCurrent(null)
    const fallback = rest.find(workspace => workspace.status === 'ready')
    if (fallback) setCurrent(fallback)
    return true
  }

  const poll = async (id, { selectWhenReady = false } = {}) => {
    if (polling.has(id)) return
    polling.add(id)
    try {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
        let ws
        try {
          ;({ workspace: ws } = await cloudWorkspacesApi.get(id))
        } catch (err) {
          if (err?.status === 404) {
            recoverMissing(id)
            return
          }
          continue
        }
        upsert(ws)
        if (ws.status === 'provisioning') continue
        if (get().pendingId === id) {
          set({ pendingId: null })
        }
        if (ws.status === 'ready' && selectWhenReady) {
          get().select(id)
        }
        return
      }
    } finally {
      polling.delete(id)
    }
  }

  return {
    enabled: false,
    loaded: false,
    workspaces: [],
    limit: null,
    currentId: storedCurrentId(),
    /** Workspace this tab just created and is waiting on. */
    pendingId: null,

    /** Fetch the list; resolves false when the server has the feature off. */
    load: async () => {
      let data
      try {
        data = await cloudWorkspacesApi.list()
      } catch {
        data = null
      }
      if (!data?.enabled) {
        set({ loaded: true, enabled: false })
        return false
      }
      const workspaces = data.workspaces || []
      set({
        enabled: true,
        loaded: true,
        workspaces,
        limit: data.limit ?? null,
      })
      const ready = workspaces.filter(w => w.status === 'ready')
      const context = useWorkspaceContextStore.getState()
      const contextId = cloudIdFromHandle(context.handle)
      const selected = contextId
        ? ready.find(w => w.id === contextId)
        : ready.find(w => w.id === get().currentId) || ready[0]
      if (selected) {
        rememberCurrent(selected)
        if (!context.handle || contextId === selected.id) {
          context.apply(cloudHandle(selected), {
            label: selected.name,
            profile: 'cloud',
            invalidateSync: false,
          })
        }
      } else if (contextId) {
        recoverMissing(contextId, workspaces)
      } else {
        rememberCurrent(null)
      }
      for (const w of workspaces) {
        if (w.status === 'provisioning') void poll(w.id)
      }
      return true
    },

    refresh: async () => {
      try {
        const data = await cloudWorkspacesApi.list()
        const runtimeById = new Map(
          get().workspaces.map(workspace => [
            workspace.id,
            workspace.runtimeStatus,
          ]),
        )
        const workspaces = (data.workspaces || []).map(workspace => ({
          ...workspace,
          ...(runtimeById.get(workspace.id)
            ? { runtimeStatus: runtimeById.get(workspace.id) }
            : {}),
        }))
        set({
          workspaces,
          limit: data.limit ?? null,
        })
        const contextId = cloudIdFromHandle(
          useWorkspaceContextStore.getState().handle,
        )
        if (
          contextId &&
          !workspaces.some(workspace => workspace.id === contextId)
        ) {
          recoverMissing(contextId, workspaces)
          return
        }
        const currentId = get().currentId
        if (
          currentId &&
          !workspaces.some(workspace => workspace.id === currentId)
        ) {
          recoverMissing(currentId, workspaces)
          return
        }
        get().alignToContext()
      } catch {
        /* keep the last list */
      }
    },

    /** Pick a workspace; a chat with history stays where it started. */
    select: id => {
      const ws = get().workspaces.find(w => w.id === id)
      if (!ws || ws.status !== 'ready') return
      return setCurrent(ws, { userSelection: true })
    },

    /** Align lifecycle selection after workspace context restores a Session. */
    alignToContext: () => {
      const context = useWorkspaceContextStore.getState()
      const id = cloudIdFromHandle(context.handle)
      if (!id) return false
      const ws = get().workspaces.find(
        item => item.id === id && item.status === 'ready',
      )
      if (!ws) {
        if (get().loaded) void get().refresh()
        return false
      }
      rememberCurrent(ws)
      context.apply(cloudHandle(ws), {
        label: context.label || ws.name,
        profile: 'cloud',
      })
      return true
    },

    /** @param {{name?: string, repoUrl?: string, ref?: string}} input */
    create: async input => {
      const { workspace } = await cloudWorkspacesApi.create(input)
      upsert(workspace)
      set({ pendingId: workspace.id })
      const chat = useChatStore.getState()
      const selectWhenReady =
        !useWorkspaceContextStore.getState().handle &&
        !chat.currentSessionId &&
        chat.bubbleOrder.length === 0
      void poll(workspace.id, { selectWhenReady })
      return workspace
    },

    rename: async (id, name) => {
      const { workspace } = await cloudWorkspacesApi.rename(id, name)
      const previous = get().workspaces.find(item => item.id === id)
      const updated = {
        ...workspace,
        ...(previous?.runtimeStatus
          ? { runtimeStatus: previous.runtimeStatus }
          : {}),
      }
      upsert(updated)
      if (
        cloudIdFromHandle(useWorkspaceContextStore.getState().handle) === id
      ) {
        useWorkspaceContextStore.getState().apply(cloudHandle(updated), {
          label: updated.name,
          profile: 'cloud',
        })
      }
      return updated
    },

    /** Stop the disposable runtime while retaining the workspace volume. */
    stop: async id => {
      await cloudWorkspacesApi.stop(id)
      const workspace = get().workspaces.find(item => item.id === id)
      if (workspace) upsert({ ...workspace, runtimeStatus: 'stopped' })
    },

    remove: async id => {
      await cloudWorkspacesApi.remove(id)
      const rest = get().workspaces.filter(w => w.id !== id)
      recoverMissing(id, rest)
      void useChatStore.getState().refreshSessions()
    },
  }
})

useWorkspaceContextStore.subscribe((state, previous) => {
  if (sameWorkspaceHandle(state.handle, previous.handle)) return
  if (cloudIdFromHandle(state.handle)) {
    useCloudWorkspaceStore.getState().alignToContext()
  }
})
