import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useSubagentTabsStore } from '../stores/subagent-tabs-store.js'
import { useChatActions } from '../lib/chat-actions.jsx'
import { agentApi } from '../lib/api/agent.js'
import {
  messagesToBubbles,
  toolBubbleId,
  toolBubbleToPart,
} from '../lib/bubbles/messages-to-bubbles.js'
import { sanitizeMessagesForUi } from '../lib/sanitize-tool-ui.js'
import { useStickToBottom } from '../hooks/useStickToBottom.js'
import {
  subagentAgentId,
  subagentCallBubbles,
  subagentDurationLabel,
  subagentOutcome,
  subagentReport,
  subagentSummary,
  subagentTimeLabel,
  subagentTurns,
  subagentTypeLabel,
} from '../lib/subagent-view.js'
import ChevronIcon from './ChevronIcon.jsx'
import ExploredGroup from './ExploredGroup.jsx'
import { SubagentMark, subagentMarkMode } from './SubagentCard.jsx'
import { BubbleView } from './transcript/BubbleRow.jsx'

/**
 * Subagents opened from the chat, as tabs beside it, and the page a tab
 * shows: a header saying which agent this is and how it stands (type,
 * model, time worked, steps), then for each time it was asked the task,
 * its activity as a timeline, and the result.
 *
 * Read-only. While the agent runs the page shows what has streamed into
 * the chat; once it is done, its transcript as saved on the server.
 */

const icon = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
}

const ChatIcon = () => (
  <svg {...icon} className='subagent-tabs__icon'>
    <path d='M2.5 3.5h11v8h-6l-3 2.5v-2.5h-2z' />
  </svg>
)
const CloseIcon = () => (
  <svg {...icon} width={12} height={12} strokeWidth={1.5}>
    <path d='M3.5 3.5l9 9M12.5 3.5l-9 9' />
  </svg>
)
const CopyIcon = () => (
  <svg {...icon} width={13} height={13}>
    <rect x='5.5' y='5.5' width='8' height='8' rx='1.5' />
    <path d='M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2' />
  </svg>
)
const CheckIcon = () => (
  <svg {...icon} width={13} height={13} strokeWidth={1.6}>
    <path d='M3.5 8.5l3 3 6-7' />
  </svg>
)
const StopIcon = () => (
  <svg {...icon} width={11} height={11} fill='currentColor' stroke='none'>
    <rect x='3' y='3' width='10' height='10' rx='2' />
  </svg>
)
const ModelIcon = () => (
  <svg {...icon} width={13} height={13}>
    <rect x='4' y='4' width='8' height='8' rx='1.5' />
    <path d='M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5h2.5M1.5 9.5h2.5M12 6.5h2.5M12 9.5h2.5' />
  </svg>
)
const ClockIcon = () => (
  <svg {...icon} width={13} height={13}>
    <circle cx='8' cy='8' r='5.75' />
    <path d='M8 4.75V8l2.25 1.5' />
  </svg>
)
const StepsIcon = () => (
  <svg {...icon} width={13} height={13}>
    <path d='M6 4h7.5M6 8h7.5M6 12h7.5' />
    <path d='M2.5 4h.01M2.5 8h.01M2.5 12h.01' strokeWidth={2} />
  </svg>
)

/** The current time, read again every `intervalMs`. */
function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

const STATUS_LABEL = {
  running: 'Running',
  completed: 'Completed',
  stopped: 'Stopped',
  error: 'Failed',
  background: 'In background',
}

