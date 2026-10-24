import { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { agentApi } from '../lib/api/agent.js'
import { relativeTime } from '../lib/utils.js'
import { getUser, isSuperUser } from '../lib/auth.js'

/**
 * Session switcher pill that lives in the chat header. Click
 * opens a floating dropdown with the session list, search, and "+ New".
 * Replaces the old left-side Sidebar.
 */
export default function SessionSwitcher() {
  const sessions = useChatStore(s => s.sessions)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const switchSession = useChatStore(s => s.switchSession)
  const setSessions = useChatStore(s => s.setSessions)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [viewAll, setViewAll] = useState(false)
  const wrapRef = useRef(null)
  const me = getUser()
  const superUser = isSuperUser(me)

  const refresh = async () => {
    try {
      const data = await agentApi.listSessions()
      setSessions(data.sessions || [])
      setViewAll(Boolean(data.view_all))
    } catch {}
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  const current = sessions.find(s => s.id === currentSessionId)
  const currentTitle = current?.preview || 'New Chat'

  const handleNew = async e => {
    e.stopPropagation()
    try {
      const data = await agentApi.createSession()
      switchSession(data.session_id)
      await refresh()
      setOpen(false)
    } catch {}
  }

  const handleDelete = async (id, e) => {
    e.stopPropagation()
    try {
      await agentApi.deleteSession(id)
      await refresh()
      if (currentSessionId === id) switchSession(null)
    } catch {}
  }

  const handlePick = id => {
    switchSession(id)
    setOpen(false)
  }

  const filtered = query
    ? sessions.filter(s => {
        const q = query.toLowerCase()
        return (
          (s.preview || '').toLowerCase().includes(q) ||
          (s.ownerEmail || '').toLowerCase().includes(q)
        )
      })
    : sessions

  const canDeleteSession = s =>
    !superUser || !s.ownerEmail || s.ownerEmail === me?.email

  // Tooltip surfaces the current preview so users still know which session
  // they're in without taking horizontal space in the header.
  const buttonTitle = current
    ? `Sessions · current: ${currentTitle}`
    : 'Sessions'

  return (
    <div className='session-switcher' ref={wrapRef}>
      <button
        type='button'
        className={`icon-btn session-icon-btn ${open ? 'active' : ''}`}
        onClick={e => {
          e.stopPropagation()
          // Sessions from other tabs and titles generated after a turn ends
          // only arrive through a fresh fetch.
          if (!open) refresh()
          setOpen(v => !v)
        }}
        title={buttonTitle}
        aria-label={buttonTitle}
      >
        <svg
          width='16'
          height='16'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' />
        </svg>
        {sessions.length > 0 && (
          <span className='session-icon-count'>{sessions.length}</span>
        )}
      </button>

      {open && (
        <div className='session-dropdown'>
          <button className='session-dropdown-new' onClick={handleNew}>
            <svg
              width='13'
              height='13'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <line x1='12' y1='5' x2='12' y2='19' />
              <line x1='5' y1='12' x2='19' y2='12' />
            </svg>
            New session
          </button>

          <div className='session-dropdown-search'>
            <svg
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='11' cy='11' r='8' />
              <line x1='21' y1='21' x2='16.65' y2='16.65' />
            </svg>
            <input
              type='text'
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={
                superUser ? 'Search sessions or users...' : 'Search sessions...'
              }
              autoFocus
            />
          </div>

          <div className='session-dropdown-list'>
            {filtered.length === 0 ? (
              <div className='session-dropdown-empty'>No sessions</div>
            ) : (
              filtered.map(s => (
                <div
                  key={s.id}
                  className={`session-dropdown-item ${s.id === currentSessionId ? 'active' : ''}`}
                  onClick={() => handlePick(s.id)}
                >
                  {s.id === currentSessionId && (
                    <span className='session-dot' />
                  )}
                  <div className='session-dropdown-item-body'>
                    <div
                      className='session-dropdown-item-title'
                      title={s.preview || 'New Chat'}
                    >
                      {s.preview || 'New Chat'}
                    </div>
                    <div className='session-dropdown-item-meta'>
                      {(viewAll || superUser) && s.ownerEmail && (
                        <span className='session-dropdown-item-owner'>
                          {s.ownerEmail}
                        </span>
                      )}
                      {s.messageCount} msg · {relativeTime(s.createdAt)}
                    </div>
                  </div>
                  {canDeleteSession(s) && (
                    <button
                      className='session-dropdown-item-delete'
                      onClick={e => handleDelete(s.id, e)}
                      title='Delete'
                    >
                      <svg
                        width='11'
                        height='11'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                      >
                        <polyline points='3 6 5 6 21 6' />
                        <path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' />
                      </svg>
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
