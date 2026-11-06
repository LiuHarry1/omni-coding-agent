/**
 * Chat UI store (orchestrator).
 *
 * Session / mode / theme / send-stop live here.
 * SSE transport → stream-chat.js (local lib/sse.js parseSSE)
 * Event → parts → apply-sse-event.js + assistant-mutators.js
 * IDE side effects → ide-bridge.js
 */
import { create } from 'zustand'
import { agentApi } from '../lib/api/agent.js'
import { getUser, isSuperUser } from '../lib/auth.js'
import {
  setWorkspaceSwitchGuard,
  useWorkspaceContextStore,
} from './workspace-context-store.js'
import {
  isAgentTypeAllowedByPicker,
  isModeAllowedByPicker,
  isSpecialistOnlyPicker,
  pickerBlurb,
} from '../lib/agent-picker.js'
import { newId } from '../lib/utils.js'
import { sanitizeMessagesForUi } from '../lib/sanitize-tool-ui.js'
import {
  emptyTranscript,
  messagesToBubbles,
  appendBubble,
  patchBubble,
  toolBubbleId,
  errorBubbleId,
} from '../lib/bubbles/messages-to-bubbles.js'
import { applySseEvent } from './chat/apply-sse-event.js'
import { createAssistantMutators } from './chat/assistant-mutators.js'
import { refreshIdeAfterAgentTurn } from './chat/ide-bridge.js'
import {
  streamChatTurn,
  streamDurableRun,
  streamSessionLive,
} from './chat/stream-chat.js'

function workspaceSnapshot() {
  const { handle, cwd } = useWorkspaceContextStore.getState()
  const workspace = handle?.cwd || cwd || undefined
  const environmentId = handle?.environmentId || 'local'
  return {
    workspace,
    environmentId,
    handle: workspace ? { environmentId, cwd: workspace } : undefined,
  }
}

function syncSessionPickerSelection(get, { mode, agentType }) {
  const { currentSessionId } = get()
  if (!currentSessionId) return
  const { workspace } = workspaceSnapshot()
  if (mode != null) {
    agentApi
      .setSessionMode({
        session_id: currentSessionId,
        mode,
        workspace,
      })
      .catch(() => {})
  }
  if (agentType !== undefined) {
    agentApi
      .setSessionAgent({
        session_id: currentSessionId,
        agentType,
        workspace,
      })
      .catch(() => {})
  }
}

/** Mode/agent a brand-new chat starts with: the workspace picker default. */
function pickerDefaultSelection(picker) {
  const def = picker?.default ?? { mode: 'agent', agentType: null }
  const agentType = def.agentType ?? null
  return { agentMode: agentType ? 'agent' : def.mode || 'agent', agentType }
}

/** Identifies the workspace a picker allowlist was loaded for. */
function pickerKey(handle) {
  return handle?.environmentId && handle?.cwd
    ? `${handle.environmentId}\u0000${handle.cwd}`
    : null
}

/**
 * Snap mode/agent to the picker default when the current selection is outside
 * the allowlist, and sync the live session when there is one.
 */
function snapSelectionToPicker(set, get, picker) {
  const { agentMode, agentType } = get()
  if (
    isModeAllowedByPicker(picker, agentMode) &&
    isAgentTypeAllowedByPicker(picker, agentType)
  ) {
    return
  }
  const selection = pickerDefaultSelection(picker)
  set(selection)
  syncSessionPickerSelection(get, {
    mode: selection.agentMode,
    agentType: selection.agentType,
  })
}

// Mode used to be remembered globally, so one Ask session leaked Ask into
// every new chat. It is per-session now; drop the stale keys.
localStorage.removeItem('coding_agent_mode')
localStorage.removeItem('coding_agent_type')

