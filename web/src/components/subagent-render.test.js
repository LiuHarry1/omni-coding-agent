import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The web build has one React (the Vite React plugin dedupes it). Here the
// packages hoisted to the repo root — zustand, react-markdown — would load
// the root's older React next to the web's, and their hooks and elements
// would not be this renderer's. So: stores bound to this React, and
// markdown as the text it was given.
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
vi.mock('react-markdown', async () => {
  const { createElement } = await import('react')
  return { default: ({ children }) => createElement('div', null, children) }
})

// Without the Vite React plugin, JSX compiles to React.createElement calls.
globalThis.React = React
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

const { default: SubagentCard } = await import('./SubagentCard.jsx')
const { default: SubagentTabsStage } = await import('./SubagentTabs.jsx')
const { ChatActionsProvider } = await import('../lib/chat-actions.jsx')
const { useChatStore } = await import('../stores/chat-store.js')
const { useSubagentTabsStore, subagentTabKey } =
  await import('../stores/subagent-tabs-store.js')
const { toolBubbleId } = await import('../lib/bubbles/messages-to-bubbles.js')

/**
 * The markup of the first render, without a browser: enough to see what a
 * card says and offers, and what a subagent's tab shows.
 */
const card = part =>
  renderToStaticMarkup(
    createElement(
      ChatActionsProvider,
      null,
      createElement(SubagentCard, { part }),
    ),
  )

const agentCall = extra => ({
  type: 'tool_call',
  toolCallId: 'agent-1',
  name: 'Agent',
  isSubagent: true,
  args: {
    subagent_type: 'Explore',
    description: 'Audit the routes',
    prompt: 'List every HTTP route.',
  },
  ...extra,
})

const read = (id, status) => ({
  type: 'tool_call',
  toolCallId: id,
  name: 'Read',
  args: { file_path: `src/${id}.ts` },
  status,
  ...(status === 'done' ? { result: 'source' } : {}),
})

const RESUME =
  '\n\nagentId: a1b2c3d4e (use SendMessage with this id to continue this agent with its full context)'

const target = extra => ({
  sessionId: 'session-1',
  toolCallId: 'agent-1',
  agentId: null,
  title: 'Audit the routes',
  ...extra,
})

afterEach(() => {
  useSubagentTabsStore.getState().closeAll()
  useChatStore.setState({
    currentSessionId: null,
    sessions: [],
    bubbleOrder: [],
    bubblesById: {},
  })
})

