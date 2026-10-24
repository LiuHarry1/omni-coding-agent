import { useState, useRef, useEffect } from 'react'
import DiffViewer from './DiffViewer.jsx'
import FilePreview from './FilePreview.jsx'
import CopyButton from './CopyButton.jsx'
import LiveTerminal from './LiveTerminal.jsx'
import ToolChrome from './ToolChrome.jsx'
import { fileName, formatBytes, detectError } from '../lib/utils.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'

function formatArgs(name, args) {
  if (!args) return ''
  if (args.file_path) return args.file_path
  if (args.path) return args.path
  if (args.command) return args.command
  if ((name === 'Bash' || name === 'PowerShell') && args.pid != null) {
    return args.kill ? `kill pid ${args.pid}` : `check pid ${args.pid}`
  }
  if (args.task)
    return args.task.slice(0, 80) + (args.task.length > 80 ? '\u2026' : '')
  if (args.query) return args.query
  if (args.pattern) return args.pattern
  if (args.directory) return args.directory
  return JSON.stringify(args).slice(0, 80)
}

function hasArgsContent(args) {
  return args && typeof args === 'object' && Object.keys(args).length > 0
}

function renderToolArgs(name, args) {
  if (!hasArgsContent(args)) return null
  if (name === 'Edit' && args.old_string != null && args.new_string != null) {
    return (
      <DiffViewer
        oldStr={args.old_string}
        newStr={args.new_string}
        filePath={args.file_path}
        replaceAll={args.replace_all}
      />
    )
  }
  if (name === 'Write' && typeof args.content === 'string') {
    return <FilePreview content={args.content} filePath={args.file_path} />
  }
  const json = JSON.stringify(args, null, 2)
  return (
    <div className='tool-args-wrap'>
      <CopyButton text={json} />
      <pre className='tool-args-json'>{json}</pre>
    </div>
  )
}

function StreamingArgs({ bytes, startTime }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0

  return (
    <div className='tool-streaming-input'>
      <span className='spinner spinner-sm' />
      <span className='tool-streaming-input-label'>
        Generating arguments… {formatBytes(bytes)} ({elapsed}s)
      </span>
    </div>
  )
}

function LivePreview({ text, fileName: fname, startTime }) {
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
    <div className='live-terminal live-preview'>
      <div className='live-terminal-header'>
        <span className='live-terminal-dot' />
        <span className='live-terminal-title'>
          {fname ? `Writing ${fname}…` : 'Writing…'}
        </span>
        <span className='live-preview-meta'>
          {formatBytes(bytes)} · {elapsed}s
        </span>
        <span className='spinner spinner-sm' />
      </div>
      <pre className='live-terminal-output' ref={ref}>
        {text || '(waiting…)'}
      </pre>
    </div>
  )
}

/**
 * Fallback tool UI when no specialized card exists.
 * Uses ToolChrome / ToolCallLine (default line chrome) — same shell as
 * Read/Grep/Bash rather than the legacy bordered `.tool-card`.
 */
export default function ToolCallCard({ part, nested = false }) {
  const hasLiveOutput = part.liveOutput != null
  const name = part.name || ''
  const args = part.args || {}
  const result = part.result
  const isError = detectError(name, result)
  const isDone = part.status === 'done'
  const hasLivePreview =
    !isDone &&
    typeof part.livePreview === 'string' &&
    part.livePreview.length > 0

  const isStreaming = !isDone || hasLiveOutput || hasLivePreview
  const truncLen = 3000
  const isLong = result && result.length > truncLen
  const [showFull, setShowFull] = useState(false)
  const displayResult = isLong && !showFull ? result.slice(0, truncLen) : result

  const filePath = args.file_path || args.path || null
  const fName = fileName(filePath)
  const argsPreview = formatArgs(name, args)
  const showArgsDetails = hasArgsContent(args) || hasLivePreview
  const showResultDetails = result != null && result !== ''
  const hasBody =
    showArgsDetails ||
    showResultDetails ||
    hasLivePreview ||
    hasLiveOutput ||
    (!isDone && part.liveInputBytes != null)

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('default', {
    isDone,
    isError: isDone && isError,
    nested,
    hasBody,
    isRunning: isStreaming,
  })

  const action = name || 'Tool'
  const title = fName || argsPreview || null

  return (
    <ToolChrome
      variant='tool-call-card'
      nested={nested}
      isError={isDone && isError}
      isDone={isDone}
      expanded={expanded}
      onToggle={hasBody ? toggleExpanded : undefined}
      hasBody={hasBody}
      showChevron={chevron.showChevron}
      label={action}
      title={title}
      titleTooltip={filePath || argsPreview || name}
      meta={
        !isDone && part.liveInputBytes != null ? (
          <span className='tool-row-meta-badge' title='Args size'>
            {formatBytes(part.liveInputBytes)}
          </span>
        ) : null
      }
      duration={undefined}
      showSuccess={false}
      actions={
        expanded && isDone && showResultDetails ? (
          <CopyButton text={result} label='Copy' inline />
        ) : null
      }
    >
      {hasLivePreview ? (
        <LivePreview
          text={part.livePreview}
          fileName={fName}
          startTime={part.liveInputStart}
        />
      ) : (
        !isDone &&
        part.liveInputBytes != null && (
          <StreamingArgs
            bytes={part.liveInputBytes}
            startTime={part.liveInputStart}
          />
        )
      )}

      {hasLiveOutput && !isDone && (
        <LiveTerminal
          output={part.liveOutput}
          elapsed={part.liveElapsed}
          done={part.liveDone}
        />
      )}

      {showArgsDetails && isDone && (
        <div className='tool-row-body tool-call-card__args'>
          {renderToolArgs(name, args)}
        </div>
      )}

      {showResultDetails && isDone && (
        <div
          className={`tool-row-body ${isError ? 'tool-row-body--error' : ''}`}
        >
          <pre className='tool-result-pre'>{displayResult}</pre>
          {isLong && (
            <button
              type='button'
              className='show-more-btn'
              onClick={e => {
                e.stopPropagation()
                setShowFull(!showFull)
              }}
            >
              {showFull
                ? 'Show less'
                : `Show all (${formatBytes(result.length)})`}
            </button>
          )}
        </div>
      )}
    </ToolChrome>
  )
}
