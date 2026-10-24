import { memo } from 'react'
import BubbleRow from './BubbleRow.jsx'
import ToolGroupRow from './ToolGroupRow.jsx'
import WorkGroupRow from './WorkGroupRow.jsx'

/**
 * One flatElements entry. Structure props are stable; content rows subscribe
 * to bubblesById themselves.
 */
function TranscriptRow({ element, streamingTail = false }) {
  if (!element) return null

  if (element.type === 'work_group') {
    return (
      <WorkGroupRow
        memberIds={element.memberIds}
        durationMs={element.durationMs}
        state={element.state}
        defaultOpen={element.defaultOpen === true}
      />
    )
  }

  if (element.type === 'tool_group') {
    return (
      <ToolGroupRow
        memberIds={element.memberIds}
        groupKind={element.groupKind}
        live={element.live === true}
      />
    )
  }

  return <BubbleRow bubbleId={element.bubbleId} streamingTail={streamingTail} />
}

export default memo(TranscriptRow, (prev, next) => {
  const a = prev.element
  const b = next.element
  if (prev.streamingTail !== next.streamingTail) return false
  if (a === b) return true
  if (!a || !b || a.type !== b.type || a.id !== b.id) return false
  if (a.type === 'work_group') {
    return (
      a.durationMs === b.durationMs &&
      a.state === b.state &&
      a.defaultOpen === b.defaultOpen &&
      a.memberIds === b.memberIds
    )
  }
  if (a.type === 'tool_group') {
    return (
      a.groupKind === b.groupKind &&
      a.memberIds === b.memberIds &&
      a.live === b.live
    )
  }
  return a.bubbleId === b.bubbleId
})