describe('SubagentCard', () => {
  it('shows a running agent: title, type, and the step it is on', () => {
    const html = card(
      agentCall({
        status: 'running',
        agentId: 'a1b2c3d4e',
        subagentParts: [
          { type: 'text', id: 'text:0', content: 'Looking at the router.' },
          read('router', 'done'),
          read('handlers', 'running'),
        ],
      }),
    )

    expect(html).toContain('data-subagent-status="running"')
    // Working: the dot grid, not a dot.
    expect(html).toContain('data-subagent-task-status="running"')
    expect(html).toContain('subagent-dot-grid')
    expect(html).not.toContain('subagent-card__dot ')
    expect(html).toContain('>Audit the routes<')
    expect(html).toContain('>Explorer<')
    // The step in flight, not a verdict.
    expect(html).toContain(
      '<span class="text-roll__item shimmer-text">Reading src/handlers.ts</span>',
    )
    // The card is the way in; Stop is the one thing offered on it.
    expect(html).toContain('role="button"')
    // It opens a tab; it does not unfold.
    expect(html).not.toContain('aria-expanded')
    expect(html).toContain('data-subagent-task-actions="overlay"')
    expect(html).toMatch(/data-subagent-task-action="stop"[^>]*>Stop</)
    expect(html).not.toContain('>Open<')
    // Its conversation is not in the transcript; its tab shows it.
    expect(html).not.toContain('Looking at the router.')
    expect(html).not.toContain('src/router.ts')
  })

  it.each([
    [
      'completed',
      { result: `Found 12 routes.${RESUME}` },
      { status: 'Completed', indicator: 'finished', opens: true },
    ],
    [
      'stopped',
      {
        result: 'Error: Subagent stopped by user.',
        toolUseResult: { text: '', status: 'stopped', agentId: 'a1b2c3d4e' },
      },
      { status: 'Stopped', indicator: 'finished', opens: true, dimmed: true },
    ],
    [
      'error',
      { result: 'Error: model unavailable' },
      // Failed before it was named: nothing saved to show.
      { status: 'Stopped with error', indicator: 'error', opens: false },
    ],
    [
      'background',
      {
        result: 'Async agent launched successfully.',
        toolUseResult: { text: '', status: 'background', agentId: 'abg000001' },
      },
      {
        status: 'Started in the background',
        indicator: 'finished',
        opens: true,
      },
    ],
  ])('shows how a %s call ended', (outcome, extra, expected) => {
    const html = card(agentCall({ status: 'done', ...extra }))

    expect(html).toContain(`data-subagent-status="${outcome}"`)
    expect(html).toContain(`data-subagent-task-status="${expected.indicator}"`)
    expect(html).toContain(
      `subagent-card__dot--${expected.indicator === 'error' ? 'error' : 'done'}`,
    )
    expect(html).not.toContain('subagent-dot-grid')
    // Said plainly: no shimmer once it is over.
    expect(html).toContain(
      `<span class="text-roll__item">${expected.status}</span>`,
    )
    expect(html.includes('role="button"')).toBe(expected.opens)
    // Only a stop by the user is dimmed.
    expect(html.includes('subagent-card__indicator--dimmed')).toBe(
      expected.dimmed === true,
    )
    expect(html).not.toContain('data-subagent-task-action')
  })

  it('falls back to a title when the call has none', () => {
    const html = card({
      type: 'tool_call',
      toolCallId: 'agent-2',
      name: 'Agent',
      isSubagent: true,
      status: 'running',
      args: {},
    })
    expect(html).toContain('>New subagent<')
    expect(html).toContain(
      '<span class="text-roll__item shimmer-text">Planning next moves</span>',
    )
    // No type known yet: none is made up.
    expect(html).not.toContain('data-subagent-task-model')
  })
})

