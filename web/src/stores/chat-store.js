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
import { streamChatTurn, streamSessionLive } from './chat/stream-chat.js'

function syncSessionPickerSelection(get, { mode, agentType }) {
  const { currentSessionId, workspace } = get()
  if (!currentSessionId) return
  const ws = workspace || undefined
  if (mode != null) {
    agentApi
      .setSessionMode({
        session_id: currentSessionId,
        mode,
        workspace: ws,
      })
      .catch(() => {})
  }
  if (agentType !== undefined) {
    agentApi
      .setSessionAgent({
        session_id: currentSessionId,
        agentType,
        workspace: ws,
      })
      .catch(() => {})
  }
}

function applyLocalPickerSelection(set, { mode, agentType }) {
  if (agentType) {
    localStorage.setItem('coding_agent_type', agentType)
    localStorage.setItem('coding_agent_mode', 'agent')
    set({ agentMode: 'agent', agentType })
  } else {
    localStorage.setItem('coding_agent_mode', mode || 'agent')
    localStorage.removeItem('coding_agent_type')
    set({ agentMode: mode || 'agent', agentType: null })
  }
}

export const useChatStore = create((set, get) => {
  const mutators = createAssistantMutators(set, get)

  const handleSse = data => applySseEvent(data, { set, get, mutators })

  return {
    // ── Sessions ────────────────────────────────
    sessions: [],
    currentSessionId: localStorage.getItem('coding_agent_session_id') || null,
    sessionLoading: Boolean(localStorage.getItem('coding_agent_session_id')),
    /** Display label e.g. `atsrws0049:/home/...` when using execution environments. */
    workspaceLabel: null,
    /** Bound WorkspaceHandle from execution plane. */
    workspaceHandle: null,

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
    /** True while a scheduled-task turn is rendering from /sessions/:id/live. */
    scheduledTurnActive: false,
    /** Open live SSE only when this session has (or just got) a timer. */
    liveNeeded: false,

    // ── UI state ────────────────────────────────
    workspace: '',
    theme: localStorage.getItem('coding_agent_theme') || 'dark',

    // ── Agent mode (Agent / Ask / Plan) ─────────
    agentMode: localStorage.getItem('coding_agent_mode') || 'agent',
    /** Main-thread primary agent profile (null = default Agent). */
    agentType: localStorage.getItem('coding_agent_type') || null,
    /** Last picker allowlist from GET /agents (workspace-scoped). */
    agentPicker: null,
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

    setWorkspace: workspace => set({ workspace }),

    /**
     * Apply workspace picker from GET /agents.
     * If current mode/agentType is outside the allowlist, snap to picker.default
     * and sync the live session when present.
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

      const { agentMode, agentType } = get()
      const modeOk = isModeAllowedByPicker(allowlist, agentMode)
      const typeOk = isAgentTypeAllowedByPicker(allowlist, agentType)

      if (!modeOk || !typeOk) {
        const nextMode = def.mode || 'agent'
        const nextType = def.agentType ?? null
        applyLocalPickerSelection(set, {
          mode: nextType ? 'agent' : nextMode,
          agentType: nextType,
        })
        syncSessionPickerSelection(get, {
          mode: nextType ? 'agent' : nextMode,
          agentType: nextType,
        })
      }
    },

    /** Fetch GET /agents and populate picker + ModePicker rows. */
    loadAgentPicker: async workspace => {
      set({ agentPickerLoaded: false })
      try {
        const data = await agentApi.getAgents(workspace || undefined)
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
          agentPickerPrimaries: [],
          agentPickerLoaded: true,
        })
      }
    },

    setAgentMode: mode => {
      const picker = get().agentPicker
      if (picker && !isModeAllowedByPicker(picker, mode)) return

      const specialistOnly = isSpecialistOnlyPicker(picker)
      // Specialist-only: stay on agent permission but keep current primary.
      if (specialistOnly && mode === 'agent') {
        localStorage.setItem('coding_agent_mode', 'agent')
        set({ agentMode: 'agent' })
        const { currentSessionId, workspace, agentType } = get()
        if (currentSessionId) {
          agentApi
            .setSessionMode({
              session_id: currentSessionId,
              mode: 'agent',
              workspace: workspace || undefined,
            })
            .catch(() => {})
          if (agentType) {
            agentApi
              .setSessionAgent({
                session_id: currentSessionId,
                agentType,
                workspace: workspace || undefined,
              })
              .catch(() => {})
          }
        }
        return
      }

      localStorage.setItem('coding_agent_mode', mode)
      localStorage.removeItem('coding_agent_type')
      set({ agentMode: mode, agentType: null })
      const { currentSessionId, workspace } = get()
      if (currentSessionId) {
        agentApi
          .setSessionMode({
            session_id: currentSessionId,
            mode,
            workspace: workspace || undefined,
          })
          .catch(() => {})
        if (mode === 'agent') {
          agentApi
            .setSessionAgent({
              session_id: currentSessionId,
              agentType: null,
              workspace: workspace || undefined,
            })
            .catch(() => {})
        }
      }
    },

    setAgentType: agentType => {
      const next = agentType || null
      const picker = get().agentPicker
      if (picker && !isAgentTypeAllowedByPicker(picker, next)) return
      if (next) {
        localStorage.setItem('coding_agent_type', next)
        localStorage.setItem('coding_agent_mode', 'agent')
        set({ agentType: next, agentMode: 'agent' })
      } else {
        localStorage.removeItem('coding_agent_type')
        set({ agentType: null })
      }
      const { currentSessionId, workspace } = get()
      if (currentSessionId) {
        agentApi
          .setSessionAgent({
            session_id: currentSessionId,
            agentType: next,
            workspace: workspace || undefined,
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
        if (['agent', 'ask', 'plan'].includes(nextMode)) {
          localStorage.setItem('coding_agent_mode', nextMode)
        }
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
        get().clearSession()
        return
      }
      localStorage.setItem('coding_agent_session_id', id)
      set({
        currentSessionId: id,
        ...emptyTranscript(),
        todos: [],
        sessionLoading: true,
        isAwaitingInteraction: false,
        liveNeeded: false,
        scheduledTurnActive: false,
        planState: { status: 'idle', content: '', filePath: null },
      })
      try {
        const [data, scheduled] = await Promise.all([
          agentApi.getSessionMessages(id),
          agentApi.getScheduledTasks(id).catch(() => ({ tasks: [] })),
        ])
        if (get().currentSessionId !== id) return
        const msgs = sanitizeMessagesForUi(
          (data.messages || []).map(m => (m.id ? m : { ...m, id: newId() })),
        )
        const next = messagesToBubbles(msgs)
        const tasks = Array.isArray(scheduled?.tasks) ? scheduled.tasks : []
        set({
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
          activeTurnId: null,
          sessionLoading: false,
          liveNeeded: tasks.length > 0,
        })
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
      localStorage.removeItem('coding_agent_session_id')
      set({
        currentSessionId: null,
        ...emptyTranscript(),
        todos: [],
        sessionLoading: false,
        isAwaitingInteraction: false,
        liveNeeded: false,
        scheduledTurnActive: false,
        planState: { status: 'idle', content: '', filePath: null },
      })
    },

    stopStreaming: async () => {
      const { abortController, currentSessionId } = get()
      // On Esc: settle tools + show Interrupted immediately, then cancel.
      get()._onInterrupted({ tool_use: true })
      set({
        isStreaming: false,
        isAwaitingInteraction: false,
        abortController: null,
      })

      let cancelled = false
      if (currentSessionId) {
        try {
          const data = await agentApi.cancelChat(currentSessionId)
          cancelled = data?.ok === true
        } catch (err) {
          console.warn('[chat] cancelChat failed', err)
        }
      }
      if (abortController) {
        if (!cancelled) {
          abortController.abort()
          return
        }
        // Server accepted cancel — give SSE a moment, then force-close.
        const ac = abortController
        setTimeout(() => {
          if (!ac.signal.aborted) ac.abort()
        }, 2_000)
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
      if (!text.trim() || get().isStreaming || get().sessionLoading) return

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

      set(s => {
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
          abortController,
          currentStep: 0,
          activeTurnId: assistantMsgId,
          bubbleOrder: next.bubbleOrder,
          bubblesById: next.bubblesById,
        }
      })

      let wireImages = []
      let wireAttachments = []

      if (isComposerAtt) {
        try {
          const up = await agentApi.uploadChatAttachments(
            get().currentSessionId,
            attachments.map(a => a.file),
          )
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

      const body = {
        message: text,
        workspace: get().workspaceHandle?.cwd || get().workspace,
        session_id: get().currentSessionId,
        mode: get().agentMode,
        agentType: get().agentType,
        environmentId: get().workspaceHandle?.environmentId || 'local',
      }
      if (wireImages.length > 0) body.images = wireImages
      if (wireAttachments.length > 0) body.attachments = wireAttachments

      try {
        const meta = await streamChatTurn({
          body,
          signal: abortController.signal,
          onEvent: handleSse,
          onSessionNotFound: () => {
            get().setSessionId(null)
          },
          onHttpError: ({ status, message }) => {
            get()._appendPart({
              type: 'error',
              message: status === 404 ? `HTTP ${status}: ${message}` : message,
            })
            set({
              isStreaming: false,
              abortController: null,
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
            localStorage.setItem('coding_agent_mode', meta.permissionMode)
            set({ agentMode: meta.permissionMode })
          }
        }
        if (meta.agentType !== undefined) {
          const nextType = meta.agentType || null
          if (nextType) localStorage.setItem('coding_agent_type', nextType)
          else localStorage.removeItem('coding_agent_type')
          set({ agentType: nextType })
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          get()._appendPart({ type: 'error', message: err.message })
        }
      }

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
        abortController: null,
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

// Dev-only: browser / CDP harness can inject transcript fixtures.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__BAIZE_CHAT_STORE__ = useChatStore
}
