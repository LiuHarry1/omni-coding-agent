import { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { FileIcon } from './workspace-ide/icons.jsx'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import { fileName, shortDisplayPath, truncateEnd } from '../lib/utils.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Glob card — Searching/Searched files + clickable paths.
 */

function splitPathParts(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/')
  const base = fileName(norm) || norm
  const dir = norm.includes('/')
    ? norm.slice(0, norm.length - base.length).replace(/\/$/, '')
    : ''
  return { base, dir, full: norm }
}

function fromToolUseResult(tur) {
  if (!tur || typeof tur !== 'object') return null
  if (!Array.isArray(tur.filenames)) return null
  return {
    files: tur.filenames,
    truncated: !!tur.truncated,
    filteredCount: tur.filteredCount ?? 0,
    empty: tur.filenames.length === 0,
  }
}

export default function GlobCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    (part.isError === true ||
      (typeof result === 'string' && result.startsWith('Error:')))
  const openFile = useWorkspaceIdeStore(s => s.openFile)

  const parsed = useMemo(
    () => fromToolUseResult(part.toolUseResult),
    [part.toolUseResult],
  )

  const hasBody =
    isError || (!!parsed && (parsed.empty || parsed.files.length > 0))

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    'explore-line',
    { isDone, isError, nested, hasBody },
  )

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const searchPath = args.path && args.path !== '.' ? args.path : null
  const displayPath = searchPath ? shortDisplayPath(searchPath) : null

  const subtitleParts = []
  if (displayPath) subtitleParts.push(displayPath)
  if (isDone && !isError && parsed && parsed.files.length > 0) {
    subtitleParts.push(
      `${parsed.files.length}${parsed.truncated ? '+' : ''} ${parsed.files.length === 1 ? 'file' : 'files'}`,
    )
  }

  const emptyHint =
    isDone && !isError && parsed?.empty ? 'No files matched' : null

  const action = toolActionLabel('glob', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError
    ? toolErrorDetails(
        displayPattern ? `\u201C${displayPattern}\u201D` : 'glob\u2026',
        true,
      )
    : displayPattern
      ? `\u201C${displayPattern}\u201D`
      : null

  const handleOpen = filePath => {
    if (typeof openFile !== 'function') return
    void openFile(filePath)
  }

  return (
    <ToolChrome
      variant='glob-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      label={action}
      title={title}
      titlePlain
      titleTooltip={pattern}
      subtitle={
        subtitleParts.length > 0 ? subtitleParts.join(' \u00B7 ') : null
      }
      subtitleTooltip={searchPath || undefined}
      duration={undefined}
      showSuccess={false}
      emptyHint={emptyHint}
      actions={
        expanded &&
        !nested &&
        isDone &&
        !isError &&
        parsed &&
        parsed.files.length > 0 ? (
          <CopyButton text={parsed.files.join('\n')} label='Copy' inline />
        ) : null
      }
    >
      {isDone && !isError && parsed && parsed.files.length > 0 && (
        <ul className='grep-results'>
          {parsed.files.map(f => {
            const parts = splitPathParts(f)
            return (
              <li key={f}>
                <button
                  type='button'
                  className='grep-file-row grep-file-row--clickable'
                  onClick={() => handleOpen(parts.full)}
                  title={parts.full}
                >
                  <span className='grep-path'>
                    <FileIcon size={12} />
                    <span className='grep-file-name'>{parts.base}</span>
                    {parts.dir ? (
                      <span className='grep-file-dir'>{parts.dir}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
          {parsed.truncated && (
            <li className='glob-file-truncated'>
              Results truncated — narrow the pattern or path for more.
            </li>
          )}
        </ul>
      )}

      {isDone && !isError && parsed?.empty && (
        <div className='grep-empty'>No files matched</div>
      )}

      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </ToolChrome>
  )
}