describe('subagent tabs', () => {
  const CHAT = '<p>the chat</p>'
  const BARE = `<div class="chat-stage"><div class="chat-stage__body">${CHAT}</div></div>`
  const stage = () =>
    renderToStaticMarkup(
      createElement(
        ChatActionsProvider,
        null,
        createElement(
          SubagentTabsStage,
          null,
          createElement('p', null, 'the chat'),
        ),
      ),
    )
  const open = extra => useSubagentTabsStore.getState().open(target(extra))
  const chatHas = bubble =>
    useChatStore.setState({
      currentSessionId: 'session-1',
      sessions: [{ id: 'session-1', preview: 'Routes audit' }],
      ...(bubble
        ? { bubbleOrder: [bubble.id], bubblesById: { [bubble.id]: bubble } }
        : {}),
    })
  const agentBubble = extra => ({
    id: toolBubbleId('agent-1'),
    kind: 'tool',
    toolCallId: 'agent-1',
    name: 'Agent',
    isSubagent: true,
    args: { subagent_type: 'Explore', prompt: 'List every HTTP route.' },
    ...extra,
  })
  /** Whether the tab titled `title` is the one showing. */
  const selected = (html, title) =>
    new RegExp(`role="tab"[^>]*aria-selected="true"[^>]*title="${title}"`).test(
      html,
    )

  it('leaves the chat alone until a subagent is opened', () => {
    chatHas()
    expect(stage()).toBe(BARE)
  })

  /** The page's section titles, in order. */
  const sections = html =>
    [...html.matchAll(/subagent-section__label">([^<]+)</g)].map(m => m[1])
  /** The facts under the title, in order (icons left out). */
  const facts = html =>
    [...html.matchAll(/<li[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/li>/g)].map(
      m => m[1],
    )

  it('opens a running agent in a tab beside the chat, from what has streamed in', () => {
    chatHas(
      agentBubble({
        status: 'running',
        startTime: Date.now() - 4_200,
        subagentParts: [
          { type: 'text', id: 'text:0', content: 'Looking at the router.' },
          read('router', 'running'),
        ],
      }),
    )
    open()

    const html = stage()
    // Two tabs: the chat's own, and the agent's, which is showing.
    expect(html).toContain('role="tablist"')
    expect(selected(html, 'Audit the routes')).toBe(true)
    expect(selected(html, 'Routes audit')).toBe(false)
    expect(html).toContain('aria-label="Close Audit the routes"')
    expect(html).toContain('data-subagent-tab-active="true"')
    // The chat stays mounted behind it.
    expect(html).toContain(CHAT)
    expect(html).toContain('role="tabpanel"')
    // Header: which agent, that it is working, and for how long.
    expect(html).toMatch(/subagent-page__title"[^>]*>Audit the routes</)
    expect(html).toMatch(/data-subagent-page-status="running".*?Running</)
    expect(facts(html)).toEqual([
      'Explorer',
      '5s',
      '1 step',
      'Started just now',
    ])
    // It can be stopped from here.
    expect(html).toMatch(/subagent-btn--danger"[^>]*>.*?Stop</)
    // The task, then its activity in the open, still going.
    expect(sections(html)).toEqual(['Task', 'Activity'])
    const order = [
      html.indexOf('subagent-task__text">List every HTTP route.'),
      html.indexOf('Looking at the router.'),
      html.lastIndexOf('src/router.ts'),
      html.indexOf('>Working…<'),
    ]
    expect(order.every(i => i > 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toMatch(/<ol class="subagent-activity">/)
    expect(html).not.toContain('Copy result')
    // Read-only.
    expect(html).not.toContain('msg-user')
  })

  it('shows a finished agent as its task, its activity folded, and its result', () => {
    const now = Date.now()
    chatHas(
      agentBubble({
        status: 'done',
        startTime: now - 10_500,
        endTime: now,
        result: `Found 12 routes.${RESUME}`,
        subagentParts: [read('router', 'done'), read('handlers', 'done')],
      }),
    )
    open({ agentId: 'a1b2c3d4e' })

    const html = stage()
    // What the chat holds of it stands in until its transcript is read.
    expect(html).not.toContain('Loading conversation')
    expect(html).toMatch(/data-subagent-page-status="completed".*?Completed</)
    expect(html).not.toContain('subagent-btn--danger')
    expect(facts(html)).toEqual([
      'Explorer',
      '11s',
      '2 steps',
      'Finished just now',
    ])
    expect(sections(html)).toEqual(['Task', 'Activity', 'Result'])
    // Its steps are there, folded away, counted on the fold.
    expect(html).toContain(
      '<span class="subagent-section__count">2 steps</span>',
    )
    expect(html).toMatch(/<ol class="subagent-activity" hidden="">/)
    expect(html).not.toContain('>Working…<')
    // The answer, without the line addressed to the model, and a way to copy it.
    expect(html).toMatch(/subagent-result-card">.*?Found 12 routes\./)
    expect(html).not.toContain('use SendMessage with this id')
    expect(html).toContain('aria-label="Copy result"')
  })

  it('shows why a failed agent failed', () => {
    chatHas(
      agentBubble({
        status: 'done',
        result: 'Error: model unavailable',
        toolUseResult: { text: '', status: 'error', agentId: 'a1b2c3d4e' },
        subagentParts: [read('router', 'done')],
      }),
    )
    open({ agentId: 'a1b2c3d4e' })

    const html = stage()
    expect(html).toMatch(/data-subagent-page-status="error".*?Failed</)
    expect(sections(html)).toEqual(['Task', 'Activity', 'Error'])
    expect(html).toMatch(
      /subagent-error" role="alert">Error: model unavailable</,
    )
    expect(html).not.toContain('Copy result')
  })

  it('says a stopped agent gave no result, and leaves its steps in the open', () => {
    chatHas(
      agentBubble({
        status: 'done',
        result: 'Error: Subagent stopped by user.',
        toolUseResult: { text: '', status: 'stopped', agentId: 'a1b2c3d4e' },
        subagentParts: [read('router', 'done')],
      }),
    )
    open({ agentId: 'a1b2c3d4e' })

    const html = stage()
    expect(html).toMatch(/data-subagent-page-status="stopped".*?Stopped</)
    expect(sections(html)).toEqual(['Task', 'Activity'])
    expect(html).toMatch(/<ol class="subagent-activity">/)
    expect(html).toContain('Stopped before it gave a result.')
  })

  it('says it is loading when the chat holds nothing of the call', () => {
    chatHas()
    open({ agentId: 'a1b2c3d4e' })

    const html = stage()
    // The header is there from the start; the rest is on its way.
    expect(html).toMatch(/subagent-page__title"[^>]*>Audit the routes</)
    expect(html).toContain('Loading conversation…')
    expect(sections(html)).toEqual([])
  })

  it('says so when there is no conversation to load', () => {
    chatHas()
    open()

    expect(stage()).toContain('This conversation could not be loaded')
  })

  it('marks each agent tab with how its agent stands', () => {
    chatHas(agentBubble({ status: 'running' }))
    open()
    expect(stage()).toMatch(
      /subagent-tabs__mark">.*?data-subagent-task-status="running"/,
    )

    chatHas(agentBubble({ status: 'done', result: 'Error: model unavailable' }))
    expect(stage()).toMatch(
      /subagent-tabs__mark">.*?data-subagent-task-status="error"/,
    )
  })

  it("keeps the agent's tab while the chat's own is showing", () => {
    chatHas(agentBubble({ status: 'done', result: 'Found 12 routes.' }))
    open({ agentId: 'a1b2c3d4e' })
    useSubagentTabsStore.getState().showChat()

    const html = stage()
    expect(selected(html, 'Routes audit')).toBe(true)
    expect(selected(html, 'Audit the routes')).toBe(false)
    expect(html).toContain('aria-label="Close Audit the routes"')
    expect(html).not.toContain('data-subagent-tab-active')
    expect(html).not.toContain('role="tabpanel"')
  })

  it('closes with the conversation it was opened from', () => {
    chatHas(agentBubble({ status: 'done' }))
    open()
    useChatStore.setState({ currentSessionId: 'session-2' })

    expect(stage()).toBe(BARE)
  })
})

describe('opening a subagent', () => {
  const store = () => useSubagentTabsStore.getState()
  const key = extra => subagentTabKey(target(extra))

  it('adds a tab for it and shows it', () => {
    store().open(target())
    expect(store().tabs).toEqual([{ ...target(), key: key() }])
    expect(store().activeKey).toBe(key())
  })

  it('shows the tab a call already has, with what is now known of it', () => {
    store().open(target())
    store().open(target({ toolCallId: 'agent-2', title: 'Other' }))
    store().open(target({ agentId: 'a1b2c3d4e' }))

    expect(store().tabs.map(t => t.toolCallId)).toEqual(['agent-1', 'agent-2'])
    expect(store().tabs[0].agentId).toBe('a1b2c3d4e')
    expect(store().activeKey).toBe(key())
  })

  it('goes back to the chat, and to a tab that is still open', () => {
    store().open(target())
    store().showChat()
    expect(store().activeKey).toBeNull()
    expect(store().tabs).toHaveLength(1)

    store().activate(key())
    expect(store().activeKey).toBe(key())
    // A tab that is not open shows the chat.
    store().activate('session-1:gone')
    expect(store().activeKey).toBeNull()
  })

  it('closing the tab that is showing goes back to the chat', () => {
    const other = { toolCallId: 'agent-2', title: 'Other' }
    store().open(target())
    store().open(target(other))

    // Closing another tab leaves the one showing alone.
    store().close(key())
    expect(store().tabs.map(t => t.toolCallId)).toEqual(['agent-2'])
    expect(store().activeKey).toBe(key(other))

    store().close(key(other))
    expect(store().tabs).toEqual([])
    expect(store().activeKey).toBeNull()
  })

  it('has nothing to close when nothing is open', () => {
    const before = store()
    store().close(key())
    store().closeAll()
    store().showChat()
    expect(store()).toBe(before)
  })
})
