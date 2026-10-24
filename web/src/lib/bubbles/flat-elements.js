/**
 * View-model over canonical flat bubbles (flatElements / density).
 * Does NOT write groups back into the store.
 */

import {
  isBrowserTool,
  isExploreTool,
  coalesceToolRuns,
} from '../tool-density.js'
import { formatWorkedDuration } from '../timeline.js'

const FOLDABLE_KINDS = new Set([
  'reasoning',
  'thinking',
  'tool',
  'todo',
  'compaction_start',
  'compaction_done',
])

function turnOf(b) {
  return b?.turnId || null
}

/** Send → finish; only turns run in this tab carry the timestamps. */
function turnDurationMs(userBubble) {
  const start = userBubble?.turnStartTime
  const end = userBubble?.turnEndTime
  if (typeof start !== 'number' || typeof end !== 'number') return undefined
  return end > start ? end - start : undefined
}

/**
 * Coalesce consecutive explore/browser tools into view groups.
 * @param {object[]} items tool bubbles in order
 */
function coalesceToolViewRuns(items) {
  const runs = coalesceToolRuns(items)
  let cursor = 0
  const out = []
  for (const run of runs) {
    if (run.type === 'explored_run' || run.type === 'browser_run') {
      const n = run.items.length
      const memberIds = items.slice(cursor, cursor + n).map(b => b.id)
      cursor += n
      out.push({
        id: `vg-${run.type}-${memberIds[0]}-${memberIds[memberIds.length - 1]}`,
        type: 'tool_group',
        groupKind: run.type === 'browser_run' ? 'browser' : 'explore',
        memberIds,
      })
    } else {
      const b = items[cursor++]
      out.push({ id: b.id, type: 'bubble', bubbleId: b.id })
    }
  }
  return out
}

/**
 * Expand a list of foldable bubble ids into flatElements (with tool coalesce).
 * Also used when expanding a work_group body.
 */
export function expandFoldableSegment(ids, byId) {
  const out = []
  let toolBuf = []
  const flushTools = () => {
    if (toolBuf.length === 0) return
    out.push(...coalesceToolViewRuns(toolBuf))
    toolBuf = []
  }
  for (const id of ids) {
    const b = byId[id]
    if (!b) continue
    if (b.kind === 'tool') {
      toolBuf.push(b)
    } else {
      flushTools()
      if (b.kind === 'thinking') {
        out.push({ id: b.id, type: 'bubble', bubbleId: b.id })
      } else {
        out.push({ id: b.id, type: 'bubble', bubbleId: b.id })
      }
    }
  }
  flushTools()
  return out
}

function hasRealWork(ids, byId) {
  return ids.some(id => {
    const b = byId[id]
    if (!b || b.kind === 'thinking') return false
    if (b.kind === 'tool') return true
    if (b.kind === 'reasoning') {
      return !!b.content?.trim() || (b.duration != null && b.duration > 2)
    }
    return FOLDABLE_KINDS.has(b.kind)
  })
}

/**
 * A streaming turn's trailing tool group can still grow, so it stays "live"
 * (Exploring…) between steps; only the thinking placeholder may follow it.
 */
function markLiveTailGroup(viewRows, byId) {
  for (let k = viewRows.length - 1; k >= 0; k--) {
    const el = viewRows[k]
    if (el.type === 'bubble' && byId[el.bubbleId]?.kind === 'thinking') continue
    if (el.type === 'tool_group') el.live = true
    return
  }
}

/**
 * Unwrap a workGroup that only contains one row, unless that
 * row is an explore/browser group with multiple members.
 */
function keepWorkGroup(viewRows) {
  if (viewRows.length > 1) return true
  if (viewRows.length !== 1) return false
  const el = viewRows[0]
  return el.type === 'tool_group' && (el.memberIds?.length ?? 0) > 1
}

/**
 * @param {string[]} bubbleOrder
 * @param {Record<string, object>} bubblesById
 * @param {{
 *   isStreaming?: boolean,
 *   activeTurnId?: string | null,
 *   unfoldLatestTurn?: boolean,
 * }} [opts]
 * @returns {object[]} flatElements
 */
