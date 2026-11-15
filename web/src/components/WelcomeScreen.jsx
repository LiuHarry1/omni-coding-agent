import { useChatStore } from '../stores/chat-store.js'
import { useSessionSwitcherStore } from '../stores/session-switcher-store.js'
import BaizeLogo from './BaizeLogo.jsx'
import { recentSessions } from '../lib/home.js'
import { relativeTime } from '../lib/utils.js'
import { getUser } from '../lib/auth.js'

function SessionIcon() {
  return (
    <svg
      className='home-recent__icon'
      width='14'
      height='14'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' />
    </svg>
  )
}

/**
 * The home page, above the composer: what the box below is for. Someone
 * else's empty conversation has no composer under it, so it only says so.
 */
export default function WelcomeScreen() {
  const readOnly = useChatStore(s => s.sessionReadOnly)

  if (readOnly) {
    return (
      <div className='home-hero home-hero--empty'>
        <p className='home-hero__sub'>Nothing in this conversation yet.</p>
      </div>
    )
  }

  return (
    <div className='home-hero'>
      <BaizeLogo size='md' />
      <h1 className='home-hero__title'>What should we work on?</h1>
      <p className='home-hero__sub'>
        Build in the cloud and preview complete projects in your browser.
      </p>
    </div>
  )
}

/**
 * The home page, below the composer: the sessions to go back to. The block is
 * there even with none to list — the page is centred around it.
 */
export function HomeStart() {
  const switchSession = useChatStore(s => s.switchSession)
  const sessions = useChatStore(s => s.sessions)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const openSwitcher = useSessionSwitcherStore(s => s.setOpen)
  const recent = recentSessions(sessions, { currentSessionId })
  const me = getUser()

  return (
    <div className='home-start'>
      {recent.length > 0 && (
        <section className='home-section' aria-labelledby='home-recent-label'>
          <div className='home-section__head'>
            <h2 className='home-section__label' id='home-recent-label'>
              Recent
            </h2>
            <button
              type='button'
              className='home-section__link'
              onClick={e => {
                // The list closes on a click outside it, and this is one.
                e.stopPropagation()
                openSwitcher(true)
              }}
            >
              View all
              <span className='home-section__count'>{sessions.length}</span>
            </button>
          </div>
          <ul className='home-recent'>
            {recent.map(s => (
              <li key={s.id}>
                <button
                  type='button'
                  className='home-recent__item'
                  onClick={() => switchSession(s.id)}
                >
                  <SessionIcon />
                  <span className='home-recent__title'>
                    {s.preview || 'New Chat'}
                  </span>
                  <span className='home-recent__meta'>
                    {s.ownerEmail && s.ownerEmail !== me?.email
                      ? `${s.ownerEmail} · `
                      : ''}
                    {relativeTime(s.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
