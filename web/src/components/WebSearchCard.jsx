import { useState, useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { parseMcpToolName } from '../lib/tool-kind.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Dedicated card for the `web_search` tool. Replaces the generic ToolCallCard's
 * `web_search {"query":"…","max_results":8}` JSON header with a query-first,
 * results-list-second layout for search-result rendering.
 *
 * Result-string shape (from src/tools/WebSearchTool/WebSearchTool.ts:execute):
 *   JSON.stringify({ query, source, totalResults, answers?, suggestions?,
 *                    results: [{ rank, title, url, snippet, engines? }] })
 * Truncated to MAX_OUTPUT_CHARS so the JSON may be a partial blob — we
 * still get the early results before the truncation cut.
 */

const PREVIEW_LIMIT = 3 // collapsed view shows N results; "more" reveals rest.

function parseResult(result) {
  if (typeof result !== 'string' || result.length === 0) return null
  if (result.startsWith('Error:')) return null
  // Tool truncates output — if the JSON is cut in half, try progressively
  // shorter prefixes ending at "}\n  ]" so we still recover the
  // already-completed result entries.
  try {
    return JSON.parse(result)
  } catch {
    // Fallback: find the last "  ]" before truncation cutoff and close it.
    const lastEntry = result.lastIndexOf('}\n    ')
    if (lastEntry > 0) {
      try {
        return JSON.parse(result.slice(0, lastEntry + 1) + '\n  ]\n}')
      } catch {
        /* give up */
      }
    }
    return null
  }
}

function hostname(url) {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

function ResultRow({ item }) {
  const host = hostname(item.url)
  return (
    <li className='web-search-result'>
      <a
        href={item.url}
        target='_blank'
        rel='noreferrer noopener'
        className='web-search-result-title'
        title={item.url}
        onClick={e => e.stopPropagation()}
      >
        {item.title || item.url || '(untitled)'}
      </a>
      {host && <div className='web-search-result-host'>{host}</div>}
      {item.snippet && (
        <div className='web-search-result-snippet'>{item.snippet}</div>
      )}
    </li>
  )
}

export default function WebSearchCard({ part, nested = false }) {
  const toolName = part.name || ''
  const { server: mcpServer } = parseMcpToolName(toolName)
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')

  const parsed = useMemo(() => {
    if (part.toolUseResult && typeof part.toolUseResult === 'object') {
      return part.toolUseResult
    }
    return parseResult(result)
  }, [part.toolUseResult, result])
  const results = Array.isArray(parsed?.results) ? parsed.results : []
  const answers = Array.isArray(parsed?.answers) ? parsed.answers : []
  const suggestions = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions
    : []

  const hasScannableBody =
    isError ||
    results.length > 0 ||
    answers.length > 0 ||
    (typeof result === 'string' && result.length > 0)

  // Explore density: stay collapsed when done; user opens for body / errors.
  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    'explore-line',
    {
      isDone,
      isError,
      nested,
      hasBody: hasScannableBody,
    },
  )
  const [showAll, setShowAll] = useState(false)

  const query = args.query || parsed?.query || ''
  const filter = []
  if (parsed?.provider === 'exa') filter.push('Exa')
  else if (parsed?.provider === 'searxng') filter.push('SearXNG')
  if (args.time_range) filter.push(args.time_range)
  if (args.language) filter.push(args.language)
  if (args.categories) filter.push(args.categories)

  const visibleResults = showAll ? results : results.slice(0, PREVIEW_LIMIT)

  // Surface the "no results" case explicitly with an ∅ glyph so a successful
  // empty search doesn't look identical to a successful populated one.
  const emptyHint =
    isDone && !isError && results.length === 0 ? 'No results' : null

  const action = toolActionLabel('webSearch', {
    loading: !isDone,
    hasError: isError,
  })
  const titleText = isError
    ? toolErrorDetails(query ? `\u201C${query}\u201D` : 'search\u2026', true)
    : query
      ? `\u201C${query}\u201D`
      : null

  return (
    <ToolChrome
      variant='web-search-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasScannableBody ? toggleExpanded : undefined}
      hasBody={hasScannableBody}
      showChevron={chevron.showChevron}
      label={action}
      title={titleText}
      titleTooltip={query}
      subtitle={
        filter.length > 0
          ? filter.join(' \u00B7 ')
          : mcpServer
            ? `via ${mcpServer}`
            : null
      }
      meta={
        isDone && results.length > 0 ? (
          <span className='web-search-meta'>
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        ) : null
      }
      duration={undefined}
      showSuccess={false}
      emptyHint={emptyHint}
      actions={
        expanded && isDone && !isError && typeof result === 'string' ? (
          <CopyButton text={result} label='Copy raw' inline />
        ) : null
      }
    >
      <div className='web-search-body'>
        {isError && <div className='web-search-error'>{result}</div>}
        {!isError && answers.length > 0 && (
          <div className='web-search-answers'>
            {answers.map((a, i) => (
              <div key={i} className='web-search-answer'>
                {'\u26A1'} {a}
              </div>
            ))}
          </div>
        )}
        {!isError && results.length > 0 && (
          <ol className='web-search-results'>
            {visibleResults.map((item, i) => (
              <ResultRow key={i} item={item} />
            ))}
          </ol>
        )}
        {!isError && !showAll && results.length > PREVIEW_LIMIT && (
          <button
            type='button'
            className='web-search-more'
            onClick={e => {
              e.stopPropagation()
              setShowAll(true)
            }}
          >
            Show all {results.length} results
          </button>
        )}
        {!isError && suggestions.length > 0 && (
          <div className='web-search-suggestions'>
            <span className='web-search-suggestions-label'>Related:</span>
            {suggestions.map((s, i) => (
              <span key={i} className='web-search-suggestion'>
                {s}
              </span>
            ))}
          </div>
        )}
        {!isError && parsed?.content && results.length === 0 && (
          <pre className='web-search-raw'>{parsed.content}</pre>
        )}
        {!isError &&
          isDone &&
          results.length === 0 &&
          parsed &&
          !parsed.content && (
            <div className='web-search-empty'>
              No results for {query ? `"${query}"` : 'this query'}.
            </div>
          )}
        {!isError && !parsed && isDone && (
          // Raw result couldn't be parsed as the documented JSON shape
          // (likely an MCP-provided search tool with different output).
          // Show the text verbatim rather than rendering nothing.
          <pre className='web-search-raw'>{result}</pre>
        )}
      </div>
    </ToolChrome>
  )
}