export function buildFlatElements(
  bubbleOrder,
  bubblesById,
  { isStreaming = false, activeTurnId = null, unfoldLatestTurn = false } = {},
) {
  const order = bubbleOrder || []
  const byId = bubblesById || {}
  const result = []

  // Partition into turn segments: user | interrupted | compact_boundary reset;
  // assistant-side bubbles share turnId.
  let i = 0
  let turnUser = null
  while (i < order.length) {
    const id = order[i]
    const b = byId[id]
    if (!b) {
      i++
      continue
    }

    if (
      b.kind === 'user' ||
      b.kind === 'interrupted' ||
      b.kind === 'compact_boundary'
    ) {
      turnUser = b.kind === 'user' ? b : null
      result.push({ id: b.id, type: 'bubble', bubbleId: b.id })
      i++
      continue
    }

    // Collect a turn's foldable + trailing content until next user boundary
    // or different turn's non-foldable that starts a new reply.
    const turnId = turnOf(b)
    const userBubble = turnUser
    turnUser = null
    const segmentIds = []
    while (i < order.length) {
      const cur = byId[order[i]]
      if (!cur) {
        i++
        continue
      }
      if (
        cur.kind === 'user' ||
        cur.kind === 'interrupted' ||
        cur.kind === 'compact_boundary'
      ) {
        break
      }
      if (turnId && turnOf(cur) && turnOf(cur) !== turnId) {
        // Different assistant turn — stop (rare in flat hydrate)
        break
      }
      segmentIds.push(order[i])
      i++
    }

    // Default chat (not project): while the turn is generating,
    // do not emit workGroup — tools/thinking stay flat. Worked wraps the
    // prefix only after a completed turn has a final assistant reply.
    const liveTurn =
      isStreaming &&
      (turnId === activeTurnId ||
        (activeTurnId == null && turnId === turnOf(byId[segmentIds[0]])))

    let split = 0
    if (!liveTurn) {
      let lastText = -1
      for (let j = segmentIds.length - 1; j >= 0; j--) {
        const sb = byId[segmentIds[j]]
        if (sb?.kind === 'assistant_text' && sb.content?.trim()) {
          lastText = j
          break
        }
      }
      if (lastText > 0) {
        const prefix = segmentIds.slice(0, lastText)
        if (
          prefix.every(pid => FOLDABLE_KINDS.has(byId[pid]?.kind)) &&
          hasRealWork(
            prefix.filter(pid => byId[pid]?.kind !== 'thinking'),
            byId,
          )
        ) {
          split = lastText
        }
      }
    }

    const prefixIds = segmentIds
      .slice(0, split)
      .filter(pid => byId[pid]?.kind !== 'thinking')
    const suffixIds = segmentIds.slice(split)

    if (prefixIds.length > 0 && hasRealWork(prefixIds, byId)) {
      const prefixView = expandFoldableSegment(prefixIds, byId)
      if (keepWorkGroup(prefixView)) {
        const durationMs = turnDurationMs(userBubble)
        result.push({
          id: `work:${turnId || prefixIds[0]}:done`,
          type: 'work_group',
          turnId,
          memberIds: prefixIds,
          durationMs,
          durationLabel: formatWorkedDuration(durationMs),
          state: 'completed',
        })
      } else {
        result.push(...prefixView)
      }
    } else if (split > 0) {
      // prefix was only thinking — emit nothing from thinking
    }

    const suffixView = expandFoldableSegment(suffixIds, byId)
    if (liveTurn) markLiveTailGroup(suffixView, byId)
    result.push(...suffixView)
  }

  if (unfoldLatestTurn) {
    const lastTurnId = lastAssistantTurnId(order, byId)
    if (lastTurnId) {
      for (const el of result) {
        if (el.type === 'work_group' && el.turnId === lastTurnId) {
          el.defaultOpen = true
        }
      }
    }
  }

  return result
}

function lastAssistantTurnId(order, byId) {
  for (let i = order.length - 1; i >= 0; i--) {
    const b = byId[order[i]]
    if (!b) continue
    if (
      b.kind === 'user' ||
      b.kind === 'interrupted' ||
      b.kind === 'compact_boundary'
    ) {
      continue
    }
    return turnOf(b)
  }
  return null
}

/** Whether a tool bubble is explore/browser groupable (for tests). */
export function isGroupableToolBubble(b) {
  if (!b || b.kind !== 'tool') return false
  return isExploreTool(b) || isBrowserTool(b)
}
