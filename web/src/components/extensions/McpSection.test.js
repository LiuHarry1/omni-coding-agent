import React, { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentApi } from '../../lib/api/agent.js'
import McpSection from './McpSection.jsx'

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

// linkedom input events do not reach React's change tracking.
async function typeInto(input, value) {
  const propsKey = Object.keys(input).find(key =>
    key.startsWith('__reactProps'),
  )
  await act(async () => {
    input[propsKey].onChange({ target: { value } })
  })
}

function buttonByText(text) {
  return [...document.querySelectorAll('button')].find(
    button => button.textContent.trim() === text,
  )
}

const MCP_RESPONSE = {
  configs: {
    'tdc-docs': {
      transport: 'http',
      url: 'https://ai.example.test/help/mcp',
      headerNames: ['Authorization'],
      configuredBy: 'user',
      writable: true,
      writableScope: 'user',
    },
  },
  mcpStatus: [{ name: 'tdc-docs', status: 'connected', tools: ['search'] }],
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

describe('McpSection editing', () => {
  it('replaces a header value without resending the masked URL', async () => {
    vi.spyOn(agentApi, 'getMcp').mockResolvedValue(MCP_RESPONSE)
    const updateMcp = vi
      .spyOn(agentApi, 'updateMcp')
      .mockResolvedValue(MCP_RESPONSE)

    root = createRoot(document.getElementById('root'))
    await act(async () => {
      root.render(createElement(McpSection, { workspace: null }))
    })
    await waitFor(() => Boolean(buttonByText('Edit')))

    await act(async () => buttonByText('Edit').click())
    const nameInput = document.querySelector('.extensions-field input')
    expect(nameInput.value).toBe('tdc-docs')
    expect(nameInput.disabled).toBe(true)
    const valueInput = document.querySelector(
      'input[aria-label="Header 1 value"]',
    )
    expect(valueInput.getAttribute('placeholder')).toBe('Unchanged')

    await typeInto(valueInput, 'Bearer new-token')
    expect(buttonByText('Test & save').disabled).toBe(false)
    await act(async () => {
      document
        .querySelector('form.extensions-form')
        .dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        )
    })

    expect(updateMcp).toHaveBeenCalledWith(
      'tdc-docs',
      {
        transport: 'http',
        headers: { Authorization: 'Bearer new-token' },
      },
      'user',
    )
  })
})
