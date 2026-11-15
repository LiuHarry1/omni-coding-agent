/**
 * What a subagent call shows: its type, how it ended, which agent it was,
 * and the conversation it had. Pure — the card and the agent's tab render
 * what these return.
 */

import { expandFoldableSegment } from './bubbles/flat-elements.js'
import { liveToolSubtitle, pickLiveMember } from './tool-density.js'
import { SUPPRESSED_TOOL_CARDS, SUBAGENT_SUPPRESSED } from './tool-names.js'

/**
 * The agent type as the card names it: `Explore` → `Explorer`, and any
 * other in title case — `general-purpose` → `General Purpose`,
 * `codeReviewer` → `Code Reviewer`. Empty when the type is not known.
 */
export function subagentTypeLabel(subagentType) {
  const type = typeof subagentType === 'string' ? subagentType.trim() : ''
  if (!type) return ''
  if (type.toLowerCase() === 'explore') return 'Explorer'
  return type
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

const BACKGROUND_PREFIX = 'Async agent launched'
const STOPPED_TEXT = 'Error: Subagent stopped by user.'
/** What a call cut off with its turn is left holding. */
const INTERRUPTED_TEXTS = [
  'Interrupted by user',
  '[Request interrupted by user',
]
/** The line the model reads to continue the agent; not part of the report. */
const RESUME_HINT =
  /\n\nagentId: ([A-Za-z0-9_-]+) \(use \S+ with this id to continue this agent with its full context\)\s*$/
const BACKGROUND_AGENT_ID =
  /^Async agent launched[^\n]*\nagentId: ([A-Za-z0-9_-]+) /
const AGENT_ID = /^[A-Za-z0-9_-]+$/
const OUTCOMES = new Set(['completed', 'stopped', 'error', 'background'])

const resultText = part => (typeof part?.result === 'string' ? part.result : '')

/**
 * The call returned at once because the agent was sent to the background.
 * Its result is a note for the model, not a report; the report arrives
 * later as a task notification.
 */
export function isBackgroundLaunch(part) {
  return subagentOutcome(part) === 'background'
}

/**
 * How the call stands: `running`, or how it ended — `completed`, `stopped`
 * (by the user), `error`, or `background` (it only launched the agent).
 *
 * The server says so in the tool result. Sessions saved before it did are
 * read off the result text.
 */
export function subagentOutcome(part) {
  if (!part || part.status !== 'done') return 'running'
  const stated = part.toolUseResult?.status
  if (OUTCOMES.has(stated)) return stated
  const text = resultText(part)
  if (text.startsWith(BACKGROUND_PREFIX)) return 'background'
  if (text.startsWith(STOPPED_TEXT)) return 'stopped'
  if (INTERRUPTED_TEXTS.some(t => text.startsWith(t))) return 'stopped'
  if (part.isError || text.startsWith('Error:')) return 'error'
  return 'completed'
}

/**
 * The id the agent's transcript is kept under, or null when the call
 * names none (no session, or a failure before the agent started).
 */
export function subagentAgentId(part) {
  if (!part) return null
  const candidates = [
    part.toolUseResult?.agentId,
    part.agentId,
    // SendMessage continues an agent: `to` is its id.
    part.args?.to,
    RESUME_HINT.exec(resultText(part))?.[1],
    BACKGROUND_AGENT_ID.exec(resultText(part))?.[1],
  ]
  for (const id of candidates) {
    if (typeof id === 'string' && AGENT_ID.test(id)) return id
  }
  return null
}

/**
 * The report to show under the steps: the agent's answer without the line
 * addressed to the model, the error for a failed run, and for a stopped
 * one only what was added to the fixed sentence (where its changes are).
 */
export function subagentReport(part) {
  const outcome = subagentOutcome(part)
  if (outcome === 'running' || outcome === 'background') return ''
  const text = resultText(part)
  if (outcome === 'stopped') {
    if (text.startsWith(STOPPED_TEXT)) {
      return text.slice(STOPPED_TEXT.length).trim()
    }
    return ''
  }
  if (outcome === 'error') return text
  return text.replace(RESUME_HINT, '')
}

/** The tool steps worth a row: no todo or tool-search bookkeeping. */
export function visibleSubagentSteps(part) {
  const raw = Array.isArray(part?.subagentParts) ? part.subagentParts : []
  return raw.filter(isVisibleStep)
}

function isVisibleStep(step) {
  return (
    step?.type === 'tool_call' &&
    !SUPPRESSED_TOOL_CARDS.has(step.name) &&
    !SUBAGENT_SUPPRESSED.has(step.name)
  )
}

/** The second line of the card: what the agent is doing, or how it ended. */
export function subagentStatusLine(part, steps, headline) {
  if (part.stopping) return 'Stopping…'
  switch (subagentOutcome(part)) {
    case 'background':
      return 'Started in the background'
    case 'completed':
      return 'Completed'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Stopped with error'
    default:
  }
  const live = pickLiveMember(steps)
  const liveText = live && live.status !== 'done' ? liveToolSubtitle(live) : ''
  if (liveText) return liveText
  const liveTask = typeof part.liveTask === 'string' ? part.liveTask.trim() : ''
  const title = typeof headline === 'string' ? headline.trim() : ''
  if (liveTask && liveTask !== title) return liveTask
  // Between steps, and before the first one.
  return 'Planning next moves'
}

/**
 * The agent's side of the conversation, in the order it happened: what it
 * said (`text`) and the runs of tool steps between (`tools`).
 *
 * `dropFinalText` leaves out what it said after its last tool step — the
 * report, when that is shown on its own.
 *
 * @param {object[] | undefined} parts subagentParts: tool_call and text
 * @param {{ dropFinalText?: boolean }} [opts]
 * @returns {Array<
 *   | { type: 'text', key: string, content: string }
 *   | { type: 'tools', key: string, steps: object[] }
 * >}
 */
export function subagentConversation(parts, opts = {}) {
  const segments = []
  let run = null
  let n = 0
  for (const p of Array.isArray(parts) ? parts : []) {
    if (p?.type === 'text') {
      const content = typeof p.content === 'string' ? p.content : ''
      if (!content.trim()) continue
      run = null
      segments.push({ type: 'text', key: p.id || `text:${n++}`, content })
    } else if (isVisibleStep(p)) {
      if (!run) {
        run = { type: 'tools', key: `tools:${p.toolCallId || n++}`, steps: [] }
        segments.push(run)
      }
      run.steps.push(p)
    }
  }
  if (opts.dropFinalText && segments.at(-1)?.type === 'text') segments.pop()
  return segments
}

/**
 * The conversation as transcript bubbles, from what the parent call holds:
 * the prompt, what has streamed in (or the saved steps), and the report
 * once the agent is done. What the agent's tab shows while it runs, and
 * when its saved transcript cannot be read.
 */
export function subagentCallBubbles(part) {
  const args = part?.args || {}
  const prompt = args.prompt || args.task || args.message || ''
  const outcome = subagentOutcome(part)
  const report = subagentReport(part)
  const bubbles = []
  if (typeof prompt === 'string' && prompt) {
    // How long the call took stands in for how long the agent worked.
    const timed =
      outcome !== 'running' &&
      typeof part.startTime === 'number' &&
      typeof part.endTime === 'number'
    bubbles.push({
      id: 'prompt',
      kind: 'user',
      content: prompt,
      ...(timed
        ? { turnStartTime: part.startTime, turnEndTime: part.endTime }
        : {}),
    })
  }
  const segments = subagentConversation(part?.subagentParts, {
    dropFinalText: outcome === 'completed' && report.length > 0,
  })
  for (const segment of segments) {
    if (segment.type === 'text') {
      bubbles.push({
        id: segment.key,
        kind: 'assistant_text',
        content: segment.content,
      })
      continue
    }
    for (const step of segment.steps) {
      bubbles.push({ ...step, id: `tool:${step.toolCallId}`, kind: 'tool' })
    }
  }
  if (report) {
    bubbles.push(
      outcome === 'error'
        ? { id: 'report', kind: 'error', message: report }
        : { id: 'report', kind: 'assistant_text', content: report },
    )
  }
  return bubbles
}

/**
 * The conversation as the agent's page lays it out: for each time it was
 * asked, the task, the steps it took, and what it ended on.
 *
 * A turn that is still running (`live`) has steps and no result yet. One
 * that ended on an answer or an error has that as its `result`; one that
 * was stopped has none.
 *
 * A stopped agent's transcript ends with the marker that, in the main
 * conversation, asks the user what to do instead. Nobody can answer it
 * here — the page already says the agent was stopped — so it is left out.
 *
 * @param {object[]} bubbles
 * @param {{ running?: boolean }} [opts] the last turn is still under way
 * @returns {{
 *   byId: Record<string, object>,
 *   turns: Array<{
 *     key: string,
 *     prompt: object | null,
 *     live: boolean,
 *     steps: object[],
 *     stepCount: number,
 *     result: object | null,
 *     startedAt: number | undefined,
 *     endedAt: number | undefined,
 *     durationMs: number | undefined,
 *   }>,
 * }} `steps` are rows as `expandFoldableSegment` returns them, over `byId`;
 *   `stepCount` counts the tool calls among them
 */
export function subagentTurns(bubbles, { running = false } = {}) {
  const byId = {}
  const asked = []
  let current = null
  for (const bubble of bubbles || []) {
    if (!bubble || bubble.kind === 'interrupted') continue
    byId[bubble.id] = bubble
    if (bubble.kind === 'user' || !current) {
      current = { prompt: bubble.kind === 'user' ? bubble : null, items: [] }
      asked.push(current)
      if (current.prompt) continue
    }
    current.items.push(bubble)
  }

  const num = value => (typeof value === 'number' ? value : undefined)
  const turns = asked.map(({ prompt, items }, i) => {
    const live = running && i === asked.length - 1
    const last = items.at(-1)
    const ended =
      !live &&
      (last?.kind === 'error' ||
        (last?.kind === 'assistant_text' && !!last.content?.trim()))
    const work = ended ? items.slice(0, -1) : items
    const steps = expandFoldableSegment(
      work.map(b => b.id),
      byId,
    )
    // The run of exploring it is in the middle of may still grow.
    if (live && steps.at(-1)?.type === 'tool_group') steps.at(-1).live = true
    const startedAt = num(prompt?.turnStartTime)
    const endedAt = num(prompt?.turnEndTime)
    return {
      // By position: the turn stays the same one when the saved transcript
      // takes the place of what the chat held.
      key: `turn:${i}`,
      prompt,
      live,
      steps,
      stepCount: work.filter(b => b.kind === 'tool').length,
      result: ended ? last : null,
      startedAt,
      endedAt,
      durationMs:
        startedAt !== undefined && endedAt !== undefined && endedAt > startedAt
          ? endedAt - startedAt
          : undefined,
    }
  })
  return { byId, turns }
}

/**
 * The agent's work in a few numbers: how many tool calls it made, how
 * long its runs took together, when it was first asked and when it last
 * finished. What was not kept is undefined.
 */
export function subagentSummary(turns) {
  const timed = (turns || []).filter(t => t.durationMs !== undefined)
  return {
    stepCount: (turns || []).reduce((n, t) => n + t.stepCount, 0),
    durationMs: timed.length
      ? timed.reduce((ms, t) => ms + t.durationMs, 0)
      : undefined,
    startedAt: turns?.[0]?.startedAt,
    endedAt: turns?.at(-1)?.endedAt,
  }
}

/** A span of time in its two largest units: `6s`, `2m 5s`, `1h 3m`. */
export function subagentDurationLabel(ms) {
  if (typeof ms !== 'number' || !(ms > 0)) return ''
  const secs = Math.ceil(ms / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const s = secs % 60
    return s ? `${Math.floor(secs / 60)}m ${s}s` : `${Math.floor(secs / 60)}m`
  }
  const m = Math.floor((secs % 3600) / 60)
  return m ? `${Math.floor(secs / 3600)}h ${m}m` : `${Math.floor(secs / 3600)}h`
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * How long ago, in one short unit: `Now`, `5m`, `2h`, `3d`, `4mo`, `1y` —
 * or, with `ago`, `Just now`, `5m ago`, … Empty when there is no time.
 *
 * @param {number | undefined} ts
 * @param {number} now
 * @param {{ ago?: boolean }} [opts]
 */
export function subagentTimeLabel(ts, now, { ago = false } = {}) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const secs = Math.max(0, Math.floor((now - ts) / 1000))
  if (secs < MINUTE) return ago ? 'Just now' : 'Now'
  let span
  if (secs < HOUR) span = `${Math.floor(secs / MINUTE)}m`
  else if (secs < DAY) span = `${Math.floor(secs / HOUR)}h`
  else if (secs < MONTH) span = `${Math.floor(secs / DAY)}d`
  else if (secs < YEAR) span = `${Math.floor(secs / MONTH)}mo`
  else span = `${Math.floor(secs / YEAR)}y`
  return ago ? `${span} ago` : span
}
