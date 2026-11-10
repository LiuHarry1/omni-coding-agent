import type { IncomingMessage, ServerResponse } from 'http'
import { readBody, sendJSON } from '../http.js'
import {
  isAuthEnabled,
  isSuperUser,
  type AuthedRequest,
} from '../auth/identity.js'
import { getSession } from '../session.js'
import {
  CloudWorkspaceError,
  getCloudWorkspaceManager,
  type CloudWorkspaceManager,
  type CloudWorkspaceRecord,
} from '../../services/cloud-workspaces/index.js'
import { parseCloudEnvironmentId } from '../../execution/providers/cloud/cloud-provider.js'
import type { WorkspaceHandle } from '../../execution/types.js'
import type { Session } from '../../core/types.js'
import {
  getActiveTurnAgentHome,
  listActiveTurnSessionIds,
} from '../../session/store.js'
import { findSessionLocation } from '../../session/session-index.js'

/** Owner used when auth is off (single-user development). */
const LOCAL_OWNER = 'local@localhost'

export function requesterOwner(req: IncomingMessage): string | undefined {
  const authed = req as AuthedRequest
  if (authed.user?.email) return authed.user.email
  return isAuthEnabled() ? undefined : LOCAL_OWNER
}

/** Cloud workspace ids used by any active HTTP or scheduled turn. */
export function busyCloudWorkspaceIds(): Set<string> {
  const ids = new Set<string>()
  for (const sessionId of listActiveTurnSessionIds()) {
    const location = findSessionLocation(
      sessionId,
      getActiveTurnAgentHome(sessionId),
    )
    if (!location) continue
    const session = getSession(sessionId, { agentHome: location.agentHome })
    const id = parseCloudEnvironmentId(session?.workspace?.environmentId)
    if (id) ids.add(id)
  }
  return ids
}

export type CloudBindingResult =
  | { ok: true; handle: WorkspaceHandle; workspaceId: string }
  | { ok: false; status: number; error: string }

/**
 * Server-side workspace binding for a Session in cloud mode. The client may
 * only *select* one of its own workspaces; a Session that already has history
 * stays on the workspace it started in.
 */
export async function resolveCloudSessionBinding(
  req: IncomingMessage,
  manager: CloudWorkspaceManager,
  session: Session,
  requestedEnvironmentId: unknown,
): Promise<CloudBindingResult> {
  const owner = requesterOwner(req)
  if (!owner)
    return { ok: false, status: 401, error: 'Authentication required' }
  const authed = req as AuthedRequest
  const isSuper = isSuperUser(authed.user)
  const boundId = parseCloudEnvironmentId(session.workspace?.environmentId)
  const requestedId =
    typeof requestedEnvironmentId === 'string'
      ? parseCloudEnvironmentId(requestedEnvironmentId)
      : null
  const selectedId = requestedId ?? boundId
  if (selectedId) manager.refresh(selectedId)

  let record: CloudWorkspaceRecord | undefined
  try {
    if (session.messages.length > 0 && !boundId) {
      return {
        ok: false,
        status: 409,
        error:
          'This existing chat is not bound to a Cloud Workspace. Start a new chat to use Cloud Workspaces.',
      }
    }
    if (boundId && session.messages.length > 0) {
      if (requestedId && requestedId !== boundId) {
        return {
          ok: false,
          status: 409,
          error:
            'This chat belongs to a different workspace. Start a new chat to use the selected one.',
        }
      }
      record = manager.get(boundId)
      if (!record) {
        return {
          ok: false,
          status: 409,
          error: 'The workspace for this chat was deleted. Start a new chat.',
        }
      }
    } else if (requestedId ?? boundId) {
      record = manager.get((requestedId ?? boundId)!)
    } else {
      record = await manager.ensureDefault(owner, authed.user?.username)
    }
  } catch (err) {
    if (err instanceof CloudWorkspaceError) {
      return { ok: false, status: err.status, error: err.message }
    }
    throw err
  }

  if (!record || !manager.canAccess(record, owner, isSuper)) {
    return { ok: false, status: 404, error: 'Workspace not found' }
  }
  if (record.status === 'provisioning') {
    return {
      ok: false,
      status: 409,
      error: `Workspace "${record.name}" is still being imported. Try again shortly.`,
    }
  }
  if (record.status !== 'ready') {
    return {
      ok: false,
      status: 409,
      error: `Workspace "${record.name}" failed to import: ${record.error ?? 'unknown error'}`,
    }
  }
  manager.touch(record.id)
  return {
    ok: true,
    handle: manager.handleFor(record.id),
    workspaceId: record.id,
  }
}

