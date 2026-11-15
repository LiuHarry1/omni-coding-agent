import { useEffect, useRef, useState } from 'react'

/**
 * A line of text that changes often, shown so each value can be read: once
 * a value appears it stays for at least `minHoldMs`, then gives way to the
 * latest one. Values that came and went in between are skipped.
 *
 * With `hold` false the latest value shows at once (a final status should
 * not wait behind a step label).
 *
 * @param {string} text
 * @param {number} minHoldMs
 * @param {boolean} [hold]
 */
export function useHeldText(text, minHoldMs, hold = true) {
  const [shown, setShown] = useState(text)
  const shownAt = useRef(null)
  if (shownAt.current === null) shownAt.current = Date.now()

  useEffect(() => {
    if (text === shown) return
    const show = () => {
      shownAt.current = Date.now()
      setShown(text)
    }
    const wait = hold ? shownAt.current + minHoldMs - Date.now() : 0
    if (wait <= 0) {
      show()
      return
    }
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [text, shown, minHoldMs, hold])

  return hold ? shown : text
}
