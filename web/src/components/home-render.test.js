import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// See subagent-render.test.js: stores bound to the web's React, not the
// older one hoisted to the repo root.
vi.mock('zustand', async () => {
  const { createStore } = await import('zustand/vanilla')
  const { useSyncExternalStore } = await import('react')
  return {
    create: init => {
      const api = createStore(init)
      const useStore = (selector = s => s) => {
        const snapshot = () => selector(api.getState())
        return useSyncExternalStore(api.subscribe, snapshot, snapshot)
      }
      return Object.assign(useStore, api)
    },
  }
})

// Without the Vite React plugin, JSX compiles to React.createElement calls.
globalThis.React = React
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { default: WelcomeScreen, HomeStart } =
  await import('./WelcomeScreen.jsx')
const { useChatStore } = await import('../stores/chat-store.js')
const { useSessionSwitcherStore } =
  await import('../stores/session-switcher-store.js')

const initial = useChatStore.getState()
afterEach(() => {
  useChatStore.setState(initial, true)
  useSessionSwitcherStore.setState({ open: false })
})

const hero = () => renderToStaticMarkup(createElement(WelcomeScreen))
const start = () => renderToStaticMarkup(createElement(HomeStart))

const session = (id, extra) => ({
  id,
  preview: `Session ${id}`,
  messageCount: 4,
  createdAt: Date.now() - 5 * 60_000,
  ...extra,
})

/** The text of each element with this class, in order. */
const texts = (html, cls) =>
  [...html.matchAll(new RegExp(`class="${cls}"[^>]*>([^<]*)<`, 'g'))].map(
    m => m[1],
  )

describe('the home page, above the composer', () => {
  it('says what the box below is for', () => {
    const html = hero()
    expect(html).toMatch(/<h1 class="home-hero__title">[^<]+<\/h1>/)
    expect(html).toContain('home-hero__sub')
    expect(html).toContain('baize-logo--md')
  })

  it("only says so in someone else's empty conversation", () => {
    useChatStore.setState({ sessionReadOnly: true })

    const html = hero()
    expect(html).toContain('Nothing in this conversation yet.')
    // Nothing that invites typing: there is no composer under it.
    expect(html).not.toContain('home-hero__title')
  })
})

describe('the home page, below the composer', () => {
  it('lists the sessions to go back to', () => {
    useChatStore.setState({
      currentSessionId: 'open',
      sessions: [
        session('open', { messageCount: 0, preview: null }),
        session('a', { preview: 'Audit the routes' }),
        session('b', { preview: null }),
        session('empty', { messageCount: 0 }),
        session('c'),
        session('d'),
        session('e'),
      ],
    })

    const html = start()
    // Four of them: not the open one, not the one with nothing in it.
    expect(texts(html, 'home-recent__title')).toEqual([
      'Audit the routes',
      'New Chat',
      'Session c',
      'Session d',
    ])
    expect(texts(html, 'home-recent__meta')[0]).toBe('5m ago')
    // The rest are a click away, and it says how many there are in all.
    expect(html).toMatch(
      /class="home-section__link">View all<span class="home-section__count">7</,
    )
    // Nothing else: no canned prompts, no templates.
    expect(html.match(/<button/g)).toHaveLength(5)
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it("names the owner of a session that is someone else's", () => {
    useChatStore.setState({
      sessions: [session('a', { ownerEmail: 'lin@example.com' })],
    })

    expect(texts(start(), 'home-recent__meta')).toEqual([
      'lin@example.com · 5m ago',
    ])
  })

  it('has no session list for someone with no sessions yet', () => {
    useChatStore.setState({ sessions: [session('new', { messageCount: 0 })] })

    // The block stays, empty: the page is centred around it.
    expect(start()).toBe('<div class="home-start"></div>')
  })
})

describe('the session list', () => {
  it('is opened and closed through a store the home page shares', () => {
    const { setOpen } = useSessionSwitcherStore.getState()
    expect(useSessionSwitcherStore.getState().open).toBe(false)
    setOpen(true)
    expect(useSessionSwitcherStore.getState().open).toBe(true)
    setOpen(false)
    expect(useSessionSwitcherStore.getState().open).toBe(false)
  })
})
