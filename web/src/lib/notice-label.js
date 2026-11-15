/** How long a model switch stays in the status line. */
const FALLBACK_LABEL_MS = 10_000

/** The status line for a recent retry or model switch, or null. */
export function noticeLabel(notice, now) {
  if (!notice) return null
  if (notice.kind === 'retry') {
    const left = notice.at + notice.delay_ms - now
    if (left <= 0) return null
    return `Request failed, retrying in ${Math.ceil(left / 1000)}s (attempt ${notice.attempt}/${notice.max_attempts})`
  }
  if (notice.kind === 'model_fallback' && now - notice.at < FALLBACK_LABEL_MS) {
    return `${notice.from} is busy, switched to ${notice.to}`
  }
  return null
}
