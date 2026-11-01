const STATUS_TONES = {
  active: 'success',
  connected: 'success',
  current: 'accent',
  ready: 'success',
  running: 'success',
  installed: 'success',
  provisioning: 'warning',
  starting: 'warning',
  importing: 'warning',
  conditional: 'neutral',
  stopped: 'neutral',
  disconnected: 'neutral',
  readonly: 'neutral',
  error: 'danger',
  failed: 'danger',
  conflict: 'danger',
}

export default function StatusBadge({
  status,
  children,
  tone,
  title,
  className = '',
}) {
  const label = children ?? status ?? ''
  const resolvedTone =
    tone || STATUS_TONES[String(status || label).toLowerCase()] || 'neutral'
  return (
    <span
      className={`extensions-status extensions-status--${resolvedTone} ${className}`}
      title={title}
    >
      {label}
    </span>
  )
}
