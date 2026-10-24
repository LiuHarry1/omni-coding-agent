/**
 * Canonical transcript helpers (flat bubbles only — no work_group in store).
 */

import { newId } from '../utils.js'
import {
  askBubbleId,
  compactionBubbleId,
  errorBubbleId,
  permBubbleId,
  planBubbleId,
  reasoningBubbleId,
  textBubbleId,
  thinkingBubbleId,
  todoBubbleId,
  toolBubbleId,
} from './ids.js'

/** @returns {{ bubbleOrder: string[], bubblesById: Record<string, object>, activeTurnId: string | null }} */
export function emptyTranscript() {
  return { bubbleOrder: [], bubblesById: {}, activeTurnId: null }
}

/**
 * Map any transcript bubble to the legacy part shape for PartRenderer / cards.
 * @param {object} b
 */
export function bubbleToPart(b) {
  if (!b) return null
  switch (b.kind) {
    case 'tool':
      return toolBubbleToPart(b)
    case 'assistant_text':
      return { type: 'text', id: b.id, content: b.content || '' }
    case 'reasoning':
      return {
        type: 'reasoning',
        id: b.reasoningId || b.id,
        content: b.content || '',
        status: b.status || 'done',
        startTime: b.startTime,
        duration: b.duration,
      }
    case 'thinking':
      return { type: 'thinking' }
    case 'todo':
      return { type: 'todo_list', todos: b.todos }
    case 'ask':
      return {
        type: 'ask_user_question',
        id: b.questionId,
        questions: b.questions,
        status: b.status,
        answers: b.answers,
      }
    case 'perm':
      return {
        type: 'can_use_tool',
        id: b.requestId,
        toolName: b.toolName,
        title: b.title,
        description: b.description,
        status: b.status,
        decision: b.decision,
      }
    case 'plan':
      return {
        type: 'plan_approval',
        requestId: b.requestId,
        plan: b.plan,
        status: b.status,
        approved: b.approved,
      }
    case 'compaction_start':
      return { type: 'compaction_start' }
    case 'compaction_done':
      return { type: 'compaction_done', status: b.status }
    case 'error':
      return { type: 'error', message: b.message }
    default:
      return null
  }
}

/**
 * Map a tool bubble to the legacy `tool_call` part shape expected by cards.
 * @param {object} b
 */
export function toolBubbleToPart(b) {
  if (!b || b.kind !== 'tool') return b
  return {
    type: 'tool_call',
    toolCallId: b.toolCallId,
    name: b.name,
    args: b.args || {},
    status: b.status,
    result: b.result,
    toolUseResult: b.toolUseResult,
    isError: b.isError,
    isSubagent: b.isSubagent,
    subagentParts: b.subagentParts,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    liveTask: b.liveTask,
    liveLabel: b.liveLabel,
    liveOutput: b.liveOutput,
    liveElapsed: b.liveElapsed,
    liveDone: b.liveDone,
    livePreview: b.livePreview,
    liveInputBytes: b.liveInputBytes,
    liveInputStart: b.liveInputStart,
    stopping: b.stopping,
  }
}

/**
 * @param {{ bubbleOrder: string[], bubblesById: Record<string, object> }} state
 * @param {object} bubble
 */
export function appendBubble(state, bubble) {
  if (!bubble?.id) return state
  if (state.bubblesById[bubble.id]) {
    return {
      ...state,
      bubblesById: {
        ...state.bubblesById,
        [bubble.id]: { ...state.bubblesById[bubble.id], ...bubble },
      },
    }
  }
  return {
    ...state,
    bubbleOrder: [...state.bubbleOrder, bubble.id],
    bubblesById: { ...state.bubblesById, [bubble.id]: bubble },
  }
}

/**
 * Patch one bubble without touching siblings' object identity.
 * @param {{ bubblesById: Record<string, object> }} state
 * @param {string} id
 * @param {object | ((prev: object) => object)} patch
 */
export function patchBubble(state, id, patch) {
  const prev = state.bubblesById[id]
  if (!prev) return state
  const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch }
  if (next === prev) return state
  return {
    ...state,
    bubblesById: { ...state.bubblesById, [id]: next },
  }
}

/** Remove a bubble id from order + map. */
export function removeBubble(state, id) {
  if (!state.bubblesById[id]) return state
  const { [id]: _removed, ...rest } = state.bubblesById
  return {
    ...state,
    bubbleOrder: state.bubbleOrder.filter(x => x !== id),
    bubblesById: rest,
  }
}

/**
 * Convert legacy session `messages[]` into flat bubbles.
 * @param {object[]} messages
 */
