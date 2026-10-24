import { useMemo } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { pickCard } from './pickToolCard.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import {
  summarizeExploredDetails,
  detectToolError,
} from '../lib/tool-density.js'
import { toolPartKey } from '../lib/timeline.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/** Max nested tool rows when expanded (older steps stay behind a count chip). */
const NESTED_RENDER_CAP = 40

/**
 * Explore / browser density:
 *   collapsed → muted "Exploring 1 file, 1 search, 3 browser actions"
 *               ("Explored …" / "Ran N browser actions" once settled)
 *   expanded  → nested tool rows (bodies still collapsed)
 *
 * `live`: trailing group of a streaming turn — keeps the "Exploring" wording
 * between steps, because the next step may still join it. Only a running
 * member makes the label shimmer (the tail status covers the gaps).
 *
 * @param {{ items: object[], kind?: 'explore' | 'browser', live?: boolean }} props
 */
export default function ExploredGroup({
  items,
  kind = 'explore',
  live = false,
}) {
  const n = items.length
  const anyRunning = items.some(p => p.status !== 'done')
  const anyError = items.some(detectToolError)
  const densityKind = kind === 'browser' ? 'browser-group' : 'explore-group'

  const [expanded, toggle, chevron] = useToolDensityExpand(densityKind, {
    isDone: !anyRunning,
    isError: anyError,
    isRunning: anyRunning,
    hasBody: true,
  })

  const details = useMemo(() => summarizeExploredDetails(items), [items])

  const action = toolActionLabel(kind === 'browser' ? 'browser' : 'explore', {
    loading: live || anyRunning,
    hasError: anyError,
  })

  const nestedItems = useMemo(() => {
    if (items.length <= NESTED_RENDER_CAP) return items
    return items.slice(-NESTED_RENDER_CAP)
  }, [items])
  const hiddenNested = items.length - nestedItems.length

  return (
    <div
      className={`tool-row explored-group ${kind === 'browser' ? 'explored-group--browser' : ''} ${anyError ? 'has-error' : ''} ${expanded ? 'is-open' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={toggle}
        showChevron={chevron.showChevron}
        label={action}
        title={details || `${n} tool${n === 1 ? '' : 's'}`}
        titlePlain
        isDone={!anyRunning}
        isError={anyError}
        showSuccess={false}
      />

      {expanded && (
        <div className='explored-group-body'>
          {hiddenNested > 0 && (
            <div className='explored-group-earlier' aria-hidden='true'>
              {hiddenNested} earlier step{hiddenNested === 1 ? '' : 's'}
            </div>
          )}
          {nestedItems.map((item, i) => {
            const Card = pickCard(item, { nested: true })
            return (
              <div
                className='explored-group-step'
                key={toolPartKey(item, `step-${i}`)}
              >
                <Card part={item} nested />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
