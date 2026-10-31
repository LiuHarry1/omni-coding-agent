import type { IncomingMessage, ServerResponse } from 'http'
import { createSession, getSession, canAccessSession } from '../session.js'
import { readBody, sendJSON, wantsStreamingResponse } from '../http.js'
import { sessionToUIMessages } from '../session-ui.js'
import { resolveRequestCwd } from '../request-cwd.js'
import type { AuthedRequest } from '../auth/identity.js'
import { EventBus } from '../../core/event-bus.js'
import {
  attachUsageTelemetry,
  flushUsage,
  reportUserQuestion,
} from '../telemetry.js'
import {
  checkQuota,
  commitQuota,
  shouldEnforceQuota,
  trackTurnTokens,
} from '../quota.js'
import {
  handlePlanModeTransition,
  isValidExternalMode,
  transitionPermissionMode,
} from '../../core/permission-mode.js'
import { appendModeChange, appendAgentChange } from '../session.js'
import type { Message, RunAgentFn } from '../../core/types.js'
import { runChatTurn } from '../../turn/run-chat-turn.js'
import { loadWorkspaceContributions } from '../../core/workspace-load.js'
import { findPrimaryAgent } from '../../tools/AgentTool/mergeAgents.js'
import {
  applyPickerDefaultsToSession,
  loadResolvedAgentPicker,
  pickerAgentTypeError,
  pickerModeError,
} from '../../core/agent-picker-workspace.js'
import { normalizeWorkspacePath } from '../../core/workspace-path.js'
import {
  isChatAttachmentRef,
  type ChatAttachmentRef,
} from '../../utils/attachments/from-chat-upload.js'
import { CHAT_ATTACHMENT_MAX_COUNT } from '../../constants/attachment-types.js'
import {
  attachDurableRunStream,
  createDurableRun,
  RunAlreadyActiveError,
  startDurableRun,
} from '../../services/runs/run-manager.js'
import { getRequestScope, resolveAgentHome } from '../../utils/request-scope.js'

export function resolveChatWorkspaceBinding(
  req: IncomingMessage,
  requestedWorkspace: string | undefined,
  requestedEnvironmentId: string | undefined,
  resolvedCwd: string,
): { environmentId: string; cwd: string } {
  // The auth gate is the authority for tenant workspace/environment. A client
  // path or environment selector must never override that server-side binding.
  if ((req as AuthedRequest).userWorkspace) {
    return {
      environmentId: 'local',
      cwd: normalizeWorkspacePath(resolvedCwd),
    }
  }
  return {
    environmentId:
      typeof requestedEnvironmentId === 'string' &&
      requestedEnvironmentId.length > 0
        ? requestedEnvironmentId
        : 'local',
    cwd: normalizeWorkspacePath(
      typeof requestedWorkspace === 'string' && requestedWorkspace.length > 0
        ? requestedWorkspace
        : resolvedCwd,
    ),
  }
}

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON' })
    return
  }

  const {
    message,
    workspace,
    session_id,
    images,
    attachments,
    mode,
    agentType,
    environmentId,
  } = body as {
    message?: string
    workspace?: string
    session_id?: string
    /** @deprecated Image-only predecessor of `attachments`. */
    images?: string[]
    attachments?: unknown[]
    mode?: string
    agentType?: string | null
    /** Optional: bind/use execution environment (default local). */
    environmentId?: string
  }
  if (!message) {
    sendJSON(res, 400, { error: "Missing 'message' field" })
    return
  }
  if (
    Array.isArray(attachments) &&
    attachments.length > CHAT_ATTACHMENT_MAX_COUNT
  ) {
    sendJSON(res, 400, {
      error: `Too many attachments (max ${CHAT_ATTACHMENT_MAX_COUNT})`,
    })
    return
  }

  const wantsStream = wantsStreamingResponse(req, body)

  const requesterEmail = (req as AuthedRequest).user?.email
  let session
  if (session_id) {
    session = getSession(session_id)
    if (
      !session ||
      !canAccessSession(
        session,
        requesterEmail,
        (req as AuthedRequest).user?.role,
      )
    ) {
      sendJSON(res, 404, { error: `Session not found: ${session_id}` })
      return
    }
  }

  // Resolve cwd from Session.workspace handle when present; else legacy path.
  let cwd: string
  if ((req as AuthedRequest).userWorkspace) {
    cwd = normalizeWorkspacePath((req as AuthedRequest).userWorkspace!)
  } else if (session?.workspace) {
    cwd = normalizeWorkspacePath(session.workspace.cwd)
  } else {
    cwd = resolveRequestCwd(req, workspace)
  }

  if (!session) {
    session = createSession(requesterEmail)
  }

  // Bind when missing, or repair a legacy authenticated Session that was
  // previously allowed to persist a client-selected workspace/environment.
  if (!session.workspace || (req as AuthedRequest).userWorkspace) {
    const binding = resolveChatWorkspaceBinding(
      req,
      workspace,
      environmentId,
      cwd,
    )
    const envId = binding.environmentId
    const bindCwd = binding.cwd
    if (envId !== 'local') {
      // Remote: require an absolute-looking remote path from the picker.
      if (
        !bindCwd ||
        bindCwd.includes('\\') ||
        (!bindCwd.startsWith('/') && !bindCwd.startsWith('~'))
      ) {
        sendJSON(res, 400, {
          error:
            'Remote workspace not bound. Use Remote picker to connect and Open Folder first.',
        })
        return
      }
    }
    const normalizedCwd = normalizeWorkspacePath(bindCwd)
    if (
      !session.workspace ||
      session.workspace.environmentId !== envId ||
      normalizeWorkspacePath(session.workspace.cwd) !== normalizedCwd
    ) {
      const { setSessionWorkspace } = await import('../session.js')
      setSessionWorkspace(session.id, {
        environmentId: envId,
        cwd: normalizedCwd,
      })
    }
    cwd = normalizedCwd
  } else {
    cwd = normalizeWorkspacePath(session.workspace.cwd)
  }

  await handleChatRequest(req, res, runAgent, session, {
    message,
    images,
    attachments: Array.isArray(attachments)
      ? attachments.filter(isChatAttachmentRef)
      : undefined,
    mode,
    agentType: agentType === undefined ? undefined : agentType,
    wantsStream,
    cwd,
    requesterEmail,
  })
}