export function messagesToBubbles(messages) {
  let state = emptyTranscript()
  for (const msg of messages || []) {
    if (!msg) continue
    if (msg.type === 'user') {
      state = appendBubble(state, {
        id: msg.id || newId(),
        kind: 'user',
        content: msg.content,
        images: msg.images,
        files: msg.files,
        turnStartTime: msg.turnStartTime,
        turnEndTime: msg.turnEndTime,
      })
      continue
    }
    if (msg.type === 'interrupted') {
      state = appendBubble(state, {
        id: msg.id || newId(),
        kind: 'interrupted',
        toolUse: msg.toolUse,
        text: msg.text,
      })
      continue
    }
    if (msg.type === 'compact_boundary') {
      state = appendBubble(state, {
        id: msg.id || newId(),
        kind: 'compact_boundary',
        summary: msg.summary,
      })
      continue
    }
    if (msg.type !== 'assistant') continue

    const turnId = msg.id || newId()
    let textSeq = 0
    for (const part of msg.parts || []) {
      if (!part) continue
      if (part.type === 'thinking') {
        state = appendBubble(state, {
          id: thinkingBubbleId(turnId),
          kind: 'thinking',
          turnId,
        })
      } else if (part.type === 'reasoning') {
        const rid = part.id || newId()
        state = appendBubble(state, {
          id: reasoningBubbleId(rid),
          kind: 'reasoning',
          turnId,
          reasoningId: rid,
          content: part.content || '',
          status: part.status || 'done',
          startTime: part.startTime,
          duration: part.duration,
        })
      } else if (part.type === 'text') {
        const tid = part.id || textBubbleId(turnId, textSeq++)
        state = appendBubble(state, {
          id: tid.startsWith('text:') ? tid : textBubbleId(turnId, textSeq++),
          kind: 'assistant_text',
          turnId,
          content: part.content || '',
          streaming: false,
        })
      } else if (part.type === 'tool_call' && part.toolCallId) {
        state = appendBubble(state, {
          id: toolBubbleId(part.toolCallId),
          kind: 'tool',
          turnId,
          toolCallId: part.toolCallId,
          name: part.name,
          args: part.args || {},
          status: part.status || 'done',
          result: part.result,
          toolUseResult: part.toolUseResult,
          isError: part.isError,
          isSubagent: part.isSubagent,
          subagentParts: part.subagentParts,
          startTime: part.startTime,
          endTime: part.endTime,
          duration: part.duration,
        })
      } else if (part.type === 'todo_list') {
        state = appendBubble(state, {
          id: todoBubbleId(turnId),
          kind: 'todo',
          turnId,
          todos: part.todos,
        })
      } else if (part.type === 'ask_user_question') {
        state = appendBubble(state, {
          id: askBubbleId(part.id),
          kind: 'ask',
          turnId,
          questionId: part.id,
          questions: part.questions,
          status: part.status,
          answers: part.answers,
        })
      } else if (part.type === 'can_use_tool') {
        state = appendBubble(state, {
          id: permBubbleId(part.id),
          kind: 'perm',
          turnId,
          requestId: part.id,
          toolName: part.toolName,
          title: part.title,
          description: part.description,
          status: part.status,
          decision: part.decision,
        })
      } else if (part.type === 'plan_approval') {
        state = appendBubble(state, {
          id: planBubbleId(part.requestId),
          kind: 'plan',
          turnId,
          requestId: part.requestId,
          plan: part.plan,
          status: part.status,
          approved: part.approved,
        })
      } else if (part.type === 'compaction_start') {
        state = appendBubble(state, {
          id: compactionBubbleId(turnId),
          kind: 'compaction_start',
          turnId,
        })
      } else if (part.type === 'compaction_done') {
        state = appendBubble(state, {
          id: compactionBubbleId(turnId),
          kind: 'compaction_done',
          turnId,
          status: part.status,
        })
      } else if (part.type === 'error') {
        const eid = newId()
        state = appendBubble(state, {
          id: errorBubbleId(eid),
          kind: 'error',
          turnId,
          message: part.message,
        })
      }
    }
  }
  return state
}

/**
 * Find tool bubble by toolCallId (top-level or nested in subagentParts).
 */
export function findToolBubble(bubblesById, toolCallId) {
  if (!toolCallId || !bubblesById) return null
  const direct = bubblesById[toolBubbleId(toolCallId)]
  if (direct?.kind === 'tool') return direct
  for (const b of Object.values(bubblesById)) {
    if (b?.kind !== 'tool' || !Array.isArray(b.subagentParts)) continue
    const nested = b.subagentParts.find(
      sp => sp.type === 'tool_call' && sp.toolCallId === toolCallId,
    )
    if (nested) return { parent: b, nested }
  }
  return null
}

export {
  askBubbleId,
  compactionBubbleId,
  errorBubbleId,
  permBubbleId,
  planBubbleId,
  reasoningBubbleId,
  textBubbleId,
  thinkingBubbleId,
  todoBubbleId,
  toolBubbleId,
}
