import { useEffect, useState } from 'react'

/** How long one value takes to give way to the next. */
const ROLL_MS = 300

/**
 * One line of text whose changes roll: the old value leaves upward while
 * the new one comes in from below. A value that changes again mid-roll
 * starts the roll over from what is showing.
 *
 * `itemClassName` goes on the text itself (e.g. a shimmer).
 *
 * @param {{ text: string, itemClassName?: string }} props
 */
export default function TextRoll({ text, itemClassName = '' }) {
  const [roll, setRoll] = useState({ current: text, previous: null, seq: 0 })
  if (text !== roll.current) {
    setRoll({ current: text, previous: roll.current, seq: roll.seq + 1 })
  }

  const rolling = roll.previous !== null
  const { seq } = roll
  useEffect(() => {
    if (!rolling) return
    const timer = setTimeout(
      () => setRoll(r => (r.seq === seq ? { ...r, previous: null } : r)),
      ROLL_MS,
    )
    return () => clearTimeout(timer)
  }, [rolling, seq])

  const item = state =>
    ['text-roll__item', state, itemClassName].filter(Boolean).join(' ')

  return (
    <span className='text-roll' data-rolling={rolling ? 'true' : undefined}>
      {rolling && (
        <span
          key={`previous-${seq}`}
          className={item('text-roll__item--exit')}
          aria-hidden='true'
        >
          {roll.previous}
        </span>
      )}
      <span
        key={`current-${seq}`}
        className={item(rolling && 'text-roll__item--enter')}
      >
        {roll.current}
      </span>
    </span>
  )
}
