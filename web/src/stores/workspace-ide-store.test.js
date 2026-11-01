import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clients: new Map(),
  createEnvironmentFsClient: vi.fn(handle => {
    const client = mocks.clients.get(handle.environmentId)
    if (!client) throw new Error(`Missing test client: ${handle.environmentId}`)
    return client
  }),
}))

vi.mock('../lib/environment-fs.js', () => ({
  createEnvironmentFsClient: mocks.createEnvironmentFsClient,
}))

const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}

const { useWorkspaceIdeStore } = await import('./workspace-ide-store.js')

function deferred() {
  let resolve
  const promise = new Promise(res => {
    resolve = res
  })
  return { promise, resolve }
}

function client(overrides = {}) {
  return {
    listDir: vi.fn(async dir => ({ dir, parent: dir, entries: [] })),
    getFile: vi.fn(async path => ({
      path,
      content: 'content',
      mtimeMs: 1,
    })),
    createFile: vi.fn(),
    saveFile: vi.fn(),
    createFolder: vi.fn(),
    removeEntry: vi.fn(),
    uploadFiles: vi.fn(),
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    downloadPath: vi.fn(),
    ...overrides,
  }
}

describe('workspace IDE environment isolation', () => {
  beforeEach(() => {
    mocks.clients.clear()
    mocks.createEnvironmentFsClient.mockClear()
    values.clear()
    useWorkspaceIdeStore.setState({
      rootPath: null,
      environmentId: 'local',
      workspaceKey: 'local\0',
      dirCache: {},
      expandedDirs: new Set(),
      openFiles: [],
      activeFile: null,
      fileContents: {},
      diffs: {},
      openDiffs: [],
      activeDiff: null,
      activeKind: null,
      pendingNew: null,
      uploadState: {},
    })
  })

  it('clears tabs, buffers, tree, and diffs when only environmentId changes', () => {
    mocks.clients.set('cloud:one', client())
    mocks.clients.set('cloud:two', client())
    const store = useWorkspaceIdeStore.getState()
    store.setRootPath('/workspace/repo', { environmentId: 'cloud:one' })
    useWorkspaceIdeStore.setState({
      dirCache: { '/workspace/repo': { entries: [{ name: 'one' }] } },
      expandedDirs: new Set(['/workspace/repo']),
      openFiles: ['/workspace/repo/one.txt'],
      activeFile: '/workspace/repo/one.txt',
      fileContents: {
        '/workspace/repo/one.txt': { content: 'one', draft: 'one' },
      },
      diffs: { 'one.txt': { newContent: 'one' } },
      openDiffs: ['one.txt'],
      activeDiff: 'one.txt',
      activeKind: 'file',
    })

    useWorkspaceIdeStore
      .getState()
      .setRootPath('/workspace/repo', { environmentId: 'cloud:two' })

    expect(useWorkspaceIdeStore.getState()).toMatchObject({
      environmentId: 'cloud:two',
      rootPath: '/workspace/repo',
      dirCache: {},
      openFiles: [],
      activeFile: null,
      fileContents: {},
      diffs: {},
      openDiffs: [],
      activeDiff: null,
      activeKind: null,
    })
  })

  it('ignores file responses from the previous environment', async () => {
    const oldRead = deferred()
    mocks.clients.set(
      'cloud:one',
      client({ getFile: vi.fn(() => oldRead.promise) }),
    )
    mocks.clients.set('cloud:two', client())
    const store = useWorkspaceIdeStore.getState()
    store.setRootPath('/workspace/repo', { environmentId: 'cloud:one' })
    const opening = useWorkspaceIdeStore
      .getState()
      .openFile('/workspace/repo/shared.txt')

    useWorkspaceIdeStore
      .getState()
      .setRootPath('/workspace/repo', { environmentId: 'cloud:two' })
    oldRead.resolve({
      path: '/workspace/repo/shared.txt',
      content: 'workspace one',
      mtimeMs: 1,
    })
    await opening

    expect(useWorkspaceIdeStore.getState().openFiles).toEqual([])
    expect(useWorkspaceIdeStore.getState().fileContents).toEqual({})
  })
})
