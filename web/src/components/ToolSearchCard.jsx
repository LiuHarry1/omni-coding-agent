import ToolChrome from './ToolChrome.jsx'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Compact row for ToolSearch — prefers TUR.matches list over model text dump.
 */
export default function ToolSearchCard({ part, nested = false }) {
  const args = part.args || {}
  const tur = getTur(part)
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const query =
    (typeof tur?.query === 'string' ? tur.query : null) ||
    (typeof args.query === 'string' ? args.query : '') ||
    ''
  const matches = Array.isArray(tur?.matches) ? tur.matches : null
  const hasMatches = matches && matches.length > 0
  // `select:Foo,Bar` is wire syntax, not something worth showing verbatim.
  const queryLabel = query.replace(/^select:/i, '').replace(/,\s*/g, ', ')
  const summary = hasMatches ? matches.map(m => m.name).join(', ') : queryLabel
  const hasTextFallback =
    !hasMatches && typeof result === 'string' && result.trim()
  const hasBody = isError || hasMatches || hasTextFallback

  // Suppressed from transcript normally; if shown, explore-line density.
  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    'explore-line',
    { isDone, isError, nested, hasBody },
  )

  const action = toolActionLabel('toolSearch', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError
    ? toolErrorDetails(queryLabel || 'ToolSearch\u2026', true)
    : summary || 'ToolSearch\u2026'

  return (
    <ToolChrome
      variant='tool-search-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      label={action}
      title={title}
      titleTooltip={query || undefined}
      duration={undefined}
      showSuccess={false}
    >
      {isDone && !isError && hasMatches && (
        <ul className='tool-row-body tool-search-matches'>
          {matches.map(m => (
            <li key={m.name}>
              <strong>{m.name}</strong>
              {m.description ? ` — ${m.description}` : ''}
            </li>
          ))}
        </ul>
      )}
      {isDone && !isError && !hasMatches && hasTextFallback && (
        <pre className='tool-row-body'>{result}</pre>
      )}
      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </ToolChrome>
  )
}
