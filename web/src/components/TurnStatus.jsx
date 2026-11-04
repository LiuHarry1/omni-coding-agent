import { useEffect, useMemo, useState } from 'react'

const STATE_LABELS = {
  dispatching: 'Submitting request',
  preparing: 'Preparing',
  requesting: 'Waiting for model',
  thinking: 'Thinking',
  responding: 'Responding',
  'tool-input': 'Preparing tool',
  'tool-use': 'Running tool',
}

export default function TurnStatus({ state, detail, label, since }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!since || state === 'idle') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since, state])

  const elapsed = since ? Math.max(0, now - since) : 0
  const text = useMemo(
    () => label || STATE_LABELS[state] || 'Working',
    [label, state],
  )
  const stalled = elapsed >= 3000 && state !== 'tool-use'
  if (!state || state === 'idle') return null

  return (
    <div
      className={`turn-status${stalled ? ' turn-status--stalled' : ''}`}
      role='status'
      aria-live='polite'
      data-turn-state={state}
      data-turn-detail={detail || undefined}
    >
      <span className='turn-status-dot' aria-hidden='true' />
      <span className='shimmer-text'>{text}</span>
      {elapsed >= 1000 && (
        <span className='turn-status-elapsed'>
          {Math.floor(elapsed / 1000)}s
        </span>
      )}
    </div>
  )
}
