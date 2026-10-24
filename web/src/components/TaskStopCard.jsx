import ToolChrome from './ToolChrome.jsx'
import { detectError } from '../lib/utils.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Kill / stop background shell — compact action row.
 */
export default function TaskStopCard({ part }) {
  const args = part.args || {}
  const tur = getTur(part)
  const taskId = tur?.task_id || args.task_id || args.shell_id || ''
  const message =
    typeof tur?.message === 'string'
      ? tur.message
      : typeof tur?.text === 'string'
        ? tur.text
        : typeof part.result === 'string'
          ? part.result
          : ''
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskStop', message) ||
      (typeof message === 'string' && message.startsWith('Error:')))
  const hasOutput = typeof message === 'string' && message.length > 0
  const hasBody = Boolean(isDone && (hasOutput || isError))

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('default', {
    isDone,
    isError,
    hasBody,
  })

  const action = toolActionLabel('stop', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError ? toolErrorDetails(taskId || '…', true) : taskId || null

  return (
    <ToolChrome
      variant='task-stop-card'
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      label={action}
      title={title}
      titlePlain
      titleTooltip={taskId}
      duration={undefined}
      showSuccess={false}
    >
      {hasOutput && (
        <pre
          className={`tool-row-body ${isError ? 'tool-row-body--error' : ''}`}
        >
          {message}
        </pre>
      )}
    </ToolChrome>
  )
}
