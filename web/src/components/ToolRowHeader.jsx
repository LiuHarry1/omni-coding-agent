import { formatDuration } from '../lib/utils.js'
import ChevronIcon from './ChevronIcon.jsx'

/**
 * Shared single-row tool header (implementation of ToolCallLine).
 *
 * Prefer importing `ToolCallLine` in new code — same component, canonical name
 * (`ui-tool-call-line`).
 *
 * Slot layout (left → right):
 *
 *   [icon?] [label] [title] [subtitle] [chevron?] · · · [meta] [duration] [actions] [status]
 *
 * The chevron trails the text and only shows on hover / focus / open, so
 * rows stay flush with the prose column. While `!isDone` the label shimmers.
 *
 * Slots beyond `title` are all optional. `actions` is rendered inside a
 * stopPropagation wrapper so a copy button there won't toggle the row.
 */
export default function ToolRowHeader({
  expanded,
  onToggle,
  showChevron = true,
  icon,
  label,
  title,
  titleTooltip,
  titlePlain,
  subtitle,
  subtitleTooltip,
  meta,
  duration,
  isDone,
  isError,
  actions,
  emptyHint,
  showSuccess,
}) {
  const stop = e => e.stopPropagation()
  const onKeyDown = e => {
    if (!onToggle || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }
  const dur = typeof duration === 'string' ? duration : formatDuration(duration)
  const loading = !isDone

  return (
    <div
      role={onToggle ? 'button' : undefined}
      tabIndex={onToggle ? 0 : undefined}
      className='tool-row-header'
      onClick={onToggle}
      onKeyDown={onKeyDown}
      aria-expanded={onToggle ? expanded : undefined}
      aria-disabled={!onToggle || undefined}
      aria-busy={loading || undefined}
    >
      {icon != null && (
        <span className='tool-row-icon' aria-hidden='true'>
          {icon}
        </span>
      )}
      {label && (
        <span className={`tool-row-label ${loading ? 'shimmer-text' : ''}`}>
          {label}
        </span>
      )}
      {title != null && (
        <span
          className={`tool-row-title ${titlePlain ? 'tool-row-title--plain' : ''} ${loading && !label ? 'shimmer-text' : ''}`}
          title={
            titleTooltip ?? (typeof title === 'string' ? title : undefined)
          }
        >
          {title}
        </span>
      )}
      {subtitle && (
        <span
          className='tool-row-subtitle'
          title={
            subtitleTooltip ??
            (typeof subtitle === 'string' ? subtitle : undefined)
          }
        >
          {subtitle}
        </span>
      )}
      {showChevron && (
        <ChevronIcon open={expanded} className='tool-row-chevron' />
      )}
      <span className='tool-row-spacer' />
      {meta}
      {dur && isDone && <span className='tool-row-duration'>{dur}</span>}
      {actions && (
        <span className='tool-row-actions' onClick={stop}>
          {actions}
        </span>
      )}
      {isDone && !isError && emptyHint && (
        <span
          className='tool-row-status tool-row-status--empty'
          title={emptyHint}
        >
          {'\u2205'}
        </span>
      )}
      {isDone && !isError && !emptyHint && showSuccess && (
        <span className='tool-row-status tool-row-status--ok' aria-label='done'>
          {'\u2713'}
        </span>
      )}
    </div>
  )
}
