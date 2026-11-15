import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { noticeLabel } from '../lib/notice-label.js'

/** The live retry / model-switch line while a request is pending, or null. */
export function useRetryLabel() {
  const state = useChatStore(s => s.turnState)
  const notice = useChatStore(s => s.notice)
  const [now, setNow] = useState(() => Date.now())
  const label = state === 'requesting' ? noticeLabel(notice, now) : null

  useEffect(() => setNow(Date.now()), [notice])
  useEffect(() => {
    if (!label) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [label])

  return label
}
