import React, { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi } from '../../lib/api/agent.js'
import { userConfigApi } from '../../lib/api/user-config.js'
import ConfigFileEditor from './ConfigFileEditor.jsx'
import MarkdownResourcesSection from './MarkdownResourcesSection.jsx'
import SkillsSection from './SkillsSection.jsx'
import { createConfigFile } from './resource-operations.js'
import useConfigFile from './useConfigFile.js'

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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await act(
      () =>
        new Promise(resolve => {
          setTimeout(resolve, 0)
        }),
    )
  }
  expect(predicate()).toBe(true)
}

beforeEach(() => {
  installDom()
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount()
    })
    root = null
  }
  vi.restoreAllMocks()
  restoreDom()
})

describe('extension resource detail panes', () => {
  it('renders the selected Skill detail instead of the empty state', async () => {
    vi.spyOn(userConfigApi, 'list').mockResolvedValue({
      entries: [
        {
          name: 'demo',
          path: 'skills/demo',
          type: 'directory',
          isDir: true,
        },
        {
          name: 'SKILL.md',
          path: 'skills/demo/SKILL.md',
          type: 'file',
          isDir: false,
        },
      ],
    })
    vi.spyOn(userConfigApi, 'read').mockResolvedValue({
      path: 'skills/demo/SKILL.md',
      content: '---\nname: demo\ndescription: Demo skill\n---\nRun the demo.',
      mtimeMs: 1,
    })
    vi.spyOn(agentApi, 'getSkills').mockResolvedValue({
      skills: [
        {
          name: 'demo',
          displayName: 'Demo Skill',
          active: true,
          source: 'user',
        },
      ],
    })

    await mount(createElement(SkillsSection, { workspace: '/workspace/repo' }))
    await waitFor(() => document.body.textContent.includes('Save overview'))

    expect(document.body.textContent).toContain('Demo Skill')
    expect(document.body.textContent).not.toContain('Select a skill')
  })

  it('renders Markdown resources through an injected config client', async () => {
    vi.spyOn(agentApi, 'getAgents').mockResolvedValue({
      all: [],
      errors: [],
    })
    const configClient = {
      list: vi.fn().mockResolvedValue({
        entries: [
          {
            name: 'reviewer.md',
            path: 'agents/reviewer.md',
            type: 'file',
            isDir: false,
          },
        ],
      }),
      read: vi.fn().mockResolvedValue({
        path: 'agents/reviewer.md',
        content:
          '---\nlabel: Reviewer\ndescription: Reviews changes\nmode: subagent\n---\nReview carefully.',
        mtimeMs: 1,
      }),
    }

    await mount(
      createElement(MarkdownResourcesSection, {
        type: 'agents',
        scope: 'workspace',
        configClient,
      }),
    )
    await waitFor(() =>
      document.body.textContent.includes('Markdown instructions'),
    )

    expect(document.body.textContent).toContain('reviewer')
    expect(document.body.textContent).toContain('Workspace')
    expect(document.body.textContent).not.toContain('Select a agent')
    expect(configClient.list).toHaveBeenCalledWith('agents', {
      recursive: true,
    })
    expect(configClient.read).toHaveBeenCalledWith('agents/reviewer.md')
  })

  it('shows discovered built-in/plugin resources and load warnings read-only', async () => {
    vi.spyOn(agentApi, 'getSlashCommands').mockResolvedValue({
      entries: [
        {
          name: 'help',
          description: 'Built-in help',
          kind: 'built-in',
          source: 'built-in',
        },
        {
          name: 'release',
          description: 'Plugin release flow',
          kind: 'command',
          source: 'plugin',
          filePath: '/plugins/release.md',
        },
      ],
      errors: [{ source: 'broken-plugin', message: 'Invalid manifest' }],
    })
    const configClient = {
      list: vi.fn().mockResolvedValue({ entries: [] }),
    }

    await mount(
      createElement(MarkdownResourcesSection, {
        type: 'commands',
        configClient,
      }),
    )
    await waitFor(() => document.body.textContent.includes('Invalid manifest'))

    expect(document.body.textContent).toContain('help')
    expect(document.body.textContent).toContain('release')
    expect(document.body.textContent).toContain('Built-in')
    expect(document.body.textContent).toContain('read-only')
    expect(document.body.textContent).not.toContain('Export')
    expect(configClient.read).toBeUndefined()
  })

  it('keeps a trailing comma while editing rule path patterns', async () => {
    const configClient = {
      list: vi.fn().mockResolvedValue({
        entries: [
          {
            name: 'frontend.md',
            path: 'rules/frontend.md',
            type: 'file',
          },
        ],
      }),
      read: vi.fn().mockResolvedValue({
        path: 'rules/frontend.md',
        content: '---\npaths:\n  - src/**\n---\nUse frontend conventions.',
        mtimeMs: 1,
      }),
    }

    await mount(
      createElement(MarkdownResourcesSection, {
        type: 'rules',
        configClient,
      }),
    )
    await waitFor(() =>
      document.body.textContent.includes('Markdown instructions'),
    )
    const input = [...document.querySelectorAll('input')].find(
      element => element.value === 'src/**',
    )
    input.value = 'src/**,'
    await act(async () => {
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })

    expect(input.value).toBe('src/**,')
  })
})

