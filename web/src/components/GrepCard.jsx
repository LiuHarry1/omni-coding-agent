import { useMemo } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import { FileIcon } from './workspace-ide/icons.jsx'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import {
  fileName,
  shortDisplayPath,
  shortGlobPattern,
  truncateEnd,
} from '../lib/utils.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Grep — compact file hit list.
 * files_with_matches: filename + `dir -- N matches`
 * content: path header + match/context lines (path + line + snippet)
 */

function splitPathParts(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/')
  const base = fileName(norm) || norm
  const dir = norm.includes('/')
    ? norm.slice(0, norm.length - base.length).replace(/\/$/, '')
    : ''
  return { base, dir, full: norm }
}

/**
 * Parse one ripgrep content line (match `:` or context `-`).
 *   path:line:text | path:line-text | line:text | line-text
 */
function parseRgContentLine(raw, fallbackPath) {
  if (!raw || raw === '--') return null
  if (raw.startsWith('[Showing results with pagination')) return null
  if (raw === 'No matches found') return null

  const m = raw.match(/^(?:(.+?):)?(\d+)([:-])(.*)$/)
  if (!m) return null
  const filePath = m[1] || fallbackPath || '(file)'
  return {
    file: filePath,
    lineNo: m[2],
    kind: m[3] === ':' ? 'match' : 'context',
    text: m[4] ?? '',
  }
}

function parseContentLines(content, fallbackPath) {
  const groups = new Map()
  if (!content || content === 'No matches found') return []
  for (const raw of content.split('\n')) {
    const row = parseRgContentLine(raw, fallbackPath)
    if (!row) continue
    if (!groups.has(row.file)) groups.set(row.file, [])
    groups.get(row.file).push(row)
  }
  return [...groups.entries()].map(([file, matches]) => ({ file, matches }))
}

function fromToolUseResult(toolUseResult) {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null
  if (
    !Array.isArray(toolUseResult.filenames) &&
    !Array.isArray(toolUseResult.files)
  ) {
    return null
  }
  const mode = toolUseResult.mode || 'files_with_matches'
  const files = Array.isArray(toolUseResult.files)
    ? toolUseResult.files
    : (toolUseResult.filenames || []).map(p => ({
        path: p,
        matchCount: 1,
      }))
  return {
    mode,
    files,
    numFiles: toolUseResult.numFiles ?? files.length,
    numMatches: toolUseResult.numMatches,
    numLines: toolUseResult.numLines,
    content: toolUseResult.content,
    empty:
      (toolUseResult.numFiles ?? files.length) === 0 &&
      !(toolUseResult.content && toolUseResult.content !== 'No matches found'),
  }
}

/** Secondary: `dir -- N matches` | `N matches` | `dir` */
function fileSecondary(dir, matchCount) {
  const n = typeof matchCount === 'number' ? matchCount : 0
  const matchPart = n > 0 ? `${n} ${n === 1 ? 'match' : 'matches'}` : null
  if (dir && matchPart) return `${dir} -- ${matchPart}`
  if (matchPart) return matchPart
  return dir || null
}

function GrepFileRow({ path: filePath, matchCount, onOpen }) {
  const { base, dir, full } = splitPathParts(filePath)
  const secondary = fileSecondary(dir, matchCount)
  const clickable = typeof onOpen === 'function'

  return (
    <li>
      <button
        type='button'
        className={`grep-file-row ${clickable ? 'grep-file-row--clickable' : ''}`}
        onClick={clickable ? () => onOpen(full) : undefined}
        title={full}
        disabled={!clickable}
      >
        <span className='grep-path'>
          <FileIcon size={12} />
          <span className='grep-file-name'>{base}</span>
          {secondary ? (
            <span className='grep-file-secondary'>{secondary}</span>
          ) : null}
        </span>
      </button>
    </li>
  )
}

