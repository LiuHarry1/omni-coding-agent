/** How many past sessions the home page lists. */
export const HOME_RECENT_LIMIT = 4

/**
 * The home page shows for a chat with nothing said in it that something can
 * be said in: not one still being read, and not someone else's.
 */
export function isHome(state) {
  return (
    !state.sessionLoading &&
    !state.sessionReadOnly &&
    state.bubbleOrder.length === 0
  )
}

/**
 * The sessions worth going back to, in the order the list has them (newest
 * first): ones with something in them, other than the one that is open.
 */
export function recentSessions(
  sessions,
  { currentSessionId = null, limit = HOME_RECENT_LIMIT } = {},
) {
  return (sessions ?? [])
    .filter(s => s.id !== currentSessionId && s.messageCount > 0)
    .slice(0, limit)
}