export function toPublicWorkspace(
  manager: CloudWorkspaceManager,
  record: CloudWorkspaceRecord,
  includeOwner = false,
) {
  const handle = manager.handleFor(record.id)
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    status: record.status,
    error: record.error ?? null,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    environmentId: handle.environmentId,
    cwd: handle.cwd,
    ...(includeOwner ? { ownerEmail: record.ownerEmail } : {}),
  }
}

/**
 * Cloud workspace HTTP API (CLOUD_WORKSPACES=docker).
 *
 * GET    /workspaces            { enabled, workspaces }
 * POST   /workspaces            { name?, repoUrl?, ref?, gitToken? } → 202
 * POST   /workspaces/repo-access { repoUrl } → { access }
 * GET    /workspaces/:id
 * PATCH  /workspaces/:id        { name }
 * POST   /workspaces/:id/stop   remove the container, keep the volume
 * DELETE /workspaces/:id        remove container, volume and record
 */
export function createCloudWorkspacesRouter() {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const method = req.method ?? 'GET'
    const pathOnly = (req.url ?? '').split('?')[0]
    if (pathOnly !== '/workspaces' && !pathOnly.startsWith('/workspaces/')) {
      return false
    }

    const manager = getCloudWorkspaceManager()
    if (!manager) {
      if (method === 'GET' && pathOnly === '/workspaces') {
        sendJSON(res, 200, { enabled: false, workspaces: [] })
      } else {
        sendJSON(res, 404, { error: 'Cloud workspaces are not enabled' })
      }
      return true
    }

    const owner = requesterOwner(req)
    if (!owner) {
      sendJSON(res, 401, { error: 'Authentication required' })
      return true
    }
    const authed = req as AuthedRequest
    const isSuper = isSuperUser(authed.user)

    try {
      if (pathOnly === '/workspaces') {
        if (method === 'GET') {
          const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
          const all = isSuper && query.get('all') === '1'
          const records = all ? manager.listAll() : manager.list(owner)
          sendJSON(res, 200, {
            enabled: true,
            limit: manager.config.maxPerUser,
            workspaces: records.map(r => toPublicWorkspace(manager, r, all)),
          })
          return true
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const requestedRepo =
            typeof body.repoUrl === 'string' ? body.repoUrl : undefined
          const submittedToken =
            typeof body.gitToken === 'string' ? body.gitToken : undefined
          const granted = requestedRepo?.trim()
            ? await manager.authorizeRepository(requestedRepo, submittedToken)
            : undefined
          const record = manager.create({
            ownerEmail: owner,
            ownerName: authed.user?.username,
            name: typeof body.name === 'string' ? body.name : undefined,
            repoUrl: granted?.url,
            ref: typeof body.ref === 'string' ? body.ref : undefined,
            gitToken: granted?.gitToken,
          })
          sendJSON(res, 202, { workspace: toPublicWorkspace(manager, record) })
          return true
        }
        sendJSON(res, 405, { error: 'Method not allowed' })
        return true
      }

      if (method === 'POST' && pathOnly === '/workspaces/repo-access') {
        const body = await readBody(req)
        const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl : ''
        const access = await manager.probeRepoAccess(repoUrl)
        sendJSON(res, 200, { access })
        return true
      }

      const match = /^\/workspaces\/([^/]+)(?:\/(stop))?$/.exec(pathOnly)
      const record = match ? manager.get(decodeURIComponent(match[1]!)) : null
      if (!match || !record || !manager.canAccess(record, owner, isSuper)) {
        sendJSON(res, 404, { error: 'Workspace not found' })
        return true
      }
      const action = match[2]

      if (method === 'GET' && !action) {
        sendJSON(res, 200, { workspace: toPublicWorkspace(manager, record) })
        return true
      }
      if (method === 'PATCH' && !action) {
        const body = await readBody(req)
        const updated = manager.rename(record.id, String(body.name ?? ''))
        sendJSON(res, 200, { workspace: toPublicWorkspace(manager, updated) })
        return true
      }
      if (method === 'POST' && action === 'stop') {
        if (busyCloudWorkspaceIds().has(record.id)) {
          sendJSON(res, 409, { error: 'A chat is still running here' })
          return true
        }
        await manager.stop(record.id)
        sendJSON(res, 200, { ok: true })
        return true
      }
      if (method === 'DELETE' && !action) {
        if (busyCloudWorkspaceIds().has(record.id)) {
          sendJSON(res, 409, {
            error: 'Cancel the running chat before deleting this workspace',
          })
          return true
        }
        await manager.remove(record.id)
        sendJSON(res, 200, { deleted: record.id })
        return true
      }
      sendJSON(res, 405, { error: 'Method not allowed' })
      return true
    } catch (err) {
      if (err instanceof CloudWorkspaceError) {
        sendJSON(res, err.status, { error: err.message })
        return true
      }
      sendJSON(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }
}
