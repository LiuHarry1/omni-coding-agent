import { create } from 'zustand'
import { fetchJSON } from '../lib/api/_http.js'
import { useCapabilitiesStore } from './capabilities-store.js'

export const WORKSPACE_RECENTS_KEY = 'coding_agent_workspace_recents'
const MAX_RECENT_HANDLES = 10

const sessionWorkspaceApi = {
  getSessionWorkspace: sessionId =>
    fetchJSON(`/sessions/${encodeURIComponent(sessionId)}/workspace`),
}

function isProfile(value) {
  return value === 'desktop' || value === 'cloud'
}

export function normalizeWorkspaceHandle(value) {
  if (!value || typeof value !== 'object') return null
  const environmentId = value.environmentId
  const cwd = value.cwd
  if (
    typeof environmentId !== 'string' ||
    !environmentId.trim() ||
    environmentId.length > 512 ||
    typeof cwd !== 'string' ||
    !cwd.trim() ||
    cwd.length > 4096
  ) {
    return null
  }
  return { environmentId, cwd }
}

export function sameWorkspaceHandle(left, right) {
  if (!left || !right) return left === right
  return left.environmentId === right.environmentId && left.cwd === right.cwd
}

function profileFor(handle, fallback) {
  if (handle?.environmentId.startsWith('cloud:')) return 'cloud'
  return isProfile(fallback) ? fallback : 'desktop'
}

function safeLabel(value) {
  if (value == null) return null
  if (typeof value !== 'string') return null
  return value.slice(0, 512)
}

function normalizeRecent(value, fallbackProfile) {
  if (!value || typeof value !== 'object') return null
  const handle = normalizeWorkspaceHandle(value.handle ?? value)
  if (!handle) return null
  return {
    ...handle,
    label: safeLabel(value.label),
    profile: profileFor(handle, value.profile ?? fallbackProfile),
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0,
  }
}

function resolveStorage(storage) {
  if (storage !== undefined) return storage
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readRecentHandles(storage, profile) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(WORKSPACE_RECENTS_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set()
    const recents = []
    for (const value of parsed) {
      const recent = normalizeRecent(value, profile)
      if (!recent) continue
      const key = `${recent.environmentId}\0${recent.cwd}`
      if (seen.has(key)) continue
      seen.add(key)
      recents.push(recent)
      if (recents.length === MAX_RECENT_HANDLES) break
    }
    return recents
  } catch {
    return []
  }
}

function writeRecentHandles(storage, recents) {
  if (!storage) return
  try {
    storage.setItem(WORKSPACE_RECENTS_KEY, JSON.stringify(recents))
  } catch {
    // Storage can be disabled, full, or unavailable in private contexts.
  }
}

function applyOptions(value) {
  if (typeof value === 'string' || value === null) return { label: value }
  return value && typeof value === 'object' ? value : {}
}

/**
 * Current frontend workspace, independent from chat transcript ownership.
 * The API and storage dependencies are injectable so race and persistence
 * behavior can be tested without a browser.
 */
export function createWorkspaceContextStore(options = {}) {
  const config =
    typeof options?.getSessionWorkspace === 'function'
      ? { api: options }
      : options
  const api = config.api ?? sessionWorkspaceApi
  const storage = resolveStorage(config.storage)
  const getProfile =
    config.getProfile ??
    (() =>
      isProfile(config.profile)
        ? config.profile
        : useCapabilitiesStore.getState().profile || 'desktop')
  const initialProfile = profileFor(null, getProfile())
  let syncVersion = 0
  let switchGuard = null

  const store = create((set, get) => {
    const commit = (candidate, rawOptions) => {
      const handle = normalizeWorkspaceHandle(candidate?.handle ?? candidate)
      if (!handle) return false

      const opts = applyOptions(rawOptions)
      const hasOptionLabel = Object.prototype.hasOwnProperty.call(opts, 'label')
      const hasCandidateLabel =
        candidate &&
        typeof candidate === 'object' &&
        Object.prototype.hasOwnProperty.call(candidate, 'label')
      const same = sameWorkspaceHandle(get().handle, handle)
      const label = hasOptionLabel
        ? safeLabel(opts.label)
        : hasCandidateLabel
          ? safeLabel(candidate.label)
          : same
            ? get().label
            : handle.cwd
      const profile = profileFor(
        handle,
        opts.profile ?? candidate?.profile ?? getProfile(),
      )

      let recentHandles = get().recentHandles
      if (opts.remember !== false) {
        const now = Date.now()
        const recent = {
          ...handle,
          label,
          profile,
          lastUsedAt: now,
        }
        recentHandles = [
          recent,
          ...recentHandles.filter(item => !sameWorkspaceHandle(item, handle)),
        ].slice(0, MAX_RECENT_HANDLES)
        writeRecentHandles(storage, recentHandles)
      }

      set({
        handle,
        cwd: handle.cwd,
        label,
        profile,
        recentHandles,
      })
      return true
    }

    return {
      handle: null,
      cwd: '',
      label: null,
      profile: initialProfile,
      recentHandles: readRecentHandles(storage, initialProfile),

      apply: (candidate, options) => {
        if (candidate == null) {
          get().clear()
          return true
        }
        const handle = normalizeWorkspaceHandle(candidate?.handle ?? candidate)
        if (!handle) return false
        const opts = applyOptions(options)
        if (
          opts.invalidateSync !== false &&
          !sameWorkspaceHandle(get().handle, handle)
        ) {
          syncVersion += 1
        }
        return commit(candidate, opts)
      },

      /**
       * User-initiated selection. The chat store installs a guard which
       * clears a transcript before a different workspace is committed.
       */
      select: (candidate, options) => {
        const handle = normalizeWorkspaceHandle(candidate?.handle ?? candidate)
        if (!handle) return false
        if (!sameWorkspaceHandle(get().handle, handle)) {
          if (switchGuard && switchGuard(handle) === false) return false
          syncVersion += 1
        }
        return commit(candidate, options)
      },

      clear: () => {
        syncVersion += 1
        set({ handle: null, cwd: '', label: null })
      },

      /**
       * Restore the server-authoritative binding for a session. Newer calls,
       * explicit selections, and clears invalidate older in-flight responses.
       */
      syncFromSession: async sessionId => {
        const version = ++syncVersion
        if (!sessionId) return null
        try {
          const load =
            api.getSessionWorkspace?.bind(api) ??
            api.sessionWorkspace?.bind(api)
          if (!load) return null
          const response = await load(sessionId)
          if (version !== syncVersion) return null
          const handle = normalizeWorkspaceHandle(response?.workspace)
          if (!handle) return null
          commit(handle, {
            label: response.label,
            profile: profileFor(handle, getProfile()),
          })
          return handle
        } catch {
          // Deleted sessions and temporarily unavailable environments should
          // not erase a workspace the user can still use for a new chat.
          return null
        }
      },
    }
  })

  // Kept outside Zustand state: this is application wiring, not UI state.
  store.setSwitchGuard = guard => {
    switchGuard = typeof guard === 'function' ? guard : null
  }

  return store
}

export const useWorkspaceContextStore = createWorkspaceContextStore()

export function setWorkspaceSwitchGuard(guard) {
  useWorkspaceContextStore.setSwitchGuard(guard)
}

// Capabilities are loaded after the store is created. Keep the exposed runtime
// profile current without making workspace selection own capability loading.
useCapabilitiesStore.subscribe((state, previous) => {
  if (state.profile !== previous.profile) {
    useWorkspaceContextStore.setState({ profile: state.profile })
  }
})