/** Validate a request, create a durable Run, and attach this HTTP client. */
async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runAgent: RunAgentFn,
  session: NonNullable<ReturnType<typeof getSession>>,
  opts: {
    message: string
    images?: string[]
    attachments?: ChatAttachmentRef[]
    mode?: string
    agentType?: string | null
    wantsStream: boolean
    cwd: string
    requesterEmail?: string
  },
): Promise<void> {
  const {
    message,
    images,
    attachments,
    mode,
    agentType,
    wantsStream,
    cwd,
    requesterEmail,
  } = opts

  if (!session.permissionMode) {
    session.permissionMode = { mode: 'agent' }
  }

  if (session.agentType === undefined) {
    session.agentType = null
  }

  const picker = await loadResolvedAgentPicker(cwd)
  const isFreshSession = session.messages.length === 0

  // New session with no client override → workspace picker defaults.
  if (isFreshSession && mode === undefined && agentType === undefined) {
    applyPickerDefaultsToSession(session, picker)
  }

  // Fresh chat: stale localStorage mode/agentType must not 400 — snap to
  // picker.default. Resume / later turns still reject illegal values.
  let effectiveMode = mode
  let effectiveAgentType = agentType
  if (isFreshSession) {
    let snap = false
    if (effectiveMode !== undefined) {
      if (
        !isValidExternalMode(effectiveMode) ||
        pickerModeError(picker, effectiveMode)
      ) {
        snap = true
      }
    }
    if (effectiveAgentType !== undefined) {
      const nextType =
        effectiveAgentType === null || effectiveAgentType === ''
          ? null
          : String(effectiveAgentType)
      if (pickerAgentTypeError(picker, nextType)) snap = true
    }
    if (snap) {
      applyPickerDefaultsToSession(session, picker)
      effectiveMode = undefined
      effectiveAgentType = undefined
    }
  }

  if (effectiveMode !== undefined) {
    if (!isValidExternalMode(effectiveMode)) {
      sendJSON(res, 400, { error: `Invalid mode '${effectiveMode}'` })
      return
    }
    const modeErr = pickerModeError(picker, effectiveMode)
    if (modeErr) {
      sendJSON(res, 400, { error: modeErr })
      return
    }
  }

  if (effectiveAgentType !== undefined) {
    const nextType =
      effectiveAgentType === null || effectiveAgentType === ''
        ? null
        : String(effectiveAgentType)
    const typeErr = pickerAgentTypeError(picker, nextType)
    if (typeErr) {
      sendJSON(res, 400, { error: typeErr })
      return
    }
  }

  if (
    effectiveMode &&
    isValidExternalMode(effectiveMode) &&
    effectiveMode !== session.permissionMode.mode
  ) {
    const from = session.permissionMode.mode
    handlePlanModeTransition(from, effectiveMode, session)
    session.permissionMode = transitionPermissionMode(
      from,
      effectiveMode,
      session.permissionMode,
    )
    if (effectiveMode === 'ask' || effectiveMode === 'plan') {
      session.agentType = null
    }
    appendModeChange(session.id, session)
  }

  // Sync main-thread profile from client (before session exists, or on resume).
  if (
    effectiveAgentType !== undefined &&
    (effectiveMode === undefined || effectiveMode === 'agent')
  ) {
    const nextType =
      effectiveAgentType === null || effectiveAgentType === ''
        ? null
        : String(effectiveAgentType)
    if (nextType !== (session.agentType ?? null)) {
      if (nextType !== null) {
        const { agents } = await loadWorkspaceContributions(cwd)
        const profile = findPrimaryAgent(agents.activeAgents, nextType)
        if (profile) {
          session.agentType = nextType
          if (session.permissionMode.mode !== 'agent') {
            const from = session.permissionMode.mode
            handlePlanModeTransition(from, 'agent', session)
            session.permissionMode = transitionPermissionMode(
              from,
              'agent',
              session.permissionMode,
            )
          }
          appendAgentChange(session.id, session)
        }
      } else {
        session.agentType = null
        appendAgentChange(session.id, session)
      }
    }
  }

  // Preview: collapse newlines to keep one log entry per line, and slice by
  // code points (not UTF-16 units) so a wide char is never cut in half.
  const preview = [...message.replace(/\s+/g, ' ')].slice(0, 80).join('')
  console.log(
    `[server] chat [session:${session.id.slice(0, 8)}] [mode:${session.permissionMode.mode}] [${session.messages.length} prior msgs] ${preview}`,
  )

  const eventBus = new EventBus()
  const telemetryCtx = {
    sessionId: session.id,
    userEmail: session.ownerEmail,
  }
  const requesterRole = (req as AuthedRequest).user?.role
  const quotaUser = session.ownerEmail ?? requesterEmail
  const turnUsage = { tokens: 0 }
  const unsubTurnTokens = trackTurnTokens(eventBus, turnUsage)

  if (shouldEnforceQuota(quotaUser, requesterRole)) {
    try {
      const q = await checkQuota(quotaUser!)
      if (q.exceeded) {
        unsubTurnTokens()
        sendJSON(res, 429, {
          error: 'Daily token limit exceeded',
          quota: q,
        })
        return
      }
    } catch (err) {
      console.warn(`[quota] status check failed: ${(err as Error).message}`)
    }
  }

  const scope = getRequestScope()
  let durableRun
  try {
    durableRun = createDurableRun({
      sessionId: session.id,
      ownerEmail: session.ownerEmail,
      ownerRole: requesterRole,
      agentHome: scope?.agentHome ?? resolveAgentHome(),
      cwd,
      mode: session.permissionMode.mode,
      agentType: session.agentType,
      requestPayload: {
        message,
        images,
        attachments,
      },
    })
  } catch (error) {
    unsubTurnTokens()
    if (error instanceof RunAlreadyActiveError) {
      sendJSON(res, 409, {
        error:
          'A previous message is still being processed for this session. ' +
          'Please wait for it to finish.',
        session_id: session.id,
        ...(error.runId ? { run_id: error.runId } : {}),
      })
      return
    }
    throw error
  }

  const quotaEventId = `${session.id}:run:${durableRun.runId}:attempt:${durableRun.attempt + 1}`
  let quotaFinished = false
  const finishQuota = async (): Promise<void> => {
    if (quotaFinished) return
    quotaFinished = true
    unsubTurnTokens()
    if (shouldEnforceQuota(quotaUser, requesterRole)) {
      try {
        await commitQuota(quotaUser!, turnUsage.tokens, quotaEventId)
      } catch (err) {
        console.warn(`[quota] commit failed: ${(err as Error).message}`)
      }
    }
  }

  reportUserQuestion(telemetryCtx, session.messages.length, message)
  const unsubTelemetry = attachUsageTelemetry(eventBus, telemetryCtx)

  const sseHeaders: Record<string, string> = {
    'X-Session-Id': session.id,
    'X-Permission-Mode': session.permissionMode.mode,
    'X-Agent-Type': session.agentType ?? '',
  }

  const messagesBefore = session.messages.length
  if (wantsStream) {
    attachDurableRunStream(durableRun.runId, res, 0, sseHeaders)
  }

  const runPromise = startDurableRun(
    durableRun.runId,
    async (transport, _state, abortSignal) => {
      try {
        return await runChatTurn({
          message,
          session,
          cwd,
          runAgent,
          transport,
          images,
          attachments,
          mode: effectiveMode,
          eventBus,
          durableRunId: durableRun.runId,
          abortSignal,
        })
      } finally {
        await finishQuota()
        unsubTelemetry()
        void flushUsage()
      }
    },
  )

  if (wantsStream) {
    // The durable run owns its lifecycle. This request now owns only one
    // subscriber and may return even while the response remains open.
    void runPromise
    return
  }

  const result = await runPromise
  if (res.destroyed || res.writableEnded) return
  if (result.error) {
    sendJSON(res, 500, {
      session_id: session.id,
      run_id: durableRun.runId,
      mode: session.permissionMode.mode,
      error: result.error.message,
    })
    return
  }

  sendJSON(res, 200, {
    session_id: session.id,
    run_id: durableRun.runId,
    mode: session.permissionMode.mode,
    text: result.finalText,
    reason: result.reason,
    messages: sessionToUIMessages(
      session.messages.slice(messagesBefore) as Message[],
    ),
  })
}
