/**
 * Assistant transcript mutators — flat bubble store.
 * Tool patches touch only bubblesById[id]; order pushes only on first insert.
 */
import { newId } from '../../lib/utils.js'
import { agentApi } from '../../lib/api/agent.js'
import { sanitizeToolUpdatePayload } from '../../lib/sanitize-tool-ui.js'
import { sanitizeMessagesForUi } from '../../lib/sanitize-tool-ui.js'
import { notifyIdeFilesystemFromTool } from './ide-bridge.js'
import {
  createStreamBatcher,
  createThrottledSet,
  TOOL_STREAM_THROTTLE_MS,
} from './stream-batch.js'
import { createReasoningMutators } from './reasoning-mutators.js'
import {
  appendBubble,
  findToolBubble,
  messagesToBubbles,
  patchBubble,
  removeBubble,
  askBubbleId,
  compactionBubbleId,
  errorBubbleId,
  permBubbleId,
  planBubbleId,
  textBubbleId,
  thinkingBubbleId,
  todoBubbleId,
  toolBubbleId,
} from '../../lib/bubbles/messages-to-bubbles.js'

const TOOL_STREAM_KEYS = new Set([
  '_beginToolCall',
  '_upsertToolCall',
  '_appendSubagentEvent',
  '_updateToolResult',
  '_updateLastToolTiming',
  '_updateProcessOutput',
  '_appendToolInputDelta',
  '_appendToolInputPreviewDelta',
])

function transcriptPatch(next) {
  return {
    bubbleOrder: next.bubbleOrder,
    bubblesById: next.bubblesById,
  }
}

function sealTrailingAssistantText(state, turnId) {
  if (!turnId) return state
  for (let i = state.bubbleOrder.length - 1; i >= 0; i--) {
    const b = state.bubblesById[state.bubbleOrder[i]]
    if (!b || b.turnId !== turnId) continue
    if (b.kind === 'thinking') continue
    if (b.kind === 'assistant_text' && b.streaming) {
      return patchBubble(state, b.id, { streaming: false })
    }
    break
  }
  return state
}

/** No user bubble can be appended mid-turn, so the newest one owns the turn. */
function stampTurnEnd(state) {
  for (let i = state.bubbleOrder.length - 1; i >= 0; i--) {
    const b = state.bubblesById[state.bubbleOrder[i]]
    if (b?.kind !== 'user') continue
    if (typeof b.turnStartTime !== 'number' || b.turnEndTime != null) {
      return state
    }
    return patchBubble(state, b.id, { turnEndTime: Date.now() })
  }
  return state
}

function findParentToolId(bubblesById, bubbleOrder, parentToolCallId) {
  if (parentToolCallId) {
    const id = toolBubbleId(parentToolCallId)
    if (bubblesById[id]?.kind === 'tool') return id
  }
  const running = []
  for (const id of bubbleOrder) {
    const b = bubblesById[id]
    if (b?.kind === 'tool' && b.isSubagent && b.status !== 'done') {
      running.push(id)
    }
  }
  if (running.length === 1) return running[0]
  if (running.length > 1) {
    const active = running.filter(
      id => (bubblesById[id].subagentParts?.length ?? 0) > 0,
    )
    return active.length === 1 ? active[0] : running[0]
  }
  for (let i = bubbleOrder.length - 1; i >= 0; i--) {
    const b = bubblesById[bubbleOrder[i]]
    if (b?.kind === 'tool' && b.status !== 'done') return bubbleOrder[i]
  }
  for (let i = bubbleOrder.length - 1; i >= 0; i--) {
    const b = bubblesById[bubbleOrder[i]]
    if (b?.kind === 'tool' && b.isSubagent) return bubbleOrder[i]
  }
  return null
}

/**
 * @param {Function} set
 * @param {Function} get
 */
