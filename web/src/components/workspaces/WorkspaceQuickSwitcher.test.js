import React, { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  selectCloud: vi.fn(() => true),
  loadCloud: vi.fn(async () => true),
  refreshCloud: vi.fn(async () => undefined),
  createDialogProps: null,
  capabilities: {
    loaded: true,
    manifest: {
      profile: 'cloud',
      workspace: {
        enabled: true,
        createMethods: ['clone', 'blank'],
      },
    },
  },
  chat: {
    isStreaming: false,
    sessionLoading: false,
  },
  context: {
    handle: {
      environmentId: 'cloud:current',
      cwd: '/workspace/repo',
    },
    label: 'Current project',
    recentHandles: [],
    select: vi.fn(() => true),
  },
  cloud: {
    workspaces: [
      {
        id: 'current',
        environmentId: 'cloud:current',
        cwd: '/workspace/repo',
        name: 'Current project',
        status: 'ready',
        source: { kind: 'empty' },
      },
      {
        id: 'recent',
        environmentId: 'cloud:recent',
        cwd: '/workspace/repo',
        name: 'Recent project',
        status: 'ready',
        source: {
          kind: 'git',
          url: 'https://github.com/acme/recent.git',
        },
      },
    ],
    currentId: 'current',
    pendingId: null,
    limit: 5,
    loaded: true,
    enabled: true,
  },
}))

vi.mock('../../lib/auth.js', () => ({
  authEnabled: () => true,
  getUser: () => ({ username: 'member' }),
  isSuperUser: () => false,
  remoteEnabled: () => true,
}))

vi.mock('../../stores/capabilities-store.js', () => ({
  useCapabilitiesStore: selector => selector(mocks.capabilities),
}))

vi.mock('../../stores/chat-store.js', () => ({
  useChatStore: selector => selector(mocks.chat),
}))

vi.mock('../../stores/workspace-context-store.js', () => ({
  useWorkspaceContextStore: selector => selector(mocks.context),
}))

vi.mock('../../stores/cloud-workspace-store.js', () => ({
  useCloudWorkspaceStore: selector =>
    selector({
      ...mocks.cloud,
      load: mocks.loadCloud,
      refresh: mocks.refreshCloud,
      select: mocks.selectCloud,
    }),
}))

vi.mock('./WorkspaceCreateDialog.jsx', () => ({
  default: props => {
    mocks.createDialogProps = props
    return null
  },
}))

import WorkspaceQuickSwitcher from './WorkspaceQuickSwitcher.jsx'

const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Event',
  'React',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
]

let previousGlobals
let root

function installDom() {
  const { window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  )
  previousGlobals = new Map(
    GLOBALS.map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  )
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    React,
    requestAnimationFrame: callback =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
}

async function mount() {
  root = createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(
      createElement(WorkspaceQuickSwitcher, {
        open: true,
        onClose: mocks.close,
        onManage: vi.fn(),
      }),
    )
  })
}

beforeEach(() => {
  installDom()
  vi.clearAllMocks()
  mocks.selectCloud.mockReturnValue(true)
  mocks.createDialogProps = null
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
  }
  for (const [name, descriptor] of previousGlobals || []) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

describe('WorkspaceQuickSwitcher', () => {
  it('lets a normal authenticated cloud user create a workspace', async () => {
    await mount()

    const createButton = [...document.querySelectorAll('button')].find(button =>
      button.textContent.includes('Clone repository'),
    )
    expect(createButton).toBeTruthy()
    expect(createButton.disabled).toBe(false)

    await act(async () => {
      createButton.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.createDialogProps).toMatchObject({
      open: true,
      initialMethodId: 'clone',
      profile: 'cloud',
    })
  })

  it('switches directly to a recent workspace and closes', async () => {
    await mount()

    const recent = [...document.querySelectorAll('.workspace-quick-row')].find(
      button => button.textContent.includes('Recent project'),
    )
    await act(async () => {
      recent.dispatchEvent(new window.Event('click', { bubbles: true }))
    })

    expect(mocks.selectCloud).toHaveBeenCalledWith('recent')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