describe('config file editor write protection', () => {
  it('keeps newer typing when an older save finishes', async () => {
    let resolveSave
    const configClient = {
      read: vi.fn().mockResolvedValue({
        path: 'skills/demo/notes.md',
        content: 'original',
        mtimeMs: 1,
      }),
      save: vi.fn(
        () =>
          new Promise(resolve => {
            resolveSave = resolve
          }),
      ),
      downloadPath: vi.fn(),
    }

    function SaveRaceProbe() {
      const editor = useConfigFile('skills/demo/notes.md', {
        client: configClient,
      })
      return createElement(
        'div',
        null,
        createElement(
          'button',
          { onClick: () => editor.setContent('first draft') },
          'First draft',
        ),
        createElement('button', { onClick: () => void editor.save() }, 'Save'),
        createElement(
          'button',
          { onClick: () => editor.setContent('newer draft') },
          'Newer draft',
        ),
        createElement('output', null, editor.content),
        createElement('span', null, editor.dirty ? 'Unsaved changes' : 'Saved'),
      )
    }

    await mount(createElement(SaveRaceProbe))
    await waitFor(
      () =>
        configClient.read.mock.calls.length === 1 &&
        document.querySelector('output')?.textContent === 'original',
    )
    const button = label =>
      [...document.querySelectorAll('button')].find(
        item => item.textContent.trim() === label,
      )
    await act(async () => {
      button('First draft').dispatchEvent(
        new window.Event('click', { bubbles: true }),
      )
    })
    await act(async () => {
      button('Save').dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    await waitFor(() => typeof resolveSave === 'function')
    await act(async () => {
      button('Newer draft').dispatchEvent(
        new window.Event('click', { bubbles: true }),
      )
    })
    await act(async () => {
      resolveSave({
        path: 'skills/demo/notes.md',
        content: 'first draft',
        mtimeMs: 2,
      })
    })

    expect(configClient.save).toHaveBeenCalledWith(
      'skills/demo/notes.md',
      'first draft',
      1,
    )
    expect(document.querySelector('output').textContent).toBe('newer draft')
    expect(document.body.textContent).toContain('Unsaved changes')
  })

  it.each([
    ['binary', { isBinary: true }, 'Binary files cannot be edited as text.'],
    [
      'truncated',
      { truncated: true },
      'This preview is truncated; saving it would overwrite the complete file.',
    ],
  ])('blocks saving a %s response', async (_kind, flags, warning) => {
    const configClient = {
      read: vi.fn().mockResolvedValue({
        path: 'skills/demo/notes.md',
        content: 'preview',
        mtimeMs: 1,
        ...flags,
      }),
      save: vi.fn(),
      downloadPath: vi.fn(),
    }

    await mount(
      createElement(ConfigFileEditor, {
        path: 'skills/demo/notes.md',
        configClient,
      }),
    )
    await waitFor(() => document.body.textContent.includes(warning))

    expect(
      [...document.querySelectorAll('button')].some(
        button => button.textContent.trim() === 'Save',
      ),
    ).toBe(false)
    expect(configClient.save).not.toHaveBeenCalled()
  })
})

describe('resource creation', () => {
  it('creates nested skill file parents before the file', async () => {
    const api = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    }

    await createConfigFile(api, 'skills/demo/scripts/check.sh')

    expect(api.mkdir).toHaveBeenCalledWith('skills/demo/scripts')
    expect(api.create).toHaveBeenCalledWith('skills/demo/scripts/check.sh', '')
    expect(api.mkdir.mock.invocationCallOrder[0]).toBeLessThan(
      api.create.mock.invocationCallOrder[0],
    )
  })

  it.each(['agents', 'rules', 'commands'])(
    'creates the %s root before a fresh-user resource',
    async type => {
      const api = {
        mkdir: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue(undefined),
      }

      await createConfigFile(api, `${type}/example.md`, '# Example')

      expect(api.mkdir).toHaveBeenCalledWith(type)
      expect(api.create).toHaveBeenCalledWith(`${type}/example.md`, '# Example')
      expect(api.mkdir.mock.invocationCallOrder[0]).toBeLessThan(
        api.create.mock.invocationCallOrder[0],
      )
    },
  )
})
