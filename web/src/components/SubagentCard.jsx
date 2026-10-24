import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { mdComponents } from '../lib/markdown-components.jsx'
import NestedToolRuns from './NestedToolRuns.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import { useChatActions } from '../lib/chat-actions.jsx'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import {
  liveToolSubtitle,
  pickLiveMember,
  summarizeToolSteps,
} from '../lib/tool-density.js'
import { SUPPRESSED_TOOL_CARDS, SUBAGENT_SUPPRESSED } from './pickToolCard.js'

/**
 * Task / Explorer row: one typography line when collapsed.
 * Nested steps stay collapsed after the task finishes (flat Worked timeline).
 */

const TYPE_BADGES = {
  Explore: 'Explorer',
  explore: 'Explorer',
  Plan: 'Plan',
  plan: 'Plan',
  'general-purpose': 'Task',
  general_purpose: 'Task',
}

function badgeFor(subagentType) {
  if (TYPE_BADGES[subagentType]) return TYPE_BADGES[subagentType]
  if (!subagentType) return 'Task'
  return subagentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function visibleSteps(part) {
  const raw = Array.isArray(part.subagentParts) ? part.subagentParts : []
  return raw.filter(
    s =>
      s.type === 'tool_call' &&
      !SUPPRESSED_TOOL_CARDS.has(s.name) &&
      !SUBAGENT_SUPPRESSED.has(s.name),
  )
}

function rowSubtitle(part, steps) {
  if (part.stopping) return 'Stopping…'
  if (part.status === 'done') {
    return summarizeToolSteps(steps)
  }
  const live = pickLiveMember(steps)
  const liveText = live && live.status !== 'done' ? liveToolSubtitle(live) : ''
  if (liveText) return liveText
  if (part.liveTask) return part.liveTask
  if (steps.length > 0 && steps.every(s => s.status === 'done')) {
    return 'Writing report…'
  }
  return 'Starting…'
}

export default function SubagentCard({ part, onStopTool }) {
  const { stopTool } = useChatActions()
  const stop = onStopTool ?? stopTool
  const args = part.args || {}
  const subagentType = args.subagent_type || part.name || 'subagent'
  const headline =
    args.description ||
    args.task ||
    (typeof args.prompt === 'string' ? args.prompt.slice(0, 120) : '') ||
    null
  const fullPrompt = args.prompt || args.task || ''
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    typeof part.result === 'string' &&
    part.result.startsWith('Error:')
  const badge = badgeFor(subagentType)

  const steps = useMemo(() => visibleSteps(part), [part.subagentParts])
  const subtitle = rowSubtitle(part, steps)
  const hasReport =
    isDone && typeof part.result === 'string' && part.result.length > 0
  const hasBody = steps.length > 0 || hasReport
  const [expanded, toggleExpanded, chevron] = useToolDensityExpand('subagent', {
    isDone,
    isError,
    hasBody,
  })
  const [showAllSteps, setShowAllSteps] = useState(false)

  const onStop = e => {
    e.stopPropagation()
    if (isDone || part.stopping || !part.toolCallId) return
    void stop(part.toolCallId)
  }

  return (
    <div
      className={`tool-row subagent-timeline-row ${isError ? 'has-error' : ''} ${expanded ? 'open' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={hasBody ? toggleExpanded : undefined}
        showChevron={chevron.showChevron}
        label={badge}
        title={headline}
        titleTooltip={fullPrompt || headline}
        titlePlain
        subtitle={subtitle || undefined}
        isDone={isDone}
        isError={isError}
        showSuccess={false}
        actions={
          !isDone && part.toolCallId ? (
            <button
              type='button'
              className='subagent-stop-btn'
              onClick={onStop}
              disabled={!!part.stopping}
            >
              Stop
            </button>
          ) : null
        }
      />

      {expanded && hasBody && (
        <div className='subagent-timeline-expanded'>
          {steps.length > 0 && (
            <NestedToolRuns
              steps={steps}
              showAllSteps={showAllSteps}
              onShowAll={() => setShowAllSteps(true)}
            />
          )}
          {hasReport && (
            <div
              className={`subagent-result ${isError ? 'subagent-result--error' : ''}`}
            >
              {isError ? (
                <pre className='subagent-result-error'>{part.result}</pre>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {part.result}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
