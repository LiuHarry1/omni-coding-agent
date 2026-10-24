import ToolCallLine from './ToolCallLine.jsx'

/**
 * Shared tool-row shell (ui-tool-call-line chrome).
 *
 * Cards own header copy + body content; this owns:
 *   `.tool-row` modifiers · `ToolCallLine` · expand gating for children
 *
 * Use `chrome: 'card'` tools (Write/Edit FileChangeCard) separately —
 * they keep bordered card chrome on purpose.
 *
 * @param {object} props
 * @param {string} [props.variant] - e.g. `read-file-card`, `bash-card`
 * @param {string} [props.className] - extra classes
 * @param {boolean} [props.nested]
 * @param {boolean} [props.isError]
 * @param {boolean} [props.isDone]
 * @param {boolean} [props.expanded]
 * @param {() => void} [props.onToggle]
 * @param {boolean} [props.hasBody=true] - whether a body/chevron is available
 * @param {boolean} [props.bodyOpen] - override when to render children (default: expanded && hasBody)
 * @param {boolean} [props.showChevron] - default: hasBody
 * @param {import('react').ReactNode} [props.children] - body (only when bodyOpen)
 * @param {import('react').ReactNode} [props.icon]
 * @param {string} [props.label]
 * @param {import('react').ReactNode} [props.title]
 * @param {string} [props.titleTooltip]
 * @param {boolean} [props.titlePlain]
 * @param {import('react').ReactNode} [props.subtitle]
 * @param {string} [props.subtitleTooltip]
 * @param {import('react').ReactNode} [props.meta]
 * @param {number|string} [props.duration]
 * @param {import('react').ReactNode} [props.actions]
 * @param {string} [props.emptyHint]
 * @param {boolean} [props.showSuccess]
 */
export default function ToolChrome({
  variant,
  className,
  nested = false,
  isError = false,
  isDone,
  expanded = false,
  onToggle,
  hasBody = true,
  bodyOpen,
  showChevron,
  children,
  icon,
  label,
  title,
  titleTooltip,
  titlePlain,
  subtitle,
  subtitleTooltip,
  meta,
  duration,
  actions,
  emptyHint,
  showSuccess,
}) {
  const open = bodyOpen ?? (expanded && hasBody)
  const canToggle = Boolean(hasBody && onToggle)
  const chevron = showChevron ?? hasBody

  const classes = [
    'tool-row',
    variant,
    className,
    nested ? 'tool-row--nested' : '',
    isError ? 'has-error' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      <ToolCallLine
        expanded={open}
        onToggle={canToggle ? onToggle : undefined}
        showChevron={chevron}
        icon={icon}
        label={label}
        title={title}
        titleTooltip={titleTooltip}
        titlePlain={titlePlain}
        subtitle={subtitle}
        subtitleTooltip={subtitleTooltip}
        meta={meta}
        duration={duration}
        isDone={isDone}
        isError={isError}
        actions={actions}
        emptyHint={emptyHint}
        showSuccess={showSuccess}
      />
      {open ? children : null}
    </div>
  )
}
