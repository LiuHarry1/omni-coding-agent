import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { readBody, sendJSON } from '../http.js'
import { resolveRequestCwd } from '../request-cwd.js'
import {
  applyPickerDefaultsToSession,
  loadResolvedAgentPickerForWorkspace,
  pickerAgentTypeError,
  pickerModeError,
} from '../../core/agent-picker-workspace.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import { normalizeWorkspacePath } from '../../core/workspace-path.js'
import { isValidExternalMode } from '../../core/permission-mode.js'
import { isScheduledTasksEnabled } from '../../services/cron/settings.js'
import {
  cancelCronTask,
  listPublicCronTasks,
  scheduleCronTask,
} from '../../services/cron/schedule.js'
import type { AuthedRequest } from '../auth/identity.js'
import {
  appendAgentChange,
  appendModeChange,
  canAccessSession,
  createSession,
  getSession,
  setSessionWorkspace,
} from '../session.js'
import { getCloudWorkspaceManager } from '../../services/cloud-workspaces/index.js'
import { resolveWorkspaceContext } from '../../services/cloud-workspaces/turn-scope.js'
import { resolveCloudSessionBinding } from './cloud-workspaces.js'

function pathnameOf(url: string | undefined): string {
  return (url ?? '').split('?')[0]
}

function queryOf(url: string | undefined): URLSearchParams {
  return new URLSearchParams((url ?? '').split('?')[1] ?? '')
}

function resolveCwd(
  req: IncomingMessage,
  session: { workspace?: { cwd?: string } } | null,
  clientWorkspace?: unknown,
): string {
  if (session?.workspace?.cwd) {
    return normalizeWorkspacePath(session.workspace.cwd)
  }
  return resolveRequestCwd(req, clientWorkspace)
}

function resolveSettingsCwd(
  session: { workspace?: { environmentId: string; cwd: string } } | null,
  cwd: string,
): string {
  return session
    ? resolveWorkspaceContext(session.workspace, cwd).settingsCwd
    : cwd
}

async function ensureSession(
  req: IncomingMessage,
  sessionId: unknown,
  workspace: unknown,
  environmentId: unknown,
  agentType?: unknown,
  mode?: unknown,
): Promise<
  | {
      ok: true
      session: NonNullable<ReturnType<typeof getSession>>
      created: boolean
    }
  | { ok: false; status: number; error: string }
> {
  const authed = req as AuthedRequest
  const requesterEmail = authed.user?.email
  const requesterRole = authed.user?.role

  const cloud = getCloudWorkspaceManager()
  const bindCloud = async (
    session: NonNullable<ReturnType<typeof getSession>>,
  ): Promise<{ ok: false; status: number; error: string } | null> => {
    if (!cloud) return null
    const binding = await resolveCloudSessionBinding(
      req,
      cloud,
      session,
      environmentId,
    )
    if (!binding.ok) return binding
    if (
      session.workspace?.environmentId !== binding.handle.environmentId ||
      session.workspace?.cwd !== binding.handle.cwd
    ) {
      setSessionWorkspace(session.id, binding.handle)
    }
    return null
  }

  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const session = getSession(sessionId)
    if (!session || !canAccessSession(session, requesterEmail, requesterRole)) {
      return { ok: false, status: 404, error: 'Session not found' }
    }
    const failed = await bindCloud(session)
    if (failed) return failed
    return { ok: true, session, created: false }
  }

  const session = createSession(requesterEmail)
  const failed = await bindCloud(session)
  if (failed) return failed
  const cwd =
    session.workspace?.cwd ??
    authed.userWorkspace ??
    (typeof workspace === 'string' &&
    workspace.length > 0 &&
    fs.existsSync(workspace)
      ? path.resolve(workspace)
      : getDefaultWorkspace())
  try {
    const picker = await loadResolvedAgentPickerForWorkspace(
      session.workspace,
      cwd,
    )
    applyPickerDefaultsToSession(session, picker)
    if (typeof mode === 'string' && isValidExternalMode(mode)) {
      if (!pickerModeError(picker, mode)) {
        session.permissionMode = { ...session.permissionMode, mode }
      }
    }
    const requestedType =
      agentType === null || agentType === ''
        ? null
        : typeof agentType === 'string'
          ? agentType
          : undefined
    if (
      requestedType !== undefined &&
      !pickerAgentTypeError(picker, requestedType)
    ) {
      session.agentType = requestedType
    }
    appendModeChange(session.id, session)
    appendAgentChange(session.id, session)
  } catch (e) {
    console.warn(
      `[server] apply picker defaults failed: ${(e as Error).message}`,
    )
  }
  if (!session.workspace && !cloud) {
    const envId =
      typeof environmentId === 'string' && environmentId.length > 0
        ? environmentId
        : 'local'
    setSessionWorkspace(session.id, {
      environmentId: envId,
      cwd: normalizeWorkspacePath(cwd),
    })
  }
  console.log(`[server] new session (scheduled-tasks): ${session.id}`)
  return { ok: true, session, created: true }
}

