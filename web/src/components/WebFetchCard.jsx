import { useState, useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { formatBytes } from '../lib/utils.js'
import { parseMcpToolName } from '../lib/tool-kind.js'
import { normalizeFetchResult, compactFetchError } from '../lib/fetch-result.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Dedicated card for URL-fetch tools:
 * - built-in `WebFetch` (processed `result` text + HTTP status/size chrome)
 * - MCP fetch tools like `mcp_server_fetch` (markdown / content blocks)
 *
 * Show a compact row (action + URL/title), not
 * `tool_name {"url":…}` plus an empty Arguments panel.
 */

const PREVIEW_CHARS = 600

function hostname(url) {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Compact URL for the header: `thepaper.cn/newsDetail_forward_…` */
function urlHeadline(url) {
  if (typeof url !== 'string') return '…'
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const path = (u.pathname + u.search).replace(/\/$/, '') || ''
    if (!path || path === '/') return host
    const full = `${host}${path}`
    return full.length > 72 ? `${full.slice(0, 69)}…` : full
  } catch {
    return url.length > 72 ? `${url.slice(0, 69)}…` : url
  }
}

export default function WebFetchCard({ part, nested = false }) {
  const toolName = part.name || ''
  const args = part.args || {}
  const result = part.result
  const requestUrl = args.url || ''
  const isDone = part.status === 'done'

  const { server: mcpServer } = parseMcpToolName(toolName)

  const normalized = useMemo(() => {
    const tur = part.toolUseResult
    if (tur && typeof tur === 'object') {
      // Built-in WebFetch: { bytes, code, codeText, result, durationMs, url }
      if (typeof tur.result === 'string') {
        return {
          text: tur.result,
          title: '',
          url: tur.url || requestUrl,
          bytes: tur.bytes,
          code: tur.code,
          codeText: tur.codeText,
          error: undefined,
        }
      }
      // Article payload from sessions predating the plain-text output
      return {
        text: tur.text || '',
        title: tur.title || '',
        excerpt: tur.excerpt,
        url: tur.url || requestUrl,
        note: tur.note,
        error: undefined,
      }
    }
    return normalizeFetchResult(result, requestUrl)
  }, [part.toolUseResult, result, requestUrl])

  const isError = isDone && Boolean(normalized.error)
  const articleUrl = normalized.url || requestUrl
  const text = normalized.text || ''
  const title = normalized.title || ''
  const host = hostname(articleUrl)

  const hasScannableBody =
    isError ||
    Boolean(text) ||
    Boolean(normalized.excerpt) ||
    Boolean(normalized.note)

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
  const [showFull, setShowAll] = useState(false)

  const headline = isDone && title ? title : urlHeadline(articleUrl)
  const subtitle =
    isDone && title && host ? host : mcpServer ? `via ${mcpServer}` : null

  const previewText = showFull ? text : text.slice(0, PREVIEW_CHARS)
  const hasMore = text.length > PREVIEW_CHARS
  const resultSize =
    text.length || (typeof result === 'string' ? result.length : 0)
  // Fetched size + HTTP status, as `Received 12.3KB (200 OK)`
  const fetchedBytes =
    typeof normalized.bytes === 'number' ? normalized.bytes : 0
  const httpStatus =
    normalized.code != null
      ? `${normalized.code} ${normalized.codeText || ''}`.trim()
      : ''

  const action = toolActionLabel('webFetch', {
    loading: !isDone,
    hasError: isError,
  })
  const titleText = isError ? toolErrorDetails(headline, true) : headline

  return (
    <ToolChrome
      variant='web-fetch-card'
      nested={nested}
      isError={isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasScannableBody ? toggleExpanded : undefined}
      hasBody={hasScannableBody}
      showChevron={chevron.showChevron}
      label={action}
      title={titleText}
      titleTooltip={articleUrl || requestUrl}
      subtitle={subtitle}
      meta={
        isDone && (fetchedBytes > 0 || resultSize > 0) ? (
          <span className='web-fetch-meta'>
            {formatBytes(fetchedBytes || resultSize)}
            {httpStatus ? ` (${httpStatus})` : ''}
          </span>
        ) : null
      }
      duration={undefined}
      showSuccess={false}
      actions={
        expanded && isDone && !isError && text ? (
          <CopyButton text={text} label='Copy' inline />
        ) : null
      }
    >
      <div className='web-fetch-body'>
        {isError && (
          <div className='web-fetch-error'>
            {compactFetchError(normalized.error, articleUrl || requestUrl)}
          </div>
        )}

        {!isError && articleUrl && (
          <a
            href={articleUrl}
            target='_blank'
            rel='noreferrer noopener'
            className='web-fetch-link'
            title={articleUrl}
            onClick={e => e.stopPropagation()}
          >
            {urlHeadline(articleUrl)}
          </a>
        )}

        {!isError && normalized.excerpt && (
          <div className='web-fetch-excerpt'>{normalized.excerpt}</div>
        )}

        {!isError && normalized.note && (
          <div className='web-fetch-note'>{normalized.note}</div>
        )}

        {!isError && text && (
          <div className='web-fetch-text'>
            {previewText}
            {hasMore && !showFull ? '…' : ''}
          </div>
        )}

        {!isError && hasMore && (
          <button
            type='button'
            className='web-fetch-more'
            onClick={e => {
              e.stopPropagation()
              setShowAll(v => !v)
            }}
          >
            {showFull ? 'Show less' : `Show full (${formatBytes(text.length)})`}
          </button>
        )}

        {!isError && !text && isDone && typeof result === 'string' && (
          <pre className='web-fetch-raw'>{result}</pre>
        )}

        {!isError && !isDone && (
          <div className='web-fetch-loading'>
            <span className='spinner spinner-sm' />
            Fetching…
          </div>
        )}
      </div>
    </ToolChrome>
  )
}
