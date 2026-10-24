import { useMemo } from 'react'
import ToolChrome from './ToolChrome.jsx'
import { detectError } from '../lib/utils.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Wait row — Waiting→Waited.
 * Body prefers TUR.output; model text may include XML wrappers.
 */

const SHORT_OUTPUT_CHARS = 2000

function formatWaitDetails(part, args, taskId, isDone) {
  if (!isDone) {
    const timeoutMs =
      typeof args.timeout === 'number'
        ? args.timeout
        : typeof args.block_until_ms === 'number'
          ? args.block_until_ms
          : null
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      const secs = Math.max(1, Math.round(timeoutMs / 1000))
      return `up to ${secs}s for shell`
    }
    return 'for shell'
  }

  const ms =
    typeof part.duration === 'number'
      ? part.duration
      : typeof part.durationMs === 'number'
        ? part.durationMs
        : null
  if (ms == null || ms < 500) return 'briefly'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

export default function TaskOutputCard({ part }) {
  const args = part.args || {}
  const tur = getTur(part)
  const taskId = tur?.task_id || args.task_id || args.shell_id || ''
  const result = typeof tur?.text === 'string' ? tur.text : part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      detectError(part.name || 'TaskOutput', result) ||
      (typeof result === 'string' && result.startsWith('Error:')) ||
      tur?.retrieval_status === 'timeout')

  const displayBody = useMemo(() => {
    if (typeof tur?.output === 'string') return tur.output
    if (typeof result !== 'string' || !result) return ''
    const out = result.match(/<output>\r?\n?([\s\S]*?)\r?\n?<\/output>/)
    return (out ? out[1] : result).replace(/^\n+|\n+$/g, '')
  }, [tur, result])

  const hasOutput = typeof displayBody === 'string' && displayBody.length > 0
  const shortSuccess =
    isDone && !isError && hasOutput && displayBody.length <= SHORT_OUTPUT_CHARS
  const retrieval = tur?.retrieval_status ?? null
  const taskStatus = tur?.task_status ?? null

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('default', {
    isDone,
    isError,
    hasBody: true,
    forceExpandOnce: isDone && (isError || shortSuccess),
  })

  const action = toolActionLabel('await', {
    loading: !isDone,
    hasError: isError,
  })
  const rawDetails = formatWaitDetails(part, args, taskId, isDone)
  const details = isError ? toolErrorDetails(rawDetails, true) : rawDetails

  const titleTooltip = [
    taskId,
    taskStatus ? `status: ${taskStatus}` : null,
    retrieval ? `retrieval: ${retrieval}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <ToolChrome
      variant='task-output-card'
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={toggleExpanded}
      hasBody
      showChevron={chevron.showChevron}
      label={action}
      title={details || '…'}
      titlePlain
      titleTooltip={titleTooltip || details}
      duration={undefined}
      showSuccess={false}
    >
      {hasOutput && (
        <pre
          className={`tool-row-body ui-shell-tool-call__output ${isError ? 'tool-row-body--error' : ''}`}
        >
          {displayBody}
        </pre>
      )}
      {isDone && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </ToolChrome>
  )
}