/**
 * GET    /scheduled-tasks?session_id=&workspace=
 * POST   /scheduled-tasks  { session_id?, workspace?, environmentId?, prompt, cron?, at?, recurring? }
 * DELETE /scheduled-tasks/:id?session_id=
 */
export async function handleScheduledTasks(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method
  const pathname = pathnameOf(req.url)
  if (!pathname.startsWith('/scheduled-tasks')) return false

  const authed = req as AuthedRequest

  if (method === 'GET' && pathname === '/scheduled-tasks') {
    const q = queryOf(req.url)
    const sessionId = q.get('session_id')
    const workspace = q.get('workspace')
    let session = null
    if (sessionId) {
      session = getSession(sessionId)
      if (
        !session ||
        !canAccessSession(session, authed.user?.email, authed.user?.role)
      ) {
        sendJSON(res, 404, { error: 'Session not found' })
        return true
      }
    }
    const cwd = resolveCwd(req, session, workspace)
    const enabled = isScheduledTasksEnabled(resolveSettingsCwd(session, cwd))
    sendJSON(res, 200, {
      enabled,
      session_id: session?.id ?? null,
      tasks: enabled && session ? listPublicCronTasks(session.id) : [],
    })
    return true
  }

  if (method === 'POST' && pathname === '/scheduled-tasks') {
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch {
      sendJSON(res, 400, { error: 'Invalid JSON' })
      return true
    }
    const ensured = await ensureSession(
      req,
      body.session_id,
      body.workspace,
      body.environmentId,
      body.agentType,
      body.mode,
    )
    if (!ensured.ok) {
      sendJSON(res, ensured.status, { error: ensured.error })
      return true
    }
    const { session, created } = ensured
    const cwd = resolveCwd(req, session, body.workspace)
    const settingsCwd = resolveSettingsCwd(session, cwd)
    if (!isScheduledTasksEnabled(settingsCwd)) {
      sendJSON(res, 403, {
        enabled: false,
        error:
          'Scheduled tasks are disabled. Set scheduledTasks.enabled=true in .ai-agent/settings.json.',
      })
      return true
    }
    const result = scheduleCronTask({
      cwd,
      settingsCwd,
      sessionId: session.id,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      cron: typeof body.cron === 'string' ? body.cron : undefined,
      at: typeof body.at === 'string' ? body.at : undefined,
      recurring:
        typeof body.recurring === 'boolean' ? body.recurring : undefined,
      workspace: session.workspace,
      environmentId:
        session.workspace?.environmentId ??
        (typeof body.environmentId === 'string'
          ? body.environmentId
          : undefined),
    })
    if (!result.ok) {
      sendJSON(res, result.code === 'disabled' ? 403 : 400, {
        enabled: result.code !== 'disabled',
        error: result.message,
      })
      return true
    }
    sendJSON(res, 200, {
      enabled: true,
      session_id: session.id,
      created_session: created,
      task: {
        id: result.task.id,
        recurring: result.task.recurring,
        nextRunAtMs: result.task.nextRunAtMs,
        prompt: result.task.prompt,
        cron: result.task.cron ?? null,
        schedule: result.humanSchedule,
      },
    })
    return true
  }

  const deleteMatch = pathname.match(/^\/scheduled-tasks\/([^/]+)$/)
  if (method === 'DELETE' && deleteMatch) {
    const id = decodeURIComponent(deleteMatch[1]!)
    const q = queryOf(req.url)
    const sessionId = q.get('session_id')
    if (!sessionId) {
      sendJSON(res, 400, { error: "Missing 'session_id'" })
      return true
    }
    const session = getSession(sessionId)
    if (
      !session ||
      !canAccessSession(session, authed.user?.email, authed.user?.role)
    ) {
      sendJSON(res, 404, { error: 'Session not found' })
      return true
    }
    const cwd = resolveCwd(req, session, q.get('workspace'))
    if (!isScheduledTasksEnabled(resolveSettingsCwd(session, cwd))) {
      sendJSON(res, 403, {
        enabled: false,
        error: 'Scheduled tasks are disabled.',
      })
      return true
    }
    const { removed } = cancelCronTask(session.id, id)
    if (!removed) {
      sendJSON(res, 404, { error: `No scheduled task ${id} in this session.` })
      return true
    }
    sendJSON(res, 200, { deleted: id })
    return true
  }

  return false
}
