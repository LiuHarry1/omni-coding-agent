import { useState, useEffect, useRef } from 'react'
import DiffViewer from './DiffViewer.jsx'
import FilePreview from './FilePreview.jsx'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import {
  fileName,
  formatDuration,
  formatBytes,
  shortDisplayPath,
} from '../lib/utils.js'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/**
 * File-centric card for Write / Edit (edit chrome):
 * verb + path + +/- counts, expandable preview/diff.
 * Done body prefers toolUseResult (TUR); running uses args + livePreview.
 */

function LivePreviewInline({ text, startTime }) {
  const ref = useRef(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  const bytes = text?.length ?? 0

  return (
    <div className='file-change-live'>
      <div className='file-change-live-meta'>
        Writing… {formatBytes(bytes)} · {elapsed}s
      </div>
      <pre className='file-change-live-code' ref={ref}>
        {text || ''}
      </pre>
    </div>
  )
}

/** LCS-style line add/remove counts for badge. */
function diffLineCounts(oldStr, newStr) {
  const a = (oldStr ?? '').split('\n')
  const b = (newStr ?? '').split('\n')
  const m = a.length
  const n = b.length
  // Cap for very large files — fall back to length delta.
  if (m * n > 400_000) {
    const removed = Math.max(0, m - n)
    const added = Math.max(0, n - m)
    return { added: added || (oldStr !== newStr ? 1 : 0), removed }
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const lcs = dp[m][n]
  return { added: n - lcs, removed: m - lcs }
}

function ChangeBadge({ kind, before, after, content }) {
  if (kind === 'write') {
    if (typeof before === 'string' && typeof after === 'string') {
      const { added, removed } = diffLineCounts(before, after)
      if (added === 0 && removed === 0) return null
      return (
        <span className='file-change-count'>
          {added > 0 && (
            <span className='file-change-count--add'>+{added}</span>
          )}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && (
            <span className='file-change-count--remove'>-{removed}</span>
          )}
        </span>
      )
    }
    const text = content ?? ''
    if (!text) return null
    const lines = text.split('\n').length
    const visible = text.endsWith('\n') ? lines - 1 : lines
    if (visible <= 0) return null
    return (
      <span className='file-change-count file-change-count--add'>
        +{visible}
      </span>
    )
  }
  if (kind === 'edit') {
    const { added, removed } = diffLineCounts(before ?? '', after ?? '')
    if (added === 0 && removed === 0) return null
    return (
      <span className='file-change-count'>
        {added > 0 && <span className='file-change-count--add'>+{added}</span>}
        {added > 0 && removed > 0 && ' '}
        {removed > 0 && (
          <span className='file-change-count--remove'>-{removed}</span>
        )}
      </span>
    )
  }
  return null
}

const ALWAYS_OPEN_LINE_THRESHOLD = 8
const COLLAPSED_PREVIEW_LINES = 4

function ContentPreview({ text }) {
  const lines = (text || '').split('\n').slice(0, COLLAPSED_PREVIEW_LINES)
  return <pre className='file-change-collapsed-preview'>{lines.join('\n')}</pre>
}

/** Prefer the changed region for collapsed teasers. */
function collapsedTeaserText({
  isWrite,
  args,
  beforeContent,
  afterContent,
  previewSource,
}) {
  if (!isWrite && typeof args?.new_string === 'string') return args.new_string
  if (
    typeof beforeContent === 'string' &&
    typeof afterContent === 'string' &&
    beforeContent !== afterContent
  ) {
    const a = beforeContent.split('\n')
    const b = afterContent.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    const slice = b.slice(i, i + COLLAPSED_PREVIEW_LINES)
    if (slice.length > 0) return slice.join('\n')
  }
  return previewSource
}

/** Finished call that never produced a valid file_path. */
function FileChangeStub({ name, result, duration, nested, verb }) {
  return (
    <div
      className={`file-change-stub ${nested ? 'file-change-stub--nested' : ''}`}
    >
      <div className='file-change-stub-row'>
        <span className='file-change-stub-verb'>{verb}</span>
        <span className='file-change-stub-name'>{name || 'tool_call'}</span>
        <span className='file-change-stub-label'>missing file_path</span>
        <span className='file-change-stub-spacer' />
        {duration && <span className='file-change-stub-meta'>{duration}</span>}
      </div>
      {typeof result === 'string' && (
        <div className='file-change-stub-error'>{result}</div>
      )}
    </div>
  )
}

export default function FileChangeCard({ part, nested = false }) {
  const name = part.name || ''
  const args = part.args || {}
  const tur = getTur(part)
  const result = part.result
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')
  const duration = formatDuration(part.duration)
  const filePath = tur?.filePath || args.file_path || args.path || null
  const isWrite = name === 'Write' || name === 'write_file'
  const kind = isWrite ? 'write' : 'edit'
  const writeType = tur?.type === 'update' ? 'update' : 'create'
  const isNewFile = isWrite && writeType !== 'update'
  const verb = toolActionLabel(isWrite ? 'write' : 'edit', {
    loading: !isDone,
    hasError: isError,
    isNewFile,
  })

  const hasLivePreview =
    !isDone &&
    typeof part.livePreview === 'string' &&
    part.livePreview.length > 0

  // Done: TUR before/after or write content. Running: args / live.
  const beforeContent =
    typeof tur?.beforeContent === 'string'
      ? tur.beforeContent
      : !isWrite && typeof args.old_string === 'string'
        ? args.old_string
        : undefined
  const afterContent =
    typeof tur?.afterContent === 'string'
      ? tur.afterContent
      : typeof tur?.content === 'string'
        ? tur.content
        : !isWrite && typeof args.new_string === 'string'
          ? args.new_string
          : isWrite && typeof args.content === 'string'
            ? args.content
            : undefined

  const hasTurBody =
    isDone &&
    !isError &&
    (typeof tur?.beforeContent === 'string' ||
      typeof tur?.afterContent === 'string' ||
      typeof tur?.content === 'string')
  const hasArgsContent =
    (isWrite
      ? typeof args.content === 'string' && args.content.length > 0
      : false) ||
    (!isWrite &&
      (typeof args.new_string === 'string' ||
        typeof args.old_string === 'string'))
  const hasAnythingToShow = hasLivePreview || hasArgsContent || hasTurBody

  const previewSource = hasLivePreview
    ? part.livePreview
    : afterContent || (isWrite ? args.content : args.new_string) || null
  const changedLineCount = previewSource
    ? (previewSource.match(/\n/g)?.length ?? 0) + 1
    : 0
  const shouldAutoExpand =
    !isDone ||
    hasLivePreview ||
    isError ||
    (!nested && changedLineCount <= ALWAYS_OPEN_LINE_THRESHOLD)
  const [expanded, setExpanded] = useState(shouldAutoExpand)
  const [userToggled, setUserToggled] = useState(false)
  useEffect(() => {
    if (!userToggled) setExpanded(shouldAutoExpand)
  }, [shouldAutoExpand, userToggled])

  if (!filePath && !hasAnythingToShow) {
    if (!isDone) {
      return (
        <ToolChrome
          variant='file-change-pending'
          nested={nested}
          isDone={false}
          hasBody={false}
          label={verb}
        />
      )
    }
    return (
      <FileChangeStub
        name={name}
        result={result}
        duration={duration}
        nested={nested}
        verb={verb}
      />
    )
  }

  const displayPath =
    (filePath && shortDisplayPath(filePath)) ||
    fileName(filePath) ||
    filePath ||
    (isDone ? '(missing file_path)' : null)

  let body = null
  let copyText = null
  let extraMeta = null
  if (hasLivePreview) {
    body = (
      <LivePreviewInline
        text={part.livePreview}
        startTime={part.liveInputStart}
      />
    )
  } else if (isDone && !isError && isWrite) {
    if (
      typeof beforeContent === 'string' &&
      typeof afterContent === 'string' &&
      beforeContent !== afterContent
    ) {
      body = (
        <DiffViewer
          oldStr={beforeContent}
          newStr={afterContent}
          filePath={filePath}
          embedded
        />
      )
      copyText = afterContent
    } else if (typeof afterContent === 'string') {
      body = <FilePreview content={afterContent} filePath={filePath} embedded />
      copyText = afterContent
      const lines = afterContent.split('\n')
      const visible = afterContent.endsWith('\n')
        ? lines.length - 1
        : lines.length
      extraMeta = `${visible} lines`
    }
  } else if (
    isDone &&
    !isError &&
    !isWrite &&
    typeof beforeContent === 'string' &&
    typeof afterContent === 'string'
  ) {
    body = (
      <DiffViewer
        oldStr={beforeContent}
        newStr={afterContent}
        filePath={filePath}
        replaceAll={args.replace_all}
        embedded
      />
    )
    copyText = afterContent
    if (tur?.replacements > 1 || args.replace_all) {
      extraMeta =
        tur?.replacements > 1
          ? `${tur.replacements} replacements`
          : 'replace all'
    }
  } else if (isWrite && typeof args.content === 'string') {
    body = <FilePreview content={args.content} filePath={filePath} embedded />
    copyText = args.content
  } else if (
    !isWrite &&
    typeof args.old_string === 'string' &&
    typeof args.new_string === 'string'
  ) {
    body = (
      <DiffViewer
        oldStr={args.old_string}
        newStr={args.new_string}
        filePath={filePath}
        replaceAll={args.replace_all}
        embedded
      />
    )
    copyText = args.new_string
  }

  const toggle = () => {
    setUserToggled(true)
    setExpanded(v => !v)
  }
  const onHeaderKeyDown = e => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }
  const stop = e => e.stopPropagation()

  return (
    <div
      className={`file-change-card file-change-card--${kind} ${isError ? 'has-error' : ''} ${nested ? 'file-change-card--nested' : ''}`}
    >
      <div
        role='button'
        tabIndex={0}
        className='file-change-header'
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
        aria-expanded={expanded}
      >
        <span
          className={`file-change-chevron ${expanded ? 'open' : ''}`}
          aria-hidden='true'
        >
          {'\u25B6'}
        </span>
        <span className='file-change-verb'>{verb}</span>
        <span className='file-change-name' title={filePath || ''}>
          {displayPath}
        </span>
        <ChangeBadge
          kind={kind}
          before={beforeContent}
          after={afterContent}
          content={afterContent}
        />
        {extraMeta && isDone && (
          <span className='file-change-extra-meta'>{extraMeta}</span>
        )}
        <span className='file-change-spacer' />
        {!isDone && part.liveInputBytes != null && !hasLivePreview && (
          <span className='file-change-progress'>
            {formatBytes(part.liveInputBytes)}
          </span>
        )}
        {duration && isDone && (
          <span className='file-change-duration'>{duration}</span>
        )}
        {isDone && copyText != null && (
          <span onClick={stop}>
            <CopyButton text={copyText} label='Copy' inline />
          </span>
        )}
        {isDone ? (
          isError ? null : (
            <span className='file-change-status file-change-status--ok'>
              {'\u2713'}
            </span>
          )
        ) : (
          <span className='spinner spinner-sm' />
        )}
      </div>

      {expanded && body && <div className='file-change-body'>{body}</div>}
      {!expanded && isDone && previewSource && (
        <div
          className='file-change-body file-change-body--truncated'
          onClick={toggle}
        >
          <ContentPreview
            text={collapsedTeaserText({
              isWrite,
              args,
              beforeContent,
              afterContent,
              previewSource,
            })}
          />
        </div>
      )}

      {isError && <div className='file-change-error'>{result}</div>}
    </div>
  )
}
