import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'

/**
 * list_dir row — explore-line density: collapsed one-liner; body on demand.
 */

function parseFileCount(result) {
  if (typeof result !== 'string') return null
  const m = result.match(/\((\d+)\s+files?\)\s*$/)
  return m ? +m[1] : null
}

export default function ListDirCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const dirPath = args.dir_path || args.path || (isDone ? '.' : null)
  const depth = args.depth
  const ignore =
    Array.isArray(args.ignore) && args.ignore.length > 0 ? args.ignore : null
  const fileCount = isDone && !isError ? parseFileCount(result) : null

  const meta = []
  if (depth != null) meta.push(`depth ${depth}`)
  if (ignore) meta.push(`ignore ${ignore.length}`)
  if (fileCount != null) meta.push(`${fileCount} files`)

  const subtitle = meta.length > 0 ? meta.join(' \u00B7 ') : null
  const hasBody = isDone && typeof result === 'string'

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    'explore-line',
    { isDone, isError, nested, hasBody },
  )

  return (
    <ToolChrome
      variant='read-file-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      label='LS'
      title={dirPath}
      titleTooltip={dirPath}
      titlePlain
      subtitle={subtitle}
      duration={undefined}
      showSuccess={false}
      actions={
        expanded && isDone && !isError && typeof result === 'string' ? (
          <CopyButton text={result} label='Copy' inline />
        ) : null
      }
    >
      {isDone && !isError && typeof result === 'string' && (
        <pre className='tool-row-body'>{result}</pre>
      )}
      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </ToolChrome>
  )
}
