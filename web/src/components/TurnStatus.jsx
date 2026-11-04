import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { thinkingBubbleId } from '../lib/bubbles/messages-to-bubbles.js'

/**
 * States with no transcript row yet. Later states (reasoning, tool input/run,
 * streaming text) are shown inline by their own rows, so the tail stays empty.
 */
const PRE_ROW_STATES = new Set(['dispatching', 'preparing', 'requesting'])
const DEFAULT_LABEL = 'Planning next moves'
/** Short preparing phases would flash unreadable labels; keep the default. */
const PHASE_LABEL_DELAY_MS = 800

/** Transcript tail status before the turn's first row (one indicator at a time). */
export default function TurnStatus() {
  const state = useChatStore(s => s.turnState)
  const detail = useChatStore(s => s.turnDetail)
  const label = useChatStore(s => s.turnStateLabel)
  const since = useChatStore(s => s.turnStateSince)
  const awaiting = useChatStore(s => s.isAwaitingInteraction)
  const planningShown = useChatStore(
    s => !!s.activeTurnId && !!s.bubblesById[thinkingBubbleId(s.activeTurnId)],
  )
  const [labelReady, setLabelReady] = useState(false)

  useEffect(() => {
    setLabelReady(false)
    if (state !== 'preparing' || !label) return undefined
    const wait = Math.max(0, PHASE_LABEL_DELAY_MS - (Date.now() - (since || 0)))
    const timer = window.setTimeout(() => setLabelReady(true), wait)
    return () => window.clearTimeout(timer)
  }, [state, label, since])

  if (!PRE_ROW_STATES.has(state) || awaiting || planningShown) return null

  const text = state === 'preparing' && labelReady ? label : DEFAULT_LABEL
  return (
    <div
      className='planning-status'
      role='status'
      aria-live='polite'
      data-turn-state={state}
      data-turn-detail={detail || undefined}
    >
      <span className='shimmer-text'>{text}</span>
    </div>
  )
}
