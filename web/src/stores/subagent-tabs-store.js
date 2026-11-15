import { create } from 'zustand'

/**
 * The subagent conversations open as tabs beside the chat, and which one
 * is showing in its place — none while the chat itself is.
 *
 * A tab finds its call in the chat transcript by `toolCallId` (for its
 * live state) and its saved transcript by `sessionId` + `agentId`.
 *
 * @typedef {{
 *   key: string,
 *   sessionId: string,
 *   toolCallId: string,
 *   agentId: string | null,
 *   title: string,
 * }} SubagentTab
 */

/** One tab per call: opening the same card again shows the same tab. */
export function subagentTabKey(target) {
  return `${target.sessionId}:${target.toolCallId}`
}

export const useSubagentTabsStore = create(set => ({
  /** @type {SubagentTab[]} */
  tabs: [],
  /** @type {string | null} */
  activeKey: null,

  /** Show the call's conversation, in its tab if it has one already. */
  open: target =>
    set(s => {
      const key = subagentTabKey(target)
      const tab = { ...target, key }
      const at = s.tabs.findIndex(t => t.key === key)
      const tabs =
        at < 0 ? [...s.tabs, tab] : s.tabs.map((t, i) => (i === at ? tab : t))
      return { tabs, activeKey: key }
    }),

  /** Show a tab that is open; anything else shows the chat. */
  activate: key =>
    set(s => {
      const next = s.tabs.some(t => t.key === key) ? key : null
      return next === s.activeKey ? s : { activeKey: next }
    }),

  showChat: () => set(s => (s.activeKey === null ? s : { activeKey: null })),

  /** Closing the tab that is showing goes back to the chat. */
  close: key =>
    set(s => {
      if (!s.tabs.some(t => t.key === key)) return s
      return {
        tabs: s.tabs.filter(t => t.key !== key),
        activeKey: s.activeKey === key ? null : s.activeKey,
      }
    }),

  closeAll: () =>
    set(s => (s.tabs.length === 0 ? s : { tabs: [], activeKey: null })),
}))
