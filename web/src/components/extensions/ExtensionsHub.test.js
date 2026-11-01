import React, { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAFE_DESKTOP_CAPABILITIES } from '../../stores/capabilities-model.js'
import ExtensionsHub from './ExtensionsHub.jsx'
import MarketplaceSection from './MarketplaceSection.jsx'

vi.mock('../../stores/capabilities-store.js', () => ({
  useCapabilitiesStore: selector => selector({ loaded: false, manifest: null }),
}))

vi.mock('../../stores/workspace-context-store.js', () => ({
  useWorkspaceContextStore: selector =>
    selector({ handle: null, label: null, cwd: '' }),
}))

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

function restoreDom() {
  for (const [name, descriptor] of previousGlobals || []) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}

async function mount(element) {
  root = createRoot(document.getElementById('root'))
  await act(async () => {
    root.render(element)
  })
}

beforeEach(installDom)

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = null
  }
  vi.restoreAllMocks()
  restoreDom()
})

describe('ExtensionsHub capability wiring', () => {
  it('renders the manifest profile and only enabled sections', async () => {
    const manifest = structuredClone(SAFE_DESKTOP_CAPABILITIES)
    manifest.extensions.sections.rules = {
      enabled: false,
      reason: 'Rules are disabled by policy.',
    }
    const sections = [
      {
        id: 'skills',
        label: 'Skills',
        component: () => createElement('div', null, 'Skills content'),
      },
      {
        id: 'rules',
        label: 'Rules',
        component: () => createElement('div', null, 'Rules content'),
      },
    ]

    await mount(
      createElement(ExtensionsHub, {
        open: true,
        onClose: vi.fn(),
        manifest,
        capabilitiesLoaded: true,
        workspaceContext: {
          handle: { environmentId: 'local', cwd: '/project' },
          label: 'Project',
        },
        sections,
      }),
    )

    expect(document.body.textContent).toContain(
      'Configure reusable AI tools for Project',
    )
    expect(document.body.textContent).toContain('Desktop')
    expect(document.body.textContent).toContain('Skills')
    expect(document.body.textContent).not.toContain('Rules content')
    expect(document.getElementById('extensions-tab-rules')).toBeNull()
    expect(
      document.querySelector('.extensions-runtime-pill').getAttribute('title'),
    ).toContain('Rules are disabled by policy.')
  })

  it('injects a workspace-targeted client when scope changes', async () => {
    const manifest = structuredClone(SAFE_DESKTOP_CAPABILITIES)
    const handle = { environmentId: 'ssh:build', cwd: '/srv/project' }
    const factory = vi.fn(target => ({ target }))
    const Probe = ({ configClient }) =>
      createElement(
        'output',
        null,
        `${configClient.target.scope}:${configClient.target.workspace?.cwd || ''}`,
      )

    await mount(
      createElement(ExtensionsHub, {
        open: true,
        onClose: vi.fn(),
        manifest,
        capabilitiesLoaded: true,
        workspaceContext: { handle, label: 'Build project' },
        configClientFactory: factory,
        sections: [{ id: 'skills', label: 'Skills', component: Probe }],
      }),
    )

    const workspaceButton = [...document.querySelectorAll('button')].find(
      button => button.textContent.trim() === 'Workspace',
    )
    await act(async () => {
      workspaceButton.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      )
    })

    expect(factory).toHaveBeenLastCalledWith({
      scope: 'workspace',
      workspace: handle,
    })
    expect(document.querySelector('output').textContent).toBe(
      'workspace:/srv/project',
    )
  })

  it('shows why an SSH Marketplace Workspace target is disabled', async () => {
    const manifest = structuredClone(SAFE_DESKTOP_CAPABILITIES)

    await mount(
      createElement(MarketplaceSection, {
        scope: 'workspace',
        workspaceHandle: {
          environmentId: 'ssh:build',
          cwd: '/srv/project',
        },
        capability: manifest.marketplace,
      }),
    )

    expect(document.body.textContent).toContain(
      'Workspace Marketplace target unavailable',
    )
    expect(document.body.textContent).toMatch(
      /SSH.*atomic install.*rollback.*ownership/i,
    )
    expect(document.querySelector('.ws-marketplace')).toBeNull()
  })

  it('guards close, Escape, scope, and section changes while dirty', async () => {
    const manifest = structuredClone(SAFE_DESKTOP_CAPABILITIES)
    const onClose = vi.fn()
    const confirm = vi.fn(() => false)
    window.confirm = confirm
    const DirtyProbe = ({ onDirtyChange }) => {
      React.useEffect(() => {
        onDirtyChange(true)
      }, [onDirtyChange])
      return createElement('div', null, 'Dirty content')
    }

    await mount(
      createElement(ExtensionsHub, {
        open: true,
        onClose,
        manifest,
        capabilitiesLoaded: true,
        workspaceContext: {
          handle: { environmentId: 'local', cwd: '/project' },
          label: 'Project',
        },
        sections: [
          { id: 'skills', label: 'Skills', component: DirtyProbe },
          {
            id: 'rules',
            label: 'Rules',
            component: () => createElement('div', null, 'Rules content'),
          },
        ],
      }),
    )

    const rules = document.getElementById('extensions-tab-rules')
    const workspace = [...document.querySelectorAll('button')].find(
      button => button.textContent.trim() === 'Workspace',
    )
    const close = document.querySelector('[aria-label="Close"]')

    await act(async () => {
      rules.dispatchEvent(new window.Event('click', { bubbles: true }))
      workspace.dispatchEvent(new window.Event('click', { bubbles: true }))
      close.dispatchEvent(new window.Event('click', { bubbles: true }))
      const escape = new window.Event('keydown', { bubbles: true })
      Object.defineProperty(escape, 'key', { value: 'Escape' })
      document.dispatchEvent(escape)
    })

    expect(document.body.textContent).toContain('Dirty content')
    expect(workspace.getAttribute('aria-pressed')).toBe('false')
    expect(onClose).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(4)

    confirm.mockReturnValue(true)
    await act(async () => {
      rules.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('Rules content')
  })
})