export function createAssistantMutators(set, get) {
  const toolSet = createThrottledSet(set, get, TOOL_STREAM_THROTTLE_MS)

  const mutators = {
    ...createReasoningMutators(set, get),

    _beginToolCall: part => {
      toolSet.schedule(s => {
        const turnId = s.activeTurnId
        if (!turnId || !part.toolCallId) return s
        let next = removeBubble(s, thinkingBubbleId(turnId))
        next = sealTrailingAssistantText(next, turnId)
        const id = toolBubbleId(part.toolCallId)
        const existing = next.bubblesById[id]
        if (existing?.kind === 'tool') {
          if (existing.status === 'done') return transcriptPatch(next)
          return transcriptPatch(
            patchBubble(next, id, {
              ...part,
              kind: 'tool',
              turnId,
              id,
              toolCallId: part.toolCallId,
            }),
          )
        }
        next = appendBubble(next, {
          id,
          kind: 'tool',
          turnId,
          toolCallId: part.toolCallId,
          name: part.name,
          args: part.args || {},
          status: part.status || 'streaming-input',
          isSubagent: part.isSubagent === true,
          liveInputBytes: part.liveInputBytes,
          liveInputStart: part.liveInputStart,
          startTime: part.startTime || Date.now(),
        })
        return transcriptPatch(next)
      })
    },

    _updateTodos: todos => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId) return { todos }
        const id = todoBubbleId(turnId)
        let next = s
        if (next.bubblesById[id]) {
          next = patchBubble(next, id, { todos })
        } else {
          next = appendBubble(next, {
            id,
            kind: 'todo',
            turnId,
            todos,
          })
        }
        return { todos, ...transcriptPatch(next) }
      })
    },

    _appendPart: part => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId) return s
        let next = s
        if (part.type === 'ask_user_question') {
          next = appendBubble(next, {
            id: askBubbleId(part.id),
            kind: 'ask',
            turnId,
            questionId: part.id,
            questions: part.questions,
            status: part.status || 'pending',
          })
        } else if (part.type === 'can_use_tool') {
          next = appendBubble(next, {
            id: permBubbleId(part.id),
            kind: 'perm',
            turnId,
            requestId: part.id,
            toolName: part.toolName,
            title: part.title,
            description: part.description,
            status: part.status || 'pending',
          })
        } else if (part.type === 'compaction_start') {
          next = appendBubble(next, {
            id: compactionBubbleId(turnId),
            kind: 'compaction_start',
            turnId,
          })
        } else if (part.type === 'error') {
          const eid = newId()
          next = appendBubble(next, {
            id: errorBubbleId(eid),
            kind: 'error',
            turnId,
            message: part.message,
          })
        } else {
          return s
        }
        return transcriptPatch(next)
      })
    },

    _resolveCompactionPart: status => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId) return s
        const id = compactionBubbleId(turnId)
        if (status === 'noop') {
          return transcriptPatch(removeBubble(s, id))
        }
        if (!s.bubblesById[id]) return s
        return transcriptPatch(
          patchBubble(s, id, { kind: 'compaction_done', status }),
        )
      })
    },

    _refetchTranscriptAfterCompaction: async () => {
      const id = get().currentSessionId
      if (!id) return
      const s = get()
      const turnId = s.activeTurnId
      let liveOrder = null
      let liveById = null
      if (s.isStreaming && turnId) {
        liveOrder = []
        liveById = {}
        for (const bid of s.bubbleOrder) {
          const b = s.bubblesById[bid]
          if (!b || b.turnId !== turnId) continue
          if (
            b.kind === 'compaction_start' ||
            b.kind === 'compaction_done' ||
            b.kind === 'thinking'
          ) {
            continue
          }
          liveOrder.push(bid)
          liveById[bid] = b
        }
      }
      try {
        const data = await agentApi.getSessionMessages(id)
        if (get().currentSessionId !== id) return
        const msgs = sanitizeMessagesForUi(data.messages ?? [])
        let next = messagesToBubbles(msgs)
        if (liveOrder?.length) {
          next = {
            ...next,
            activeTurnId: turnId,
            bubbleOrder: [...next.bubbleOrder, ...liveOrder],
            bubblesById: { ...next.bubblesById, ...liveById },
          }
        }
        set({
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
          activeTurnId: turnId || next.activeTurnId,
        })
      } catch (err) {
        console.error('[chat] transcript refetch after compact failed', err)
      }
    },

    _appendPlanApprovalPart: data => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId) return s
        const id = planBubbleId(data.requestId)
        let next = removeBubble(s, id)
        next = appendBubble(next, {
          id,
          kind: 'plan',
          turnId,
          requestId: data.requestId,
          plan: data.plan ?? '',
          filePath: data.filePath,
          status: 'pending',
        })
        return {
          ...transcriptPatch(next),
          isAwaitingInteraction: true,
          planState: {
            status: 'awaiting_approval',
            content: data.plan ?? '',
            filePath: data.filePath ?? null,
          },
        }
      })
    },

    _appendToolInputPreviewDelta: data => {
      toolSet.schedule(s => {
        const id = toolBubbleId(data.toolCallId)
        const b = s.bubblesById[id]
        if (!b || b.kind !== 'tool' || b.status === 'done') return s
        return transcriptPatch(
          patchBubble(s, id, {
            livePreview: (b.livePreview || '') + (data.delta || ''),
          }),
        )
      })
    },

    _appendToolInputDelta: data => {
      toolSet.schedule(s => {
        const id = toolBubbleId(data.toolCallId)
        const b = s.bubblesById[id]
        if (!b || b.kind !== 'tool' || b.status === 'done') return s
        return transcriptPatch(
          patchBubble(s, id, {
            liveInputBytes: (b.liveInputBytes || 0) + (data.bytes || 0),
          }),
        )
      })
    },

    _upsertToolCall: data => {
      toolSet.schedule(s => {
        const turnId = s.activeTurnId
        if (!turnId || !data.toolCallId) return s
        let next = removeBubble(s, thinkingBubbleId(turnId))
        next = sealTrailingAssistantText(next, turnId)
        const id = toolBubbleId(data.toolCallId)
        const existing = next.bubblesById[id]
        if (existing?.kind === 'tool') {
          if (existing.status === 'done') {
            return transcriptPatch(
              patchBubble(next, id, {
                name: data.name ?? existing.name,
                args: data.args ?? existing.args,
                isSubagent:
                  data.isSubagent === true || existing.isSubagent === true,
              }),
            )
          }
          return transcriptPatch(
            patchBubble(next, id, {
              name: data.name,
              args: data.args,
              status: 'running',
              isSubagent:
                data.isSubagent === true || existing.isSubagent === true,
              liveInputBytes: undefined,
              liveInputStart: undefined,
            }),
          )
        }
        next = appendBubble(next, {
          id,
          kind: 'tool',
          turnId,
          toolCallId: data.toolCallId,
          name: data.name,
          args: data.args || {},
          status: 'running',
          isSubagent: data.isSubagent === true,
          startTime: data.startTime || Date.now(),
        })
        return transcriptPatch(next)
      })
    },

    _appendSubagentEvent: ev => {
      toolSet.schedule(s => {
        const parentId = findParentToolId(
          s.bubblesById,
          s.bubbleOrder,
          ev.parentToolCallId,
        )
        if (!parentId) return s
        const parent = s.bubblesById[parentId]
        if (parent?.kind !== 'tool') return s
        const sub = [...(parent.subagentParts || [])]

        if (ev.type === 'step_start') {
          return transcriptPatch(
            patchBubble(s, parentId, {
              liveTask: ev.task || parent.liveTask,
              liveLabel: ev.label || parent.liveLabel,
            }),
          )
        }
        if (ev.type === 'tool_input_start') {
          if (!sub.some(x => x.toolCallId === ev.toolCallId)) {
            sub.push({
              type: 'tool_call',
              name: ev.name,
              args: {},
              toolCallId: ev.toolCallId,
              status: 'streaming-input',
            })
          }
          return transcriptPatch(
            patchBubble(s, parentId, { subagentParts: sub }),
          )
        }
        if (ev.type === 'tool_call') {
          const idx = sub.findIndex(x => x.toolCallId === ev.toolCallId)
          if (idx >= 0) {
            sub[idx] = {
              ...sub[idx],
              name: ev.name,
              args: ev.args,
              ...(sub[idx].status === 'done' ? {} : { status: 'running' }),
            }
          } else {
            sub.push({
              type: 'tool_call',
              name: ev.name,
              args: ev.args,
              toolCallId: ev.toolCallId,
              status: 'running',
            })
          }
        } else if (ev.type === 'tool_result') {
          for (let j = sub.length - 1; j >= 0; j--) {
            if (sub[j].toolCallId === ev.toolCallId) {
              const safe = sanitizeToolUpdatePayload(sub[j].name || ev.name, {
                result: ev.result,
                toolUseResult: ev.toolUseResult,
              })
              sub[j] = {
                ...sub[j],
                result: safe.result,
                ...(safe.toolUseResult !== undefined
                  ? { toolUseResult: safe.toolUseResult }
                  : {}),
                ...(ev.isError ? { isError: true } : {}),
                status: 'done',
              }
              notifyIdeFilesystemFromTool(sub[j].name, sub[j].args, ev.result)
              break
            }
          }
        }
        return transcriptPatch(patchBubble(s, parentId, { subagentParts: sub }))
      })
    },

    _appendTextDelta: delta => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId || !delta) return s

        // Chronology: only append onto the turn's trailing assistant_text.
        // If tools (or other parts) landed after the previous text, open a new
        // text bubble so the UI stays interleaved (text → tools → text → …).
        for (let i = s.bubbleOrder.length - 1; i >= 0; i--) {
          const b = s.bubblesById[s.bubbleOrder[i]]
          if (!b || b.turnId !== turnId) continue
          if (b.kind === 'thinking') continue
          if (b.kind === 'assistant_text') {
            return transcriptPatch(
              patchBubble(s, b.id, {
                content: (b.content || '') + delta,
                streaming: true,
              }),
            )
          }
          break
        }

        let seq = 0
        for (const id of s.bubbleOrder) {
          const b = s.bubblesById[id]
          if (b?.kind === 'assistant_text' && b.turnId === turnId) seq++
        }
        const id = textBubbleId(turnId, seq)
        const next = appendBubble(s, {
          id,
          kind: 'assistant_text',
          turnId,
          content: delta,
          streaming: true,
        })
        return transcriptPatch(next)
      })
    },

    _updateToolResult: data => {
      const toolCallId = data.tool_use_id ?? data.toolCallId
      const peeked = toolSet.peek()
      const found = findToolBubble(peeked.bubblesById, toolCallId)
      const name =
        found?.kind === 'tool'
          ? found.name
          : found?.nested?.name || found?.parent?.name
      const safe = sanitizeToolUpdatePayload(name, data)

      toolSet.schedule(s => {
        const id = toolBubbleId(toolCallId)
        if (s.bubblesById[id]?.kind === 'tool') {
          return transcriptPatch(
            patchBubble(s, id, {
              result: safe.result,
              ...(safe.toolUseResult !== undefined
                ? { toolUseResult: safe.toolUseResult }
                : {}),
              ...(data.isError ? { isError: true } : {}),
              status: 'done',
              endTime: Date.now(),
              stopping: false,
              liveTask: undefined,
            }),
          )
        }
        // Nested under subagent
        for (const bid of s.bubbleOrder) {
          const parent = s.bubblesById[bid]
          if (parent?.kind !== 'tool' || !Array.isArray(parent.subagentParts)) {
            continue
          }
          let changed = false
          const sub = parent.subagentParts.map(sp => {
            if (sp.toolCallId !== toolCallId) return sp
            changed = true
            return {
              ...sp,
              result: safe.result,
              ...(safe.toolUseResult !== undefined
                ? { toolUseResult: safe.toolUseResult }
                : {}),
              ...(data.isError ? { isError: true } : {}),
              status: 'done',
            }
          })
          if (changed) {
            return transcriptPatch(patchBubble(s, bid, { subagentParts: sub }))
          }
        }
        return s
      })

      if (found?.kind === 'tool') {
        notifyIdeFilesystemFromTool(found.name, found.args, data.result)
      } else if (found?.nested) {
        notifyIdeFilesystemFromTool(
          found.nested.name,
          found.nested.args,
          data.result,
        )
      }
    },

    _updateLastToolTiming: data => {
      const toolCallId = data.tool_use_id ?? data.toolCallId
      toolSet.schedule(s => {
        if (typeof data.duration !== 'number') return s
        if (toolCallId) {
          const id = toolBubbleId(toolCallId)
          if (s.bubblesById[id]?.kind === 'tool') {
            return transcriptPatch(
              patchBubble(s, id, { duration: data.duration }),
            )
          }
        } else if (data.name) {
          for (let i = s.bubbleOrder.length - 1; i >= 0; i--) {
            const b = s.bubblesById[s.bubbleOrder[i]]
            if (
              b?.kind === 'tool' &&
              b.name === data.name &&
              b.duration == null
            ) {
              return transcriptPatch(
                patchBubble(s, b.id, { duration: data.duration }),
              )
            }
          }
        }
        return s
      })
    },

    _updateProcessOutput: data => {
      toolSet.schedule(s => {
        for (let i = s.bubbleOrder.length - 1; i >= 0; i--) {
          const b = s.bubblesById[s.bubbleOrder[i]]
          if (
            b?.kind === 'tool' &&
            (b.name === 'Bash' || b.name === 'PowerShell') &&
            b.status !== 'done'
          ) {
            return transcriptPatch(
              patchBubble(s, b.id, {
                liveOutput: data.output,
                liveDone: data.done,
                liveElapsed: data.elapsed,
              }),
            )
          }
        }
        return s
      })
    },

    _finalizeAssistant: () => {
      set(s => {
        const turnId = s.activeTurnId
        if (!turnId) return s
        let next = stampTurnEnd(removeBubble(s, thinkingBubbleId(turnId)))
        for (const id of next.bubbleOrder) {
          const b = next.bubblesById[id]
          if (b?.kind !== 'tool' || b.turnId !== turnId) continue
          if (b.status === 'done') continue
          let sub = b.subagentParts
          if (Array.isArray(sub)) {
            sub = sub.map(sp =>
              sp.status === 'done'
                ? sp
                : {
                    ...sp,
                    status: 'done',
                    isError: true,
                    result: sp.result ?? 'Interrupted by user',
                  },
            )
          }
          next = patchBubble(next, id, {
            status: 'done',
            isError: true,
            result: b.result ?? 'Interrupted by user',
            stopping: false,
            liveTask: undefined,
            endTime: Date.now(),
            subagentParts: sub,
          })
        }
        for (const id of next.bubbleOrder) {
          const b = next.bubblesById[id]
          if (b?.kind === 'assistant_text' && b.turnId === turnId) {
            next = patchBubble(next, id, { streaming: false })
          }
        }
        return transcriptPatch(next)
      })
    },

    _onInterrupted: data => {
      get()._finalizeAssistant()
      set(s => {
        const lastId = s.bubbleOrder[s.bubbleOrder.length - 1]
        if (s.bubblesById[lastId]?.kind === 'interrupted') {
          return { isAwaitingInteraction: false }
        }
        const next = appendBubble(s, {
          id: newId(),
          kind: 'interrupted',
          toolUse: data?.tool_use === true,
          text: data?.text,
        })
        return {
          ...transcriptPatch(next),
          isAwaitingInteraction: false,
          activeTurnId: null,
        }
      })
    },

    _beginScheduledTurn: prompt => {
      if (get().isStreaming) return
      const text = typeof prompt === 'string' ? prompt : ''
      if (!text.trim()) return
      const userMsgId = newId()
      const assistantMsgId = newId()
      set(s => {
        const next = appendBubble(s, {
          id: userMsgId,
          kind: 'user',
          content: text,
          turnStartTime: Date.now(),
        })
        return {
          ...transcriptPatch(next),
          isStreaming: true,
          currentStep: 0,
          activeTurnId: assistantMsgId,
          scheduledTurnActive: true,
        }
      })
      get()._setThinking()
    },
  }

  const batcher = createStreamBatcher({
    flush: ({ text, reasoning }) => {
      if (reasoning) mutators._appendReasoningDelta(reasoning)
      if (text) mutators._appendTextDelta(text)
    },
  })

  const out = {
    _flushStreamBatch: () => {
      batcher.flushNow()
      toolSet.flushNow()
    },
  }
  for (const key of Object.keys(mutators)) {
    const fn = mutators[key]
    if (key === '_appendTextDelta') {
      out[key] = delta => {
        toolSet.flushNow()
        batcher.appendText(delta)
      }
    } else if (key === '_appendReasoningDelta') {
      out[key] = delta => {
        toolSet.flushNow()
        batcher.appendReasoning(delta)
      }
    } else if (TOOL_STREAM_KEYS.has(key) && typeof fn === 'function') {
      out[key] = (...args) => {
        batcher.flushNow()
        return fn(...args)
      }
    } else if (typeof fn === 'function') {
      out[key] = (...args) => {
        batcher.flushNow()
        toolSet.flushNow()
        return fn(...args)
      }
    } else {
      out[key] = fn
    }
  }
  return out
}

export { findToolBubble }