/** How the agent stands, in a word. */
function StatusPill({ outcome, stopping }) {
  return (
    <span
      className={`subagent-status subagent-status--${outcome}`}
      data-subagent-page-status={outcome}
    >
      <SubagentMark mode={subagentMarkMode(outcome)} />
      {stopping ? 'Stopping…' : STATUS_LABEL[outcome]}
    </span>
  )
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One titled part of the page; `aside` sits at the end of its title row. */
function Section({ label, aside, children }) {
  return (
    <section className='subagent-section'>
      <div className='subagent-section__head'>
        <h3 className='subagent-section__label'>{label}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/**
 * What the agent was asked. A long task shows its first lines, fading
 * out, with a way to show the rest.
 */
function Task({ text }) {
  const textRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || expanded) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, expanded])

  return (
    <div
      className='subagent-task'
      data-clamped={overflows && !expanded ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
    >
      <div className='subagent-task__text' ref={textRef}>
        {text}
      </div>
      {(overflows || expanded) && (
        <button
          type='button'
          className='subagent-task__more'
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** One step on the timeline: a tool call, a run of them, or what it said. */
function Step({ el, byId }) {
  let body
  if (el.type === 'tool_group') {
    const items = el.memberIds
      .map(id => byId[id])
      .filter(b => b?.kind === 'tool')
      .map(toolBubbleToPart)
    if (items.length === 0) return null
    body = (
      <div className='tool-group'>
        <ExploredGroup items={items} kind={el.groupKind} live={!!el.live} />
      </div>
    )
  } else {
    const bubble = byId[el.bubbleId]
    if (!bubble) return null
    body = (
      <BubbleView bubble={bubble} embedded={bubble.kind === 'tool'} readOnly />
    )
  }
  return <li className='subagent-activity__step'>{body}</li>
}

/**
 * What the agent did for one task, as a timeline. Open while it works
 * and when it ended without an answer; folded once there is a result.
 */
function Activity({ turn, byId, showDuration }) {
  const [open, setOpen] = useState(turn.live || !turn.result)
  const duration = showDuration ? subagentDurationLabel(turn.durationMs) : ''
  const count = [
    turn.stepCount > 0 ? plural(turn.stepCount, 'step') : '',
    duration,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className='subagent-section'>
      <button
        type='button'
        className='subagent-section__head subagent-section__head--toggle'
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <h3 className='subagent-section__label'>Activity</h3>
        {count && <span className='subagent-section__count'>{count}</span>}
        <ChevronIcon open={open} className='subagent-section__chevron' />
      </button>
      <ol className='subagent-activity' hidden={!open}>
        {turn.steps.map(el => (
          <Step key={el.id} el={el} byId={byId} />
        ))}
        {turn.live && (
          <li className='subagent-activity__step subagent-activity__step--live'>
            <span className='shimmer-text'>Working…</span>
          </li>
        )}
      </ol>
    </section>
  )
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    const done = navigator.clipboard?.writeText(text)
    if (done) done.then(() => setCopied(true)).catch(() => {})
  }
  return (
    <button
      type='button'
      className='subagent-btn'
      onClick={copy}
      aria-label='Copy result'
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** One time the agent was asked: the task, what it did, what came of it. */
function Turn({ turn, byId, followUp, showDuration }) {
  const { prompt, result } = turn
  const failed = result?.kind === 'error'
  return (
    <>
      {prompt?.content && (
        <Section label={followUp ? 'Follow-up' : 'Task'}>
          <Task text={prompt.content} />
        </Section>
      )}
      {(turn.steps.length > 0 || turn.live) && (
        <Activity turn={turn} byId={byId} showDuration={showDuration} />
      )}
      {result && !failed && (
        <Section
          label='Result'
          aside={<CopyButton text={result.content.trim()} />}
        >
          <div className='subagent-result-card'>
            <BubbleView bubble={result} readOnly />
          </div>
        </Section>
      )}
      {failed && (
        <Section label='Error'>
          <div className='subagent-error' role='alert'>
            {result.message}
          </div>
        </Section>
      )}
    </>
  )
}

function SubagentPage({ tab }) {
  const { stopTool } = useChatActions()
  const bubble = useChatStore(s => s.bubblesById[toolBubbleId(tab.toolCallId)])
  const part = useMemo(
    () => (bubble?.kind === 'tool' ? toolBubbleToPart(bubble) : null),
    [bubble],
  )
  // A call no longer in the chat can only be read from the server.
  const outcome = part ? subagentOutcome(part) : null
  const running = outcome === 'running'
  const agentId = (part && subagentAgentId(part)) || tab.agentId

  const [saved, setSaved] = useState({ status: 'idle' })
  useEffect(() => {
    if (running || !agentId) {
      setSaved({ status: 'idle' })
      return
    }
    let cancelled = false
    setSaved({ status: 'loading' })
    agentApi
      .getSubagentTranscript(tab.sessionId, agentId)
      .then(data => {
        if (cancelled) return
        const { bubbleOrder, bubblesById } = messagesToBubbles(
          sanitizeMessagesForUi(data?.messages ?? []),
        )
        setSaved({
          status: 'ready',
          agent: data?.agent ?? null,
          bubbles: bubbleOrder.map(id => bubblesById[id]),
        })
      })
      .catch(() => {
        if (!cancelled) setSaved({ status: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [running, agentId, tab.sessionId])

  // Until the saved transcript is read — and if it cannot be — what the
  // chat holds of the call stands in for it.
  const callBubbles = useMemo(
    () => (part ? subagentCallBubbles(part) : []),
    [part],
  )
  const bubbles = useMemo(() => {
    if (saved.status !== 'ready') return callBubbles
    // Why a run failed is in the call's result, not in what the agent wrote.
    const error = outcome === 'error' ? subagentReport(part) : ''
    return error
      ? [...saved.bubbles, { id: 'report', kind: 'error', message: error }]
      : saved.bubbles
  }, [saved, callBubbles, outcome, part])
  const { byId, turns } = useMemo(
    () => subagentTurns(bubbles, { running }),
    [bubbles, running],
  )
  // Follow the work as it comes in; a finished agent is read from the top.
  const scroll = useStickToBottom(bubbles, running)
  const now = useNow(running ? 1000 : 60_000)

  let state = null
  if (turns.length === 0) {
    if (saved.status === 'failed' || (!running && !agentId)) state = 'failed'
    else if (!running && saved.status === 'ready') state = 'empty'
    else state = 'loading'
  }

  const agent = saved.status === 'ready' ? saved.agent : null
  const summary = subagentSummary(turns)
  const title = part?.args?.description || tab.title
  const typeLabel = subagentTypeLabel(
    agent?.agent_type || part?.args?.subagent_type,
  )
  const callStart =
    typeof part?.startTime === 'number' ? part.startTime : undefined
  const startedAt = agent?.created_at ?? summary.startedAt ?? callStart
  // While it works: how long this call has been going.
  const duration = subagentDurationLabel(
    running && callStart !== undefined
      ? Math.max(1, now - callStart)
      : summary.durationMs,
  )
  const whenAt = running ? startedAt : (summary.endedAt ?? startedAt)
  const whenAgo = subagentTimeLabel(whenAt, now, { ago: true })
  const when = whenAgo
    ? `${running || summary.endedAt === undefined ? 'Started' : 'Finished'} ${whenAgo.toLowerCase()}`
    : ''
  const stopped =
    outcome === 'stopped' && turns.length > 0 && !turns.at(-1).result

  return (
    <section
      className='subagent-page'
      role='tabpanel'
      aria-label={`Subagent: ${title}`}
    >
      <div
        className='subagent-page__scroll'
        ref={scroll.ref}
        onScroll={scroll.onScroll}
      >
        <div className='subagent-page__column'>
          <header className='subagent-page__header'>
            <div className='subagent-page__heading'>
              <h2 className='subagent-page__title' title={title}>
                {title}
              </h2>
              {outcome && (
                <StatusPill outcome={outcome} stopping={!!part?.stopping} />
              )}
              {running && (
                <button
                  type='button'
                  className='subagent-btn subagent-btn--danger'
                  disabled={!!part?.stopping}
                  onClick={() => void stopTool(tab.toolCallId)}
                >
                  <StopIcon />
                  Stop
                </button>
              )}
            </div>
            <ul className='subagent-page__facts'>
              {typeLabel && (
                <li className='subagent-page__badge' title='Agent type'>
                  {typeLabel}
                </li>
              )}
              {agent?.model && (
                <li title='Model'>
                  <ModelIcon />
                  {agent.model}
                </li>
              )}
              {duration && (
                <li title='Time worked' data-subagent-fact='duration'>
                  <ClockIcon />
                  {duration}
                </li>
              )}
              {summary.stepCount > 0 && (
                <li title='Tool calls' data-subagent-fact='steps'>
                  <StepsIcon />
                  {plural(summary.stepCount, 'step')}
                </li>
              )}
              {when && (
                <li
                  className='subagent-page__when'
                  title={new Date(whenAt).toLocaleString()}
                >
                  {when}
                </li>
              )}
            </ul>
          </header>

          {state === 'loading' && (
            <div className='subagent-page__state' role='status'>
              <span className='session-loading-spinner' aria-hidden='true' />
              <span>Loading conversation…</span>
            </div>
          )}
          {state === 'failed' && (
            <div className='subagent-page__state'>
              This conversation could not be loaded
            </div>
          )}
          {state === 'empty' && (
            <div className='subagent-page__state'>Nothing to show</div>
          )}
          {turns.map((turn, i) => (
            <Turn
              key={turn.key}
              turn={turn}
              byId={byId}
              followUp={i > 0}
              showDuration={turns.length > 1}
            />
          ))}
          {stopped && (
            <p className='subagent-page__note'>
              Stopped before it gave a result.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/** The mark on an agent's tab: working, ended, or ended in an error. */
function TabMark({ toolCallId }) {
  const outcome = useChatStore(s => {
    const bubble = s.bubblesById[toolBubbleId(toolCallId)]
    return bubble?.kind === 'tool'
      ? subagentOutcome(toolBubbleToPart(bubble))
      : null
  })
  return (
    <span className='subagent-tabs__mark'>
      <SubagentMark mode={subagentMarkMode(outcome ?? 'completed')} />
    </span>
  )
}

/** The chat and the subagents opened from it, as tabs. */
function TabStrip({ rootTitle, tabs, activeKey, onShowChat, onShow, onClose }) {
  return (
    <div className='subagent-tabs' role='tablist' aria-label='Conversations'>
      <button
        type='button'
        role='tab'
        className='subagent-tabs__tab'
        aria-selected={activeKey === null}
        title={rootTitle}
        onClick={onShowChat}
      >
        <ChatIcon />
        <span className='subagent-tabs__label'>{rootTitle}</span>
      </button>
      {tabs.map(tab => (
        <div
          key={tab.key}
          role='tab'
          tabIndex={0}
          className='subagent-tabs__tab'
          data-subagent-tab=''
          aria-selected={tab.key === activeKey}
          title={tab.title}
          onClick={() => onShow(tab.key)}
          onAuxClick={e => {
            if (e.button === 1) onClose(tab.key)
          }}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onShow(tab.key)
            }
          }}
        >
          <TabMark toolCallId={tab.toolCallId} />
          <span className='subagent-tabs__label'>{tab.title}</span>
          <button
            type='button'
            className='subagent-tabs__close'
            aria-label={`Close ${tab.title}`}
            title='Close'
            onClick={e => {
              e.stopPropagation()
              onClose(tab.key)
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The chat area. Opening a subagent adds a tab for it above the chat; the
 * tab that is showing takes the chat's place until the chat's own tab is
 * picked again.
 */
export default function SubagentTabsStage({ children }) {
  const allTabs = useSubagentTabsStore(s => s.tabs)
  const activeKey = useSubagentTabsStore(s => s.activeKey)
  const activate = useSubagentTabsStore(s => s.activate)
  const showChat = useSubagentTabsStore(s => s.showChat)
  const close = useSubagentTabsStore(s => s.close)
  const closeAll = useSubagentTabsStore(s => s.closeAll)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const rootTitle = useChatStore(
    s => s.sessions.find(x => x.id === currentSessionId)?.preview || 'Chat',
  )

  // Tabs belong to the conversation they were opened from.
  const stale = allTabs.some(t => t.sessionId !== currentSessionId)
  useEffect(() => {
    if (stale) closeAll()
  }, [stale, closeAll])

  const tabs = stale
    ? allTabs.filter(t => t.sessionId === currentSessionId)
    : allTabs
  const active = tabs.find(t => t.key === activeKey) ?? null

  return (
    <div
      className='chat-stage'
      data-subagent-tab-active={active ? 'true' : undefined}
    >
      {tabs.length > 0 && (
        <TabStrip
          rootTitle={rootTitle}
          tabs={tabs}
          activeKey={active ? active.key : null}
          onShowChat={showChat}
          onShow={activate}
          onClose={close}
        />
      )}
      <div className='chat-stage__body'>
        {children}
        {active && <SubagentPage key={active.key} tab={active} />}
      </div>
    </div>
  )
}
