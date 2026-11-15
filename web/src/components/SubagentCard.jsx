import { useMemo } from 'react'
import { useChatActions } from '../lib/chat-actions.jsx'
import { useHeldText } from '../hooks/useHeldText.js'
import TextRoll from './TextRoll.jsx'
import {
  isBackgroundLaunch,
  subagentAgentId,
  subagentOutcome,
  subagentStatusLine,
  subagentTypeLabel,
  visibleSubagentSteps,
} from '../lib/subagent-view.js'

/**
 * A subagent call in the transcript: an indicator, its title and type on
 * one line, and what it is doing or how it ended on the next. The whole
 * card is the button that opens the agent's conversation in a tab of its
 * own; what can be done to the agent (Stop) appears over the card on hover.
 */

export { isBackgroundLaunch }
/** The card's second line. */
export const subagentRowSubtitle = subagentStatusLine

/** How long a step label stays before the next one may replace it. */
const STATUS_MIN_HOLD_MS = 1200

const GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/** Nine dots, lit in turn, while the agent works. */
function DotGridLoader() {
  return (
    <svg
      className='subagent-dot-grid'
      viewBox='0 0 10.5 10.5'
      aria-hidden='true'
      focusable='false'
    >
      {GRID.map(dot => (
        <circle
          key={dot}
          className={`subagent-dot-grid__dot subagent-dot-grid__dot--${dot}`}
          cx={1.25 + ((dot - 1) % 3) * 4}
          cy={1.25 + Math.floor((dot - 1) / 3) * 4}
          r={1.125}
        />
      ))}
    </svg>
  )
}

/**
 * How the agent stands, as a mark: the dot grid while it works, a dot once
 * it has ended (red for an error). Also on the agent's tab and page.
 */
export function SubagentMark({ mode }) {
  return (
    <span
      className='subagent-card__mark'
      data-subagent-task-status={mode}
      aria-hidden='true'
    >
      {mode === 'running' ? (
        <DotGridLoader />
      ) : (
        <span
          className={`subagent-card__dot subagent-card__dot--${mode === 'error' ? 'error' : 'done'}`}
        />
      )}
    </span>
  )
}

/** Which mark an outcome gets. */
export function subagentMarkMode(outcome) {
  if (outcome === 'running') return 'running'
  return outcome === 'error' ? 'error' : 'finished'
}

/** The mark in the card's first column. */
export function SubagentIndicator({ mode, dimmed = false }) {
  return (
    <span
      className={`subagent-card__indicator ${dimmed ? 'subagent-card__indicator--dimmed' : ''}`}
      aria-hidden='true'
    >
      <SubagentMark mode={mode} />
    </span>
  )
}

export default function SubagentCard({ part, onStopTool }) {
  const { stopTool, openSubagent } = useChatActions()
  const stop = onStopTool ?? stopTool
  const args = part.args || {}
  // Args stream in after the card appears; the first step's label/task
  // fill the gap so we do not show a bare "Agent" / "New subagent".
  const subagentType =
    args.subagent_type ||
    part.liveLabel ||
    (part.name && part.name !== 'Agent' && part.name !== 'SendMessage'
      ? part.name
      : null) ||
    ''
  const headline =
    args.description ||
    args.task ||
    (typeof part.liveTask === 'string' ? part.liveTask : '') ||
    (typeof args.prompt === 'string' ? args.prompt.slice(0, 120) : '') ||
    (typeof args.message === 'string' ? args.message.slice(0, 120) : '') ||
    'New subagent'
  // SendMessage continues an agent: `message` is its prompt.
  const fullPrompt = args.prompt || args.task || args.message || ''
  const outcome = subagentOutcome(part)
  const isDone = part.status === 'done'
  const typeLabel = subagentTypeLabel(subagentType)
  const agentId = subagentAgentId(part)

  const { subagentParts } = part
  const steps = useMemo(
    () => visibleSubagentSteps({ subagentParts }),
    [subagentParts],
  )
  // Step labels can change several times a second; each is held long
  // enough to read. How the agent ended is shown at once.
  const working = !isDone && !part.stopping
  const statusLine = useHeldText(
    subagentStatusLine(part, steps, headline),
    STATUS_MIN_HOLD_MS,
    working,
  )

  // A running agent shows what has streamed in; a finished one needs the
  // id its transcript was saved under.
  const canOpen = !!part.toolCallId && (!!agentId || !isDone)
  const canStop = !isDone && !!part.toolCallId

  const open = () => {
    if (!canOpen) return
    openSubagent({ toolCallId: part.toolCallId, agentId, title: headline })
  }
  const onKeyDown = e => {
    if (!canOpen || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  }
  const onStop = e => {
    e.stopPropagation()
    if (!canStop || part.stopping) return
    void stop(part.toolCallId)
  }

  return (
    <div
      className={`tool-row subagent-card subagent-card--${outcome}`}
      data-subagent-task-card=''
      data-subagent-status={outcome}
    >
      <div
        className='subagent-card__header'
        data-subagent-task-card-header=''
        role={canOpen ? 'button' : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onClick={canOpen ? open : undefined}
        onKeyDown={onKeyDown}
      >
        <div className='subagent-card__row'>
          <SubagentIndicator
            mode={subagentMarkMode(outcome)}
            dimmed={outcome === 'stopped'}
          />
          <div className='subagent-card__main'>
            <div className='subagent-card__title-row'>
              <span
                className='subagent-card__title'
                title={fullPrompt || headline}
              >
                {headline}
              </span>
              {typeLabel && (
                <span
                  className='subagent-card__model'
                  data-subagent-task-model=''
                >
                  {typeLabel}
                </span>
              )}
            </div>
            <span className='subagent-card__status'>
              <TextRoll
                text={statusLine}
                itemClassName={working ? 'shimmer-text' : ''}
              />
            </span>
          </div>
          {canStop && (
            <div
              className='subagent-card__actions'
              data-subagent-task-actions='overlay'
            >
              <div className='subagent-card__actions-inner'>
                <button
                  type='button'
                  className='subagent-card__action'
                  data-subagent-task-action='stop'
                  onClick={onStop}
                  onAuxClick={e => e.stopPropagation()}
                  disabled={!!part.stopping}
                >
                  Stop
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
