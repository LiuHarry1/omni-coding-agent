import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_RECENTS_KEY,
  createWorkspaceContextStore,
} from './workspace-context-store.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
    value: key => values.get(key) ?? null,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('workspace context store', () => {
  it('applies one handle snapshot and selects only after the switch guard', () => {
    const storage = memoryStorage()
    const store = createWorkspaceContextStore({
      storage,
      profile: 'desktop',
    })

    expect(
      store
        .getState()
        .apply({ environmentId: 'local', cwd: '/repo' }, { label: 'Repo' }),
    ).toBe(true)
    expect(store.getState()).toMatchObject({
      handle: { environmentId: 'local', cwd: '/repo' },
      cwd: '/repo',
      label: 'Repo',
      profile: 'desktop',
    })

    const order = []
    store.setSwitchGuard(() => {
      order.push('guard')
      return true
    })
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.cwd !== previous.cwd) order.push('apply')
    })

    expect(
      store
        .getState()
        .select({ environmentId: 'ssh:dev', cwd: '/srv/repo' }, 'Dev'),
    ).toBe(true)
    unsubscribe()
    expect(order).toEqual(['guard', 'apply'])
    expect(store.getState().cwd).toBe('/srv/repo')
  })

  it('loads and persists only valid, deduplicated recent handles', () => {
    const storage = memoryStorage({
      [WORKSPACE_RECENTS_KEY]: JSON.stringify([
        {
          environmentId: 'ssh:dev',
          cwd: '/srv/repo',
          label: 'Dev',
          profile: 'desktop',
          ignored: { token: 'secret' },
        },
        { environmentId: 'ssh:dev', cwd: '/srv/repo', label: 'duplicate' },
        { environmentId: '', cwd: '/invalid' },
        { nope: true },
      ]),
    })
    const store = createWorkspaceContextStore({
      storage,
      profile: 'desktop',
    })

    expect(store.getState().recentHandles).toEqual([
      {
        environmentId: 'ssh:dev',
        cwd: '/srv/repo',
        label: 'Dev',
        profile: 'desktop',
        lastUsedAt: 0,
      },
    ])

    store
      .getState()
      .apply({ environmentId: 'local', cwd: '/next' }, { label: 'Next' })
    const persisted = JSON.parse(storage.value(WORKSPACE_RECENTS_KEY))
    expect(persisted).toHaveLength(2)
    expect(persisted[0]).toMatchObject({
      environmentId: 'local',
      cwd: '/next',
      label: 'Next',
    })
    expect(persisted.some(item => 'ignored' in item)).toBe(false)
  })

  it('ignores stale session responses and unavailable bindings', async () => {
    const oldRequest = deferred()
    const newRequest = deferred()
    const supersededRequest = deferred()
    const api = {
      getSessionWorkspace: vi.fn(sessionId => {
        if (sessionId === 'old') return oldRequest.promise
        if (sessionId === 'new') return newRequest.promise
        if (sessionId === 'superseded') return supersededRequest.promise
        return Promise.reject(new Error('unavailable'))
      }),
    }
    const store = createWorkspaceContextStore({
      api,
      storage: null,
      profile: 'desktop',
    })

    const oldSync = store.getState().syncFromSession('old')
    const newSync = store.getState().syncFromSession('new')
    newRequest.resolve({
      workspace: { environmentId: 'ssh:new', cwd: '/new' },
      label: 'New host:/new',
    })
    await newSync
    oldRequest.resolve({
      workspace: { environmentId: 'ssh:old', cwd: '/old' },
      label: 'Old host:/old',
    })
    await oldSync

    expect(store.getState().handle).toEqual({
      environmentId: 'ssh:new',
      cwd: '/new',
    })
    await expect(
      store.getState().syncFromSession('missing'),
    ).resolves.toBeNull()
    expect(store.getState().cwd).toBe('/new')

    const supersededSync = store.getState().syncFromSession('superseded')
    store.getState().apply({ environmentId: 'local', cwd: '/manual-selection' })
    supersededRequest.resolve({
      workspace: { environmentId: 'ssh:stale', cwd: '/stale' },
      label: 'Stale',
    })
    await supersededSync
    expect(store.getState().cwd).toBe('/manual-selection')
  })

  it('restores a cloud session handle and profile', async () => {
    const store = createWorkspaceContextStore({
      api: {
        getSessionWorkspace: vi.fn(async () => ({
          workspace: {
            environmentId: 'cloud:workspace-7',
            cwd: '/workspace/repo',
          },
          label: 'Project Seven',
        })),
      },
      storage: memoryStorage(),
      profile: 'desktop',
    })

    await store.getState().syncFromSession('cloud-session')

    expect(store.getState()).toMatchObject({
      handle: {
        environmentId: 'cloud:workspace-7',
        cwd: '/workspace/repo',
      },
      cwd: '/workspace/repo',
      label: 'Project Seven',
      profile: 'cloud',
    })
    expect(store.getState().recentHandles[0]).toMatchObject({
      environmentId: 'cloud:workspace-7',
      profile: 'cloud',
    })
  })
})