function GrepContentGroup({ file, matches, onOpen }) {
  const { base, dir, full } = splitPathParts(file)
  const matchCount = matches.filter(m => m.kind === 'match').length
  const secondary = fileSecondary(dir, matchCount)
  const clickable = typeof onOpen === 'function'

  return (
    <li className='grep-content-group'>
      <button
        type='button'
        className={`grep-file-row ${clickable ? 'grep-file-row--clickable' : ''}`}
        onClick={clickable ? () => onOpen(full) : undefined}
        title={full}
        disabled={!clickable}
      >
        <span className='grep-path'>
          <FileIcon size={12} />
          <span className='grep-file-name'>{base}</span>
          {secondary ? (
            <span className='grep-file-secondary'>{secondary}</span>
          ) : null}
        </span>
      </button>
      <ul className='grep-match-lines'>
        {matches.map((row, i) => (
          <li
            key={`${row.lineNo}-${i}`}
            className={`grep-match-line grep-match-line--${row.kind}`}
            title={`${full}:${row.lineNo}`}
            onClick={
              clickable
                ? e => {
                    e.stopPropagation()
                    onOpen(full)
                  }
                : undefined
            }
          >
            <span className='grep-match-line-no'>{row.lineNo}</span>
            <span className='grep-match-text'>{row.text}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

export default function GrepCard({ part, nested = false }) {
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

  const contentGroups = useMemo(() => {
    if (!parsed || parsed.mode !== 'content') return []
    return parseContentLines(parsed.content, args.path)
  }, [parsed, args.path])

  /** Unified file-hit list for all modes. */
  const fileHits = useMemo(() => {
    if (!parsed || parsed.empty) return []
    if (parsed.mode === 'content') {
      return contentGroups.map(g => ({
        path: g.file,
        matchCount: g.matches.filter(m => m.kind === 'match').length,
      }))
    }
    return (parsed.files || []).map(f => ({
      path: f.path,
      matchCount: f.matchCount ?? 0,
    }))
  }, [parsed, contentGroups])

  const hasBody = isError || (!!parsed && (parsed.empty || fileHits.length > 0))

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand(
    'explore-line',
    { isDone, isError, nested, hasBody },
  )

  const pattern = args.pattern || ''
  const displayPattern = pattern ? truncateEnd(pattern, 44) : ''
  const filterBits = []
  const shortGlob = shortGlobPattern(args.glob)
  const shortPath =
    args.path && args.path !== '.' ? shortDisplayPath(args.path) : null
  if (shortPath) filterBits.push(`in ${shortPath}`)
  if (shortGlob) filterBits.push(shortGlob)
  if (args.type) filterBits.push(`type:${args.type}`)

  const filterTooltip = [
    args.glob && `glob: ${args.glob}`,
    args.type && `type: ${args.type}`,
    args.path && args.path !== '.' && `path: ${args.path}`,
  ]
    .filter(Boolean)
    .join('\n')

  let countLabel = null
  if (isDone && !isError && parsed && !parsed.empty && fileHits.length > 0) {
    const fileN = fileHits.length
    const matchN = fileHits.reduce((s, f) => s + (f.matchCount || 0), 0)
    if (matchN > 0) {
      countLabel = `${matchN} ${matchN === 1 ? 'match' : 'matches'} in ${fileN} ${fileN === 1 ? 'file' : 'files'}`
    } else {
      countLabel = `${fileN} ${fileN === 1 ? 'file' : 'files'}`
    }
  }

  const subtitle = filterBits.length > 0 ? filterBits.join(' \u00B7 ') : null
  const emptyHint = isDone && !isError && parsed?.empty ? 'No matches' : null

  const action = toolActionLabel('grep', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError
    ? toolErrorDetails(
        displayPattern ? `\u201C${displayPattern}\u201D` : 'grep\u2026',
        true,
      )
    : nested && displayPattern && shortPath
      ? `\u201C${displayPattern}\u201D in ${shortPath}`
      : displayPattern
        ? `\u201C${displayPattern}\u201D`
        : null

  const handleOpen = filePath => {
    if (typeof openFile !== 'function') return
    void openFile(filePath)
  }

  const isContentMode = parsed?.mode === 'content' && contentGroups.length > 0

  return (
    <ToolChrome
      variant='grep-card'
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
      titleTooltip={
        [pattern && `pattern: ${pattern}`, filterTooltip]
          .filter(Boolean)
          .join('\n') || undefined
      }
      subtitle={nested ? null : subtitle}
      subtitleTooltip={filterTooltip || undefined}
      meta={
        !nested && countLabel ? (
          <span className='grep-count-label'>{countLabel}</span>
        ) : null
      }
      duration={undefined}
      showSuccess={false}
      emptyHint={emptyHint}
      actions={
        expanded &&
        !nested &&
        isDone &&
        !isError &&
        typeof result === 'string' &&
        result.length > 0 ? (
          <CopyButton text={result} label='Copy' inline />
        ) : null
      }
    >
      {isDone && !isError && isContentMode && (
        <ul className='grep-results'>
          {contentGroups.map(g => (
            <GrepContentGroup
              key={g.file}
              file={g.file}
              matches={g.matches}
              onOpen={handleOpen}
            />
          ))}
        </ul>
      )}

      {isDone && !isError && !isContentMode && fileHits.length > 0 && (
        <ul className='grep-results'>
          {fileHits.map(f => (
            <GrepFileRow
              key={f.path}
              path={f.path}
              matchCount={f.matchCount}
              onOpen={handleOpen}
            />
          ))}
        </ul>
      )}

      {isDone && !isError && parsed?.empty && (
        <div className='grep-empty'>No matches</div>
      )}

      {isError && (
        <div className='tool-row-body tool-row-body--error'>{result}</div>
      )}
    </ToolChrome>
  )
}
