import { memo, useMemo } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { toolBubbleToPart } from '../../lib/bubbles/messages-to-bubbles.js'
import ExploredGroup from '../ExploredGroup.jsx'

/**
 * Explore / browser rollup — rebuilds items only when member tool refs change.
 */
function ToolGroupRow({
  memberIds,
  groupKind = 'explore',
  live = false,
  embedded = false,
}) {
  const memberKey = useChatStore(s => {
    const parts = []
    for (const id of memberIds) {
      const b = s.bubblesById[id]
      if (!b || b.kind !== 'tool') {
        parts.push(`${id}:miss`)
        continue
      }
      parts.push(
        `${id}:${b.status}:${b.liveTask || ''}:${b.liveLabel || ''}:${b.isError ? 1 : 0}`,
      )
    }
    return parts.join('|')
  })

  const items = useMemo(() => {
    const byId = useChatStore.getState().bubblesById
    const out = []
    for (const id of memberIds) {
      const b = byId[id]
      if (b?.kind === 'tool') out.push(toolBubbleToPart(b))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIds, memberKey])

  if (items.length === 0) return null

  const body = (
    <div className='tool-group'>
      <ExploredGroup items={items} kind={groupKind} live={live} />
    </div>
  )

  if (embedded) return body
  return <div className='msg msg-assistant'>{body}</div>
}

function memberIdsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((id, i) => id === b[i])
}

export default memo(ToolGroupRow, (prev, next) => {
  return (
    prev.groupKind === next.groupKind &&
    prev.live === next.live &&
    prev.embedded === next.embedded &&
    memberIdsEqual(prev.memberIds, next.memberIds)
  )
})
