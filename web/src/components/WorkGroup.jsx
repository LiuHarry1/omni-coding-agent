import { useState } from 'react'
import { formatWorkedDuration } from '../lib/timeline.js'
import ChevronIcon from './ChevronIcon.jsx'

/**
 * Default-chat `workGroup` disclosure (completed turn only).
 *
 * Label ≈ action "Worked" + details `formatWorkedDuration(durationMs)` → "for 7s".
 * With running tasks: "N working" (`runningTaskCount`).
 *
 * Controlled open via `open` + `onOpenChange` (parent keys by stable rowId).
 */
export default function WorkGroup({
  children,
  durationMs,
  runningTaskCount = 0,
  defaultOpen = false,
  open: openControlled,
  onOpenChange,
}) {
  const [openUncontrolled, setOpenUncontrolled] = useState(defaultOpen)
  const controlled = typeof openControlled === 'boolean'
  const open = controlled ? openControlled : openUncontrolled

  const setOpen = next => {
    const value = typeof next === 'function' ? next(open) : next
    if (!controlled) setOpenUncontrolled(value)
    onOpenChange?.(value)
  }

  const dur = formatWorkedDuration(durationMs)
  const isRunning = runningTaskCount > 0

  return (
    <div
      className={`work-group ${open ? 'open' : ''} ${isRunning ? 'active' : ''}`}
    >
      <button
        type='button'
        className='work-group-header'
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-busy={isRunning || undefined}
      >
        <span className='work-group-label'>
          {isRunning ? (
            <span className='work-group-action shimmer-text'>
              {runningTaskCount} working
            </span>
          ) : (
            <>
              <span className='work-group-action'>Worked</span>
              {dur ? <span className='work-group-details'>{dur}</span> : null}
            </>
          )}
        </span>
        <ChevronIcon open={open} className='work-group-chevron' />
      </button>

      <div className='work-group-body' hidden={!open} aria-hidden={!open}>
        {children}
      </div>
    </div>
  )
}