export const useChatStore = create((set, get) => {
  const mutators = createAssistantMutators(set, get)

  const handleSse = data => {
    const seq = Number.parseInt(data?.__eventId ?? '', 10)
    if (Number.isFinite(seq)) {
      set({ lastRunSeq: Math.max(get().lastRunSeq || 0, seq) })
    }
    applySseEvent(data, { set, get, mutators })
  }

  return {
    // ── Sessions ────────────────────────────────
    sessions: [],
    currentSessionId: localStorage.getItem('coding_agent_session_id') || null,
    sessionLoading: Boolean(localStorage.getItem('coding_agent_session_id')),
    sessionReadOnly: false,
    viewingOwnerEmail: null,

    // ── Transcript (flat bubbles) ──────────────
    bubbleOrder: [],
    bubblesById: {},
    activeTurnId: null,

    // ── Todos ──────────────────────────────────
    todos: [],

    // ── Streaming state ─────────────────────────
    isStreaming: false,
    currentStep: 0,
    abortController: null,
    currentRunId: null,
    lastRunSeq: 0,
    runConnectionStatus: 'idle',
    turnGeneration: 0,
    turnState: 'idle',
    turnDetail: null,
    turnStateLabel: null,
    turnStateSince: 0,
    /** True while a scheduled-task turn is rendering from /sessions/:id/live. */
    scheduledTurnActive: false,
    /** Open live SSE only when this session has (or just got) a timer. */
    liveNeeded: false,

    // ── UI state ────────────────────────────────
    theme: localStorage.getItem('coding_agent_theme') || 'dark',

    // ── Agent mode (Agent / Ask / Plan) ─────────
    agentMode: 'agent',
    /** Main-thread primary agent profile (null = default Agent). */
    agentType: null,
    /** Last picker allowlist from GET /agents (workspace-scoped). */
    agentPicker: null,
    /** `pickerKey` of the workspace `agentPicker` was loaded for. */
    agentPickerFor: null,
    /** User picked a mode/agent in a chat that has no session yet. */
    draftSelectionChosen: false,
    /** Primary rows for ModePicker UI (id/label/desc). */
    agentPickerPrimaries: [],
    agentPickerLoaded: false,
    planState: {
      status: 'idle',
      content: '',
      filePath: null,
    },
    isAwaitingInteraction: false,

    // Transcript mutators (also used via get() inside apply-sse-event)
    ...mutators,

    // ── Actions ─────────────────────────────────

    /**
     * Apply workspace picker from GET /agents.
     * A new chat the user has not touched starts at picker.default; otherwise
     * a mode/agentType outside the allowlist snaps to picker.default and the
     * live session is synced when present.
     */
    applyAgentPicker: picker => {
      if (!picker || typeof picker !== 'object') return
      const modes = Array.isArray(picker.modes)
        ? picker.modes
        : ['agent', 'ask', 'plan']
      const primaries = Array.isArray(picker.primaries) ? picker.primaries : []
      const def = picker.default ?? { mode: 'agent', agentType: null }
      const allowlist = { modes, primaries, default: def }
      set({ agentPicker: allowlist })

      if (!get().currentSessionId && !get().draftSelectionChosen) {
        set(pickerDefaultSelection(allowlist))
        return
      }
      snapSelectionToPicker(set, get, allowlist)
    },

    /** Fetch GET /agents and populate picker + ModePicker rows. */
    loadAgentPicker: async workspace => {
      const target = workspace || workspaceSnapshot().handle
      if (!target?.environmentId || !target?.cwd) return
      set({ agentPickerLoaded: false })
      try {
        const data = await agentApi.getAgents(target)
        const picker = data?.picker
        const modes = Array.isArray(picker?.modes)
          ? picker.modes
          : ['agent', 'ask', 'plan']
        const list = Array.isArray(picker?.primaries) ? picker.primaries : []
        const primariesUi = list.map(a => ({
          id: a.agentType,
          label: a.label || a.agentType,
          desc: pickerBlurb(a.whenToUse, a.description),
        }))
        get().applyAgentPicker({
          modes,
          primaries: primariesUi.map(p => p.id),
          default: picker?.default ?? { mode: 'agent', agentType: null },
        })
        set({
          agentPickerFor: pickerKey(target),
          agentPickerPrimaries: primariesUi,
          agentPickerLoaded: true,
        })
      } catch {
        set({
          agentPicker: {
            modes: ['agent', 'ask', 'plan'],
            primaries: [],
            default: { mode: 'agent', agentType: null },
          },
          agentPickerFor: pickerKey(target),
          agentPickerPrimaries: [],
          agentPickerLoaded: true,
        })
      }
    },

    setAgentMode: mode => {
      const picker = get().agentPicker
      if (picker && !isModeAllowedByPicker(picker, mode)) return
      if (!get().currentSessionId) set({ draftSelectionChosen: true })

      const specialistOnly = isSpecialistOnlyPicker(picker)
      // Specialist-only: stay on agent permission but keep current primary.
      if (specialistOnly && mode === 'agent') {
        set({ agentMode: 'agent' })
        const { currentSessionId, agentType } = get()
        const { workspace } = workspaceSnapshot()
        if (currentSessionId) {
          agentApi
            .setSessionMode({
              session_id: currentSessionId,
              mode: 'agent',
              workspace,
            })
            .catch(() => {})
          if (agentType) {
            agentApi
              .setSessionAgent({
                session_id: currentSessionId,
                agentType,
                workspace,
              })
              .catch(() => {})
          }
        }
        return
      }

      set({ agentMode: mode, agentType: null })
      const { currentSessionId } = get()
      const { workspace } = workspaceSnapshot()
      if (currentSessionId) {
        agentApi
          .setSessionMode({
            session_id: currentSessionId,
            mode,
            workspace,
          })
          .catch(() => {})
        if (mode === 'agent') {
          agentApi
            .setSessionAgent({
              session_id: currentSessionId,
              agentType: null,
              workspace,
            })
            .catch(() => {})
        }
      }
    },

    setAgentType: agentType => {
      const next = agentType || null
      const picker = get().agentPicker
      if (picker && !isAgentTypeAllowedByPicker(picker, next)) return
      if (!get().currentSessionId) set({ draftSelectionChosen: true })
      if (next) {
        set({ agentType: next, agentMode: 'agent' })
      } else {
        set({ agentType: null })
      }
      const { currentSessionId } = get()
      const { workspace } = workspaceSnapshot()
      if (currentSessionId) {
        agentApi
          .setSessionAgent({
            session_id: currentSessionId,
            agentType: next,
            workspace,
          })
          .catch(() => {})
      }
    },

    cycleAgentMode: () => {
      const picker = get().agentPicker
      const order =
        picker?.modes?.length > 0
          ? picker.modes
          : picker?.modes?.length === 0
            ? ['agent']
            : ['agent', 'ask', 'plan']
      if (order.length <= 1) return
      const idx = order.indexOf(get().agentMode)
      const next = order[(idx + 1) % order.length]
      get().setAgentMode(next)
    },

    answerQuestion: async (id, answers, extra) => {
      const annotations = extra?.notes
        ? Object.fromEntries(
            Object.keys(answers).map(q => [q, { notes: extra.notes }]),
          )
        : undefined
      await agentApi.answerQuestion({ id, answers, annotations })
      set(s => {
        const bid = `ask:${id}`
        if (s.bubblesById[bid]?.kind !== 'ask') {
          return { isAwaitingInteraction: false }
        }
        return {
          ...patchBubble(s, bid, { status: 'answered', answers }),
          bubbleOrder: s.bubbleOrder,
          isAwaitingInteraction: false,
        }
      })
    },

    answerCanUseTool: async (id, decision) => {
      await agentApi.answerCanUseTool({ id, decision })
      set(s => {
        const bid = `perm:${id}`
        if (s.bubblesById[bid]?.kind !== 'perm') {
          return { isAwaitingInteraction: false }
        }
        return {
          ...patchBubble(s, bid, { status: 'answered', decision }),
          bubbleOrder: s.bubbleOrder,
          isAwaitingInteraction: false,
        }
      })
    },

    approvePlan: async (requestId, opts) => {
      await agentApi.approvePlan({
        request_id: requestId,
        approved: opts.approved,
        edited_plan: opts.editedPlan,
        target_mode: opts.targetMode,
        reason: opts.reason,
      })
      if (opts.approved) {
        const nextMode = opts.targetMode || 'agent'
        set({
          agentMode: nextMode,
          agentType: null,
          planState: {
            status: 'building',
            content: opts.editedPlan ?? get().planState?.content ?? '',
            filePath: get().planState?.filePath ?? null,
          },
        })
        if (!get().isStreaming) {
          set({ isStreaming: true })
        }
        get()._setThinking()
      } else {
        set({
          planState: {
            status: 'idle',
            content: get().planState?.content ?? '',
            filePath: get().planState?.filePath ?? null,
          },
        })
      }
      set(s => {
        const bid = `plan:${requestId}`
        if (s.bubblesById[bid]?.kind !== 'plan') {
          return { isAwaitingInteraction: false }
        }
        return {
          ...patchBubble(s, bid, {
            status: 'answered',
            approved: opts.approved,
          }),
          bubbleOrder: s.bubbleOrder,
          isAwaitingInteraction: false,
        }
      })
    },

    syncHljs: () => {
      const t = get().theme
      const dark = document.getElementById('hljs-dark')
      const light = document.getElementById('hljs-light')
      if (dark && light) {
        dark.disabled = t === 'light'
        light.disabled = t === 'dark'
      }
    },

    toggleTheme: () => {
      const next = get().theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('coding_agent_theme', next)
      set({ theme: next })
      get().syncHljs()
    },

    setSessionId: id => {
      if (id) localStorage.setItem('coding_agent_session_id', id)
      else localStorage.removeItem('coding_agent_session_id')
      set({ currentSessionId: id })
    },

    setSessions: sessions => set({ sessions }),

    setLiveNeeded: liveNeeded => set({ liveNeeded: Boolean(liveNeeded) }),

    refreshSessions: async () => {
      try {
        const data = await agentApi.listSessions()
        set({ sessions: data.sessions || [] })
      } catch {
        /* list is best-effort */
      }
    },

    /**
     * Subscribe to GET /sessions/:id/live so scheduled fires appear without
     * a reload. Returns an unsubscribe that aborts the EventSource-like fetch.
     * @param {string} sessionId
     */
    connectSessionLive: sessionId => {
      const abortController = new AbortController()
      let stopped = false

      const settleScheduledTurn = () => {
        if (!get().scheduledTurnActive) return
        get()._finalizeAssistant()
        const planPatch =
          get().planState?.status === 'building'
            ? {
                planState: {
                  ...get().planState,
                  status: 'idle',
                },
              }
            : {}
        set({
          isStreaming: false,
          turnState: 'idle',
          turnDetail: null,
          turnStateLabel: null,
          isAwaitingInteraction: false,
          activeTurnId: null,
          scheduledTurnActive: false,
          ...planPatch,
        })
        refreshIdeAfterAgentTurn()
        void get().refreshSessions()
      }

      const run = async () => {
        let delay = 1000
        while (!stopped && !abortController.signal.aborted) {
          try {
            await streamSessionLive({
              sessionId,
              signal: abortController.signal,
              onEvent: data => {
                if (stopped || get().currentSessionId !== sessionId) return
                handleSse(data)
                if (
                  data.type === 'system' &&
                  data.subtype === 'scheduled_turn'
                ) {
                  void get().refreshSessions()
                }
                if (data.type === 'result') settleScheduledTurn()
              },
            })
            delay = 1000
          } catch (err) {
            if (stopped || abortController.signal.aborted) return
            if (err?.name === 'AbortError') return
            if (err?.status === 404) return
          }
          if (stopped || abortController.signal.aborted) return
          await new Promise(resolve => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 15_000)
        }
      }
      void run()
      return () => {
        stopped = true
        abortController.abort()
      }
    },

    switchSession: async id => {
      if (!id) {
        get().abortController?.abort()
        get().clearSession()
        return
      }
      // A new chat learns its id while the turn is already on screen. Reloading
      // here aborts that turn and drops the optimistic user bubble; the stream
      // replay only has assistant events, so the user's message never returns.
      if (get().isStreaming && get().currentSessionId === id) return
      get().abortController?.abort()
      const selectedSession = get().sessions.find(session => session.id === id)
      const me = getUser()
      const readOnly = Boolean(
        selectedSession?.ownerEmail &&
        isSuperUser(me) &&
        selectedSession.ownerEmail !== me?.email,
      )
      localStorage.setItem('coding_agent_session_id', id)
      set({
        currentSessionId: id,
        sessionReadOnly: readOnly,
        viewingOwnerEmail: readOnly ? selectedSession.ownerEmail : null,
        ...emptyTranscript(),
        todos: [],
        sessionLoading: true,
        isAwaitingInteraction: false,
        isStreaming: false,
        abortController: null,
        currentRunId: null,
        lastRunSeq: 0,
        runConnectionStatus: 'idle',
        turnState: 'idle',
        turnDetail: null,
        turnStateLabel: null,
        liveNeeded: false,
        scheduledTurnActive: false,
        planState: { status: 'idle', content: '', filePath: null },
      })
      try {
        let data
        let scheduled = { tasks: [] }
        if (readOnly) {
          data = await agentApi.getSessionMessages(id)
        } else {
          ;[data, scheduled] = await Promise.all([
            agentApi.getSessionMessages(id),
            agentApi.getScheduledTasks(id).catch(() => ({ tasks: [] })),
            useWorkspaceContextStore.getState().syncFromSession(id),
          ])
        }
        if (get().currentSessionId !== id) return
        const msgs = sanitizeMessagesForUi(
          (data.messages || []).map(m => (m.id ? m : { ...m, id: newId() })),
        )
        const next = messagesToBubbles(msgs)
        const tasks = Array.isArray(scheduled?.tasks) ? scheduled.tasks : []
        const activeRun = data.active_run
        const isActiveRun =
          activeRun &&
          !['finished', 'error', 'cancelled', 'interrupted'].includes(
            activeRun.status,
          )
        const resumedTurnId = isActiveRun
          ? [...next.bubbleOrder]
              .reverse()
              .map(bubbleId => next.bubblesById[bubbleId]?.turnId)
              .find(Boolean) || newId()
          : null
        const runAbortController = isActiveRun ? new AbortController() : null
        const sessionSelection = ['agent', 'ask', 'plan'].includes(data.mode)
          ? { agentMode: data.mode, agentType: data.agentType ?? null }
          : {}
        set({
          ...sessionSelection,
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
          activeTurnId: resumedTurnId,
          sessionLoading: false,
          isStreaming: Boolean(isActiveRun),
          abortController: runAbortController,
          currentRunId: isActiveRun ? activeRun.run_id : null,
          lastRunSeq: isActiveRun ? activeRun.checkpoint_seq || 0 : 0,
          runConnectionStatus: isActiveRun ? 'connected' : 'idle',
          liveNeeded: tasks.length > 0,
        })
        // A picker loaded for another workspace would snap (and sync) against
        // the wrong allowlist; the pending reload validates via applyAgentPicker.
        const { agentPicker, agentPickerLoaded, agentPickerFor } = get()
        if (
          agentPicker &&
          agentPickerLoaded &&
          agentPickerFor &&
          agentPickerFor === pickerKey(workspaceSnapshot().handle)
        ) {
          snapSelectionToPicker(set, get, agentPicker)
        }
        if (isActiveRun && runAbortController) {
          get()._setThinking()
          void (async () => {
            try {
              await streamDurableRun({
                runId: activeRun.run_id,
                afterSeq: activeRun.checkpoint_seq || 0,
                signal: runAbortController.signal,
                onEvent: data => {
                  if (
                    get().currentSessionId === id &&
                    get().abortController === runAbortController
                  ) {
                    set({ runConnectionStatus: 'connected' })
                    handleSse(data)
                  }
                },
                onReconnecting: () => {
                  if (get().currentRunId === activeRun.run_id) {
                    set({ runConnectionStatus: 'reconnecting' })
                  }
                },
              })
            } catch (err) {
              if (err?.name !== 'AbortError') {
                console.warn('[chat] durable run reconnect failed', err)
              }
            } finally {
              if (
                get().currentSessionId === id &&
                get().currentRunId === activeRun.run_id &&
                get().abortController === runAbortController
              ) {
                get()._finalizeAssistant()
                set({
                  isStreaming: false,
                  abortController: null,
                  currentRunId: null,
                  runConnectionStatus: 'idle',
                  turnState: 'idle',
                  turnDetail: null,
                  turnStateLabel: null,
                  isAwaitingInteraction: false,
                  activeTurnId: null,
                })
                refreshIdeAfterAgentTurn()
                void get().refreshSessions()
              }
            }
          })()
        }
      } catch (err) {
        if (get().currentSessionId !== id) return
        if (
          err.status === 404 ||
          String(err.message).includes('Session not found')
        ) {
          get().clearSession()
        } else {
          console.warn('[chat] failed to load session messages', id, err)
          set({ sessionLoading: false })
        }
      }
    },

    clearSession: () => {
      get().abortController?.abort()
      void useWorkspaceContextStore.getState().syncFromSession(null)
      localStorage.removeItem('coding_agent_session_id')
      set({
        ...pickerDefaultSelection(get().agentPicker),
        draftSelectionChosen: false,
        currentSessionId: null,
        sessionReadOnly: false,
        viewingOwnerEmail: null,
        ...emptyTranscript(),
        todos: [],
        sessionLoading: false,
        isStreaming: false,
        abortController: null,
        currentRunId: null,
        lastRunSeq: 0,
        runConnectionStatus: 'idle',
        turnState: 'idle',
        turnDetail: null,
        turnStateLabel: null,
        isAwaitingInteraction: false,
        liveNeeded: false,
        scheduledTurnActive: false,
        planState: { status: 'idle', content: '', filePath: null },
      })
    },

    stopStreaming: async () => {
      const { currentSessionId, currentRunId } = get()
      // On Esc: settle tools + show Interrupted immediately, then cancel.
      get()._onInterrupted({ tool_use: true })
      set({
        isStreaming: false,
        turnState: 'idle',
        turnDetail: null,
        turnStateLabel: null,
        isAwaitingInteraction: false,
      })

      if (currentRunId || currentSessionId) {
        try {
          if (currentRunId) await agentApi.cancelRun(currentRunId)
          else await agentApi.cancelChat(currentSessionId)
        } catch (err) {
          console.warn('[chat] explicit run cancel failed', err)
          get()._appendPart({
            type: 'error',
            message: 'Failed to cancel the run. It may still be running.',
          })
        }
      }
    },

    /**
     * Stop a single in-flight subagent (Agent tool) without aborting the turn.
     */
    stopSubagent: async toolCallId => {
      if (!toolCallId) return
      const sessionId = get().currentSessionId
      if (!sessionId) return

      set(s => {
        const id = toolBubbleId(toolCallId)
        const b = s.bubblesById[id]
        if (!b || b.kind !== 'tool' || b.status === 'done') return s
        return {
          ...patchBubble(s, id, { stopping: true, liveTask: 'Stopping…' }),
          bubbleOrder: s.bubbleOrder,
        }
      })

      try {
        await agentApi.abortTool({
          session_id: sessionId,
          tool_use_id: toolCallId,
        })
      } catch (err) {
        console.warn('[chat] abortTool failed', err)
        set(s => {
          const id = toolBubbleId(toolCallId)
          if (!s.bubblesById[id]) return s
          return {
            ...patchBubble(s, id, { stopping: false, liveTask: undefined }),
            bubbleOrder: s.bubbleOrder,
          }
        })
      }
    },

    /**
     * Send a message and process the SSE response stream.
     * @param {string} text
     * @param {Array<string|{kind:string,name:string,size:number,previewUrl:string|null,file:File}>} [attachments]
     */
    sendMessage: async (text, attachments = []) => {
      if (
        !text.trim() ||
        get().isStreaming ||
        get().sessionLoading ||
        get().sessionReadOnly
      )
        return

      const abortController = new AbortController()

      const isComposerAtt =
        attachments.length > 0 &&
        typeof attachments[0] === 'object' &&
        attachments[0] != null &&
        'file' in attachments[0]

      const userMsgId = newId()
      const assistantMsgId = newId()
      const previewUrls = isComposerAtt
        ? attachments.map(a => a.previewUrl).filter(Boolean)
        : []
      // Non-image attachments render as chips, so the bubble needs their
      // names before the upload round-trip resolves.
      const fileChips = isComposerAtt
        ? attachments
            .filter(a => a.kind !== 'image')
            .map(a => ({ name: a.name, kind: a.kind, size: a.size }))
        : []

      let turnGeneration = 0
      set(s => {
        turnGeneration = s.turnGeneration + 1
        let next = appendBubble(s, {
          id: userMsgId,
          kind: 'user',
          content: text,
          images: previewUrls.length > 0 ? previewUrls : undefined,
          files: fileChips.length > 0 ? fileChips : undefined,
          turnStartTime: Date.now(),
        })
        return {
          isStreaming: true,
          turnGeneration,
          turnState: 'dispatching',
          turnDetail: 'turn.submit',
          turnStateLabel: 'Submitting request',
          turnStateSince: Date.now(),
          abortController,
          currentRunId: null,
          lastRunSeq: 0,
          runConnectionStatus: 'connecting',
          currentStep: 0,
          activeTurnId: assistantMsgId,
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })
      const ownsTurn = () =>
        get().turnGeneration === turnGeneration &&
        get().abortController === abortController

      let wireImages = []
      let wireAttachments = []

      if (isComposerAtt) {
        try {
          const up = await agentApi.uploadChatAttachments(
            get().currentSessionId,
            attachments.map(a => a.file),
          )
          if (!ownsTurn()) return
          if (up.session_id) get().setSessionId(up.session_id)
          wireAttachments = up.files || (up.urls || []).map(url => ({ url }))
          const uploadedImages = wireAttachments
            .filter(f => f.kind === 'image' || !f.kind)
            .map(f => f.url)
          set(s => ({
            ...patchBubble(s, userMsgId, {
              images: uploadedImages.length ? uploadedImages : undefined,
            }),
            bubbleOrder: s.bubbleOrder,
          }))
          for (const a of attachments) {
            if (a.previewUrl?.startsWith('blob:')) {
              URL.revokeObjectURL(a.previewUrl)
            }
          }
        } catch (err) {
          if (!ownsTurn()) return
          for (const a of attachments) {
            if (a.previewUrl?.startsWith('blob:')) {
              URL.revokeObjectURL(a.previewUrl)
            }
          }
          set(s => {
            let next = {
              bubbleOrder: s.bubbleOrder.filter(id => id !== userMsgId),
              bubblesById: { ...s.bubblesById },
            }
            delete next.bubblesById[userMsgId]
            const eid = newId()
            next = appendBubble(next, {
              id: errorBubbleId(eid),
              kind: 'error',
              turnId: assistantMsgId,
              message: err?.message || 'Failed to upload attachments',
            })
            return {
              isStreaming: false,
              turnState: 'idle',
              turnDetail: null,
              turnStateLabel: null,
              abortController: null,
              activeTurnId: null,
              bubbleOrder: next.bubbleOrder,
              bubblesById: next.bubblesById,
            }
          })
          return
        }
      } else if (attachments.length > 0) {
        // Legacy callers (replay, tests) pass bare upload URLs for images.
        wireImages = attachments
        set(s => ({
          ...patchBubble(s, userMsgId, { images: undefined }),
          bubbleOrder: s.bubbleOrder,
        }))
      }

      const workspace = workspaceSnapshot()
      const body = {
        message: text,
        workspace: workspace.workspace,
        session_id: get().currentSessionId,
        mode: get().agentMode,
        agentType: get().agentType,
        environmentId: workspace.environmentId,
      }
      if (wireImages.length > 0) body.images = wireImages
      if (wireAttachments.length > 0) body.attachments = wireAttachments

      try {
        const meta = await streamChatTurn({
          body,
          signal: abortController.signal,
          onEvent: data => {
            if (!ownsTurn()) return
            set({ runConnectionStatus: 'connected' })
            handleSse(data)
          },
          onOpen: opened => {
            if (!ownsTurn()) return
            if (opened.sessionId) get().setSessionId(opened.sessionId)
            set({
              currentRunId: opened.runId,
              lastRunSeq: opened.lastSeq || 0,
              runConnectionStatus: 'connected',
            })
          },
          onReconnecting: () => {
            if (ownsTurn()) {
              set({ runConnectionStatus: 'reconnecting' })
            }
          },
          onSessionNotFound: () => {
            if (!ownsTurn()) return
            get().setSessionId(null)
          },
          onHttpError: ({ status, message }) => {
            if (!ownsTurn()) return
            get()._appendPart({
              type: 'error',
              message: status === 404 ? `HTTP ${status}: ${message}` : message,
            })
            set({
              isStreaming: false,
              turnState: 'idle',
              turnDetail: null,
              turnStateLabel: null,
              abortController: null,
              currentRunId: null,
              runConnectionStatus: 'idle',
              activeTurnId: null,
            })
          },
        })

        if (meta === null) return

        if (meta.sessionId) get().setSessionId(meta.sessionId)
        if (
          meta.permissionMode &&
          ['agent', 'ask', 'plan'].includes(meta.permissionMode)
        ) {
          const skipPlanSnap =
            meta.permissionMode === 'plan' &&
            get().planState?.status === 'building'
          if (!skipPlanSnap) {
            set({ agentMode: meta.permissionMode })
          }
        }
        if (meta.agentType !== undefined) {
          set({ agentType: meta.agentType || null })
        }
      } catch (err) {
        if (ownsTurn() && err.name !== 'AbortError') {
          get()._appendPart({ type: 'error', message: err.message })
        }
      }

      // Session switches detach this subscriber; the durable run continues,
      // and the old send must not finalize or overwrite the newly loaded UI.
      if (!ownsTurn()) return
      get()._finalizeAssistant()
      const planPatch =
        get().planState?.status === 'building'
          ? {
              planState: {
                ...get().planState,
                status: 'idle',
              },
            }
          : {}
      set({
        isStreaming: false,
        turnState: 'idle',
        turnDetail: null,
        turnStateLabel: null,
        abortController: null,
        currentRunId: null,
        runConnectionStatus: 'idle',
        isAwaitingInteraction: false,
        activeTurnId: null,
        ...planPatch,
      })
      refreshIdeAfterAgentTurn()
      void get().refreshSessions()
    },

    /** @deprecated Prefer applySseEvent via stream; kept for tests / harness. */
    _handleSSE: (_event, data) => handleSse(data),
  }
})

setWorkspaceSwitchGuard(() => {
  const chat = useChatStore.getState()
  if (chat.isStreaming || chat.sessionLoading) return false
  if (chat.bubbleOrder.length > 0) chat.clearSession()
  return true
})

// Dev-only: browser / CDP harness can inject transcript fixtures.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__baix_CHAT_STORE__ = useChatStore
}
