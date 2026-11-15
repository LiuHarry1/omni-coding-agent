import { describe, expect, it } from 'vitest'
import { HOME_RECENT_LIMIT, isHome, recentSessions } from './home.js'

describe('isHome', () => {
  const empty = {
    sessionLoading: false,
    sessionReadOnly: false,
    bubbleOrder: [],
  }

  it('is a chat with nothing said in it', () => {
    expect(isHome(empty)).toBe(true)
    expect(isHome({ ...empty, bubbleOrder: ['user:1'] })).toBe(false)
  })

  it('is not a session still being read', () => {
    // Its messages may be on their way: the page would flash and be gone.
    expect(isHome({ ...empty, sessionLoading: true })).toBe(false)
  })

  it("is not someone else's empty conversation", () => {
    // There is no composer under it to build a page around.
    expect(isHome({ ...empty, sessionReadOnly: true })).toBe(false)
  })
})

describe('recentSessions', () => {
  const session = (id, messageCount = 2) => ({
    id,
    messageCount,
    preview: `Session ${id}`,
  })
  const ids = list => list.map(s => s.id)

  it('keeps the order of the list, up to the limit', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => session(id))
    expect(ids(recentSessions(sessions))).toEqual(['a', 'b', 'c', 'd'])
    expect(recentSessions(sessions)).toHaveLength(HOME_RECENT_LIMIT)
    expect(ids(recentSessions(sessions, { limit: 2 }))).toEqual(['a', 'b'])
  })

  it('leaves out the session that is open', () => {
    // On the home page that is the empty chat being looked at.
    const sessions = [session('a'), session('b'), session('c')]
    expect(ids(recentSessions(sessions, { currentSessionId: 'b' }))).toEqual([
      'a',
      'c',
    ])
  })

  it('leaves out sessions with nothing in them', () => {
    const sessions = [session('a', 0), session('b'), { id: 'c' }, session('d')]
    expect(ids(recentSessions(sessions))).toEqual(['b', 'd'])
  })

  it('is empty before the list has loaded', () => {
    expect(recentSessions(undefined)).toEqual([])
    expect(recentSessions([])).toEqual([])
  })
})
