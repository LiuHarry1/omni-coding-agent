import { useEffect, useMemo, useState } from 'react'
import CopyButton from './CopyButton.jsx'
import ToolChrome from './ToolChrome.jsx'
import LiveTerminal from './LiveTerminal.jsx'
import { detectError } from '../lib/utils.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import { useChatActions } from '../lib/chat-actions.jsx'
import { getTur } from '../lib/tool-result.js'
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'
import { shellCommandNames } from '../lib/shell-command-names.js'

/**
 * Shell tool card (`ui-shell-tool-call`):
 *   action: Running | Ran | Run(error) | Shell(backgrounded)
 *   details: description ?? program names ("cd, git") ?? "command"
 * Done body prefers TUR stdout/stderr; model `text` may include wrappers.
 */

const PREVIEW_LINES = 5
const PREVIEW_CHARS = 2000
const BG_NUDGE_MS = 5000

function parseBackgroundTaskId(part) {
  const tur = getTur(part)
  if (typeof tur?.backgroundTaskId === 'string' && tur.backgroundTaskId) {
    return tur.backgroundTaskId
  }
  const text =
    typeof tur?.text === 'string'
      ? tur.text
      : typeof part.result === 'string'
        ? part.result
        : ''
  const m =
    text.match(/background with ID:\s*([a-z0-9]+)/i) ||
    text.match(/task_id:\s*([a-z0-9]+)/i)
  return m ? m[1] : null
}

const OUTCOMES = ['success', 'failure', 'timeout', 'aborted', 'spawnError']

/** Sharper wording than a blanket "attempted", per outcome. */
const OUTCOME_DETAILS = {
  timeout: 'timed out',
  aborted: 'stopped',
  spawnError: 'failed to start',
}

/** Discrete server-side outcome; absent on sessions recorded before it existed. */
function shellOutcome(tur) {
  return OUTCOMES.includes(tur?.outcome) ? tur.outcome : null
}

/** Build display body from TUR fields; strip model wrappers. */
function shellDisplayParts(part) {
  const tur = getTur(part)
  const outcome = shellOutcome(tur)
  if (tur) {
    const stdout = typeof tur.stdout === 'string' ? tur.stdout : ''
    const stderr = typeof tur.stderr === 'string' ? tur.stderr : ''
    const exitCode = tur.exitCode
    if (stdout || stderr || exitCode != null) {
      return { stdout, stderr, exitCode, textFallback: null, outcome }
    }
    if (typeof tur.text === 'string') {
      return {
        stdout: '',
        stderr: '',
        exitCode: null,
        textFallback: tur.text,
        outcome,
      }
    }
  }
  if (typeof part.result === 'string') {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      textFallback: part.result,
      outcome,
    }
  }
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    textFallback: null,
    outcome,
  }
}

/** First-pass truncate (~5 lines / 2k chars). */
function truncateShellText(text) {
  if (typeof text !== 'string' || !text) {
    return { preview: '', truncated: false }
  }
  const lines = text.split('\n')
  let preview = text
  let truncated = false
  if (lines.length > PREVIEW_LINES) {
    preview = lines.slice(0, PREVIEW_LINES).join('\n')
    truncated = true
  }
  if (preview.length > PREVIEW_CHARS) {
    preview = preview.slice(0, PREVIEW_CHARS)
    truncated = true
  }
  return { preview, truncated }
}

function StopIcon() {
  return (
    <svg
      className='ui-shell-tool-call__stop-icon'
      width='10'
      height='10'
      viewBox='0 0 10 10'
      aria-hidden='true'
    >
      <rect x='1.5' y='1.5' width='7' height='7' rx='1' fill='currentColor' />
    </svg>
  )
}

