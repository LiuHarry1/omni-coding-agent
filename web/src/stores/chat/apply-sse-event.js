/**
 * Map one protocol SSE event onto chat-store mutators / UI flags.
 * Transport stays in stream-chat.js; this is the transcript reduce switch.
 */

/**
 * @param {object} data
 * @param {{ set: Function, get: Function, mutators: Record<string, Function> }} ctx
 */
export function applySseEvent(data, { set, get, mutators: m }) {
  const store = get()
  const toolUseId = d => d.tool_use_id ?? d.toolCallId
  const parentId = data.parent_tool_use_id ?? data.parentToolCallId

  if (parentId) {
    if (data.type === 'tool_call') {
      m._appendSubagentEvent({
        type: 'tool_call',
        name: data.name,
        args: data.args,
        toolCallId: toolUseId(data),
        parentToolCallId: parentId,
      })
      return
    }
    if (data.type === 'tool_result') {
      m._appendSubagentEvent({
        type: 'tool_result',
        result: data.result,
        toolUseResult: data.tool_use_result,
        isError: data.is_error === true,
        toolCallId: toolUseId(data),
        parentToolCallId: parentId,
      })
      return
    }
    if (data.type === 'stream_event' && data.delta?.kind === 'text') {
      m._appendSubagentEvent({
        type: 'text_delta',
        delta: data.delta.text,
        parentToolCallId: parentId,
      })
      return
    }
    if (data.type === 'system') {
      if (data.subtype === 'step_start') {
        m._appendSubagentEvent({
          type: 'step_start',
          task: data.task,
          label: data.label,
          parentToolCallId: parentId,
        })
      } else if (data.subtype === 'tool_input_start') {
        m._appendSubagentEvent({
          type: 'tool_input_start',
          name: data.name,
          toolCallId: toolUseId(data),
          parentToolCallId: parentId,
        })
      }
    }
    return
  }

  if (data.type === 'tool_progress') {
    m._updateProcessOutput({ output: data.output, done: false })
    return
  }

  switch (data.type) {
    case 'system':
      switch (data.subtype) {
        case 'init':
          if (data.session_id) store.setSessionId(data.session_id)
          if (data.permission_mode) {
            set({ agentMode: data.permission_mode })
          }
          if (data.agent_type !== undefined) {
            set({ agentType: data.agent_type || null })
          }
          break
        case 'mode_changed':
          if (data.mode) {
            const patch = { agentMode: data.mode }
            if (data.mode === 'ask' || data.mode === 'plan') {
              patch.agentType = null
            }
            set(patch)
          }
          break
        case 'reasoning_start':
          // Single set: drop placeholder + start reasoning (avoid WorkGroup
          // remount gap from removeThinking then _startReasoning).
          m._replaceThinkingWithReasoning()
          break
        case 'reasoning_end':
          m._finalizeReasoning()
          break
        case 'step_start':
          set({ currentStep: data.step ?? get().currentStep })
          m._setThinking()
          break
        case 'thinking':
          m._setThinking()
          break
        case 'turn_state':
          set({
            turnState: data.state || 'idle',
            turnDetail: data.detail_code || null,
            turnStateLabel: data.label || null,
            turnStateSince: Date.now(),
          })
          break
        case 'todo_update':
          m._updateTodos(data.todos)
          break
        case 'tool_input_start':
          m._beginToolCall({
            type: 'tool_call',
            name: data.name,
            toolCallId: toolUseId(data),
            args: {},
            status: 'streaming-input',
            isSubagent: data.is_subagent === true,
            liveInputBytes: 0,
            liveInputStart: Date.now(),
            startTime: Date.now(),
          })
          break
        case 'tool_input_preview_delta':
          m._appendToolInputPreviewDelta({
            toolCallId: toolUseId(data),
            delta: data.delta,
          })
          break
        case 'tool_input_delta':
          m._appendToolInputDelta({
            toolCallId: toolUseId(data),
            bytes: data.bytes,
          })
          break
        case 'plan_ready':
          set({
            planState: {
              status: data.approved ? 'building' : 'idle',
              content: data.plan ?? '',
              filePath: data.file_path ?? null,
            },
          })
          if (data.approved) m._setThinking()
          break
        case 'compaction_start':
          // Spread first: the wire message carries type:'system', which
          // must not clobber the part's own type discriminant.
          m._appendPart({ ...data, type: 'compaction_start' })
          break
        case 'compaction_done': {
          const status = data.status ?? 'ok'
          m._resolveCompactionPart(status)
          // noop/error left the transcript untouched — nothing to refetch.
          if (status === 'ok') void m._refetchTranscriptAfterCompaction()
          break
        }
        case 'tool_timing':
          m._updateLastToolTiming(data)
          break
        case 'interrupted':
          m._onInterrupted(data)
          break
        case 'scheduled_turn':
          m._beginScheduledTurn(data.prompt || '')
          break
      }
      break
    case 'stream_event':
      if (data.delta?.kind === 'reasoning') {
        m._appendReasoningDelta(data.delta.text)
      } else if (data.delta?.kind === 'text') {
        m._removeThinking()
        m._appendTextDelta(data.delta.text)
      }
      break
    case 'tool_call':
      m._removeThinking()
      m._upsertToolCall({
        name: data.name,
        toolCallId: toolUseId(data),
        args: data.args,
        isSubagent: data.is_subagent === true,
        startTime: Date.now(),
      })
      break
    case 'tool_result':
      m._updateToolResult({
        toolCallId: toolUseId(data),
        result: data.result,
        toolUseResult: data.tool_use_result,
        isError: data.is_error === true,
      })
      break
    case 'control_request':
      if (data.request?.subtype === 'ask_user_question') {
        const raw = data.request.questions
        const questions = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object'
            ? [raw]
            : []
        m._appendPart({
          type: 'ask_user_question',
          id: data.request.question_id,
          questions,
          status: 'pending',
        })
        set({ isAwaitingInteraction: true })
      } else if (data.request?.subtype === 'can_use_tool') {
        m._appendPart({
          type: 'can_use_tool',
          id: data.request_id,
          toolName: data.request.tool_name,
          title: data.request.title,
          description: data.request.description,
          status: 'pending',
        })
        set({ isAwaitingInteraction: true })
      } else if (data.request?.subtype === 'approve_plan') {
        m._appendPlanApprovalPart({
          requestId: data.request_id,
          plan: data.request.plan,
        })
      }
      break
    case 'result':
      if (data.subtype === 'error') {
        m._appendPart({ type: 'error', message: data.error })
      } else if (data.subtype === 'success' && data.reason === 'done') {
        m._removeThinking()
      }
      set({
        turnState: 'idle',
        turnDetail: null,
        turnStateLabel: null,
        turnStateSince: Date.now(),
      })
      break
  }
}
