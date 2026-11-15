import { useCallback, useLayoutEffect, useRef } from 'react'

/** This close to the end still counts as following it. */
const PIN_THRESHOLD_PX = 24

/**
 * Keep a scroll box at its end while its content grows, until the reader
 * scrolls away; scrolling back to the end resumes following.
 *
 * @param {unknown} signal changes whenever the content may have grown
 * @param {boolean} active follow only while true (e.g. while streaming)
 * @returns {{ ref: import('react').RefObject<HTMLElement>, onScroll: () => void }}
 */
export function useStickToBottom(signal, active) {
  const ref = useRef(null)
  const pinned = useRef(true)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [signal, active])

  return { ref, onScroll }
}