export default function BashCard({ part, onStopTool }) {
  const { stopTool } = useChatActions()
  const stop = onStopTool ?? stopTool
  const args = part.args || {}
  const tur = getTur(part)
  const display = shellDisplayParts(part)
  const isDone = part.status === 'done'
  const modelText =
    typeof tur?.text === 'string'
      ? tur.text
      : typeof part.result === 'string'
        ? part.result
        : ''
  // Sessions recorded before `outcome` existed fall back to the old heuristics
  // so their history keeps reading correctly.
  const legacyFailed =
    part.isError === true ||
    tur?.interrupted === true ||
    (typeof display.exitCode === 'number' && display.exitCode !== 0) ||
    detectError(part.name || 'Bash', modelText)
  const failed =
    isDone && (display.outcome ? display.outcome !== 'success' : legacyFailed)

  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  const description =
    typeof args?.description === 'string' ? args.description.trim() : ''
  // Prefer description; else the program names — never the raw command line
  // (the label supplies the verb).
  const rawDetails =
    description || shellCommandNames(command).join(', ') || 'command'
  // Without a description, a failure the server can name (timed out,
  // stopped) says so instead of listing programs.
  const outcomeDetails =
    failed && !description ? OUTCOME_DETAILS[display.outcome] : undefined
  const details = outcomeDetails ?? toolErrorDetails(rawDetails, failed)

  const wantsBackground = !!args.run_in_background
  const backgroundTaskId =
    isDone && !failed ? parseBackgroundTaskId(part) : null
  const isBackgrounded =
    !!backgroundTaskId ||
    tur?.backgrounded === true ||
    (wantsBackground && isDone && !failed)

  const action = toolActionLabel('shell', {
    loading: !isDone,
    hasError: failed,
    backgrounded: isBackgrounded,
  })

  const hasStructured =
    Boolean(display.stdout) ||
    Boolean(display.stderr) ||
    (display.exitCode != null && display.exitCode !== 0)
  const hasFallback =
    typeof display.textFallback === 'string' && display.textFallback.length > 0
  const hasOutput = hasStructured || hasFallback
  const hasLiveOutput = part.liveOutput != null
  const isRunning = !isDone

  const copyText = hasStructured
    ? [display.stdout, display.stderr ? `stderr:\n${display.stderr}` : '']
        .filter(Boolean)
        .join('\n')
    : display.textFallback || ''

  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('shell', {
    isDone,
    isError: failed,
    hasBody: hasOutput || hasLiveOutput || failed,
    hasLiveOutput,
    isBackgrounded: isBackgrounded || wantsBackground,
  })
  const [showFullOutput, setShowFullOutput] = useState(false)
  const [showBgNudge, setShowBgNudge] = useState(false)

  useEffect(() => {
    if (isDone || wantsBackground || isBackgrounded) {
      setShowBgNudge(false)
      return
    }
    const t = setTimeout(() => setShowBgNudge(true), BG_NUDGE_MS)
    return () => clearTimeout(t)
  }, [isDone, wantsBackground, isBackgrounded, part.toolCallId])

  const stdoutTrunc = useMemo(
    () => truncateShellText(display.stdout),
    [display.stdout],
  )
  const stderrTrunc = useMemo(
    () => truncateShellText(display.stderr),
    [display.stderr],
  )
  const fallbackTrunc = useMemo(
    () => truncateShellText(display.textFallback || ''),
    [display.textFallback],
  )
  const anyTruncated =
    stdoutTrunc.truncated || stderrTrunc.truncated || fallbackTrunc.truncated

  const showLive = expanded && hasLiveOutput && !isDone && !wantsBackground
  const showFinal = expanded && isDone && !isBackgrounded
  const titleTooltip =
    description && command && description !== command
      ? `${description}\n${command}`
      : command || details

  const onStop = e => {
    e.stopPropagation()
    if (isDone || part.stopping || !part.toolCallId) return
    void stop(part.toolCallId)
  }

  const exitBadge =
    isDone && display.exitCode != null && display.exitCode !== 0 ? (
      <span className='tool-row-meta-badge' title='Exit code'>
        exit {display.exitCode}
      </span>
    ) : null

  const nudgeBadge =
    showBgNudge && isRunning ? (
      <span
        className='ui-shell-tool-call__bg-nudge'
        title='Long-running — set run_in_background on the next Shell call'
      >
        Run in background?
      </span>
    ) : null

  return (
    <ToolChrome
      variant='bash-card'
      className={[
        'ui-shell-tool-call',
        isRunning ? 'ui-shell-tool-call--pending' : '',
        isRunning ? 'ui-shell-tool-call--with-stop' : '',
        !isBackgrounded && (hasOutput || hasLiveOutput)
          ? 'ui-shell-tool-call--expandable'
          : '',
        isBackgrounded ? 'ui-shell-tool-call--backgrounded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      isDone={isDone}
      expanded={expanded}
      onToggle={isBackgrounded ? undefined : toggleExpanded}
      hasBody={!isBackgrounded}
      showChevron={chevron.showChevron}
      bodyOpen={showLive || showFinal}
      label={action}
      title={details}
      titlePlain
      titleTooltip={titleTooltip}
      subtitle={
        !isDone && part.liveElapsed != null ? `${part.liveElapsed}s` : null
      }
      meta={
        <>
          {nudgeBadge}
          {exitBadge}
        </>
      }
      duration={isBackgrounded ? undefined : part.duration}
      showSuccess={isDone && !failed && !isBackgrounded}
      actions={
        <>
          {!isDone && part.toolCallId && (
            <button
              type='button'
              className='subagent-stop-btn ui-shell-tool-call__glass-stop'
              onClick={onStop}
              disabled={!!part.stopping}
              aria-label='Stop command'
              title={part.stopping ? 'Stopping…' : 'Stop'}
            >
              {part.stopping ? (
                <span className='ui-shell-tool-call__stop-label'>…</span>
              ) : (
                <StopIcon />
              )}
            </button>
          )}
          {isDone && hasOutput && !isBackgrounded ? (
            <CopyButton text={copyText} label='Copy output' inline />
          ) : null}
          {isDone && command ? (
            <CopyButton text={command} label='Copy command' inline />
          ) : null}
        </>
      }
    >
      {showLive && (
        <LiveTerminal
          output={part.liveOutput}
          elapsed={part.liveElapsed}
          done={false}
        />
      )}

      {showFinal && hasStructured && (
        <div className='ui-shell-tool-call__streams'>
          {display.stdout ? (
            <pre
              className={`tool-row-body ui-shell-tool-call__output ${showFullOutput ? 'ui-shell-tool-call__output--full' : ''}`}
            >
              {showFullOutput ? display.stdout : stdoutTrunc.preview}
              {!showFullOutput && stdoutTrunc.truncated ? '\n…' : ''}
            </pre>
          ) : null}
          {display.stderr ? (
            <pre
              className={`tool-row-body tool-row-body--stderr ui-shell-tool-call__stderr ${showFullOutput ? 'ui-shell-tool-call__output--full' : ''}`}
            >
              {showFullOutput ? display.stderr : stderrTrunc.preview}
              {!showFullOutput && stderrTrunc.truncated ? '\n…' : ''}
            </pre>
          ) : null}
          {!display.stdout && !display.stderr && (
            <div className='tool-row-empty'>(no output)</div>
          )}
          {anyTruncated && (
            <button
              type='button'
              className='ui-shell-tool-call__more'
              onClick={e => {
                e.stopPropagation()
                setShowFullOutput(v => !v)
              }}
            >
              {showFullOutput ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {showFinal && !hasStructured && hasFallback && (
        <>
          <pre
            className={`tool-row-body ui-shell-tool-call__output ${showFullOutput ? 'ui-shell-tool-call__output--full' : ''}`}
          >
            {showFullOutput ? display.textFallback : fallbackTrunc.preview}
            {!showFullOutput && fallbackTrunc.truncated ? '\n…' : ''}
          </pre>
          {fallbackTrunc.truncated && (
            <button
              type='button'
              className='ui-shell-tool-call__more'
              onClick={e => {
                e.stopPropagation()
                setShowFullOutput(v => !v)
              }}
            >
              {showFullOutput ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {showFinal && !hasOutput && (
        <div className='tool-row-empty'>(no output)</div>
      )}
    </ToolChrome>
  )
}
