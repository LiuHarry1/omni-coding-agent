import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import {
  WORKSPACE_SEEDED_MARKER,
  getWorkspaceSeedDir,
  seedUserWorkspaceIfNeeded,
} from '../../core/workspace-seed.js'
import {
  abortTurn,
  getTurnAbortController,
} from '../../core/turn-abort-registry.js'
import { invalidateMCPManagersForCwd } from '../../core/mcp-lifecycle.js'
import { resetSettingsCache } from '../../core/settings-manager.js'
import { closeBrowser } from '../../browser/manager.js'
import { getExecutionPlane } from '../../execution/bootstrap.js'
import { resolveExecutionBackend } from '../../execution/resolve-backend.js'
import { stopTask } from '../../tasks/stopTask.js'
import {
  clearSessionTasks,
  listRunningTasks,
} from '../../utils/task/framework.js'
import { removeTasksForSessions } from '../../services/cron/store.js'
import { kickCronScheduler } from '../../services/cron/scheduler.js'
import { getUsersRoot, type AuthedRequest } from '../auth/identity.js'
import { forgetSession, getSession, listSessions } from '../session.js'
import { readBody, sendJSON } from '../http.js'

const resetting = new Set<string>()

function keyFor(workspace: string): string {
  return path.resolve(workspace)
}

export function isWorkspaceResetting(workspace: string): boolean {
  return resetting.has(keyFor(workspace))
}

function assertSafeTenantWorkspace(workspace: string): void {
  const usersRoot = path.resolve(getUsersRoot())
  const target = path.resolve(workspace)
  fs.mkdirSync(usersRoot, { recursive: true })

  if (path.dirname(target) !== usersRoot || target === usersRoot) {
    throw new Error('Refusing to reset a path outside USERS_ROOT')
  }
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Refusing to reset a non-directory or symbolic link')
  }
  const realRoot = fs.realpathSync(usersRoot)
  const realTarget = fs.realpathSync(target)
  if (path.dirname(realTarget) !== realRoot) {
    throw new Error('Workspace resolves outside USERS_ROOT')
  }
}

async function stopSessionActivity(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) abortTurn(id, 'external')

  await Promise.all(
    sessionIds.map(async id => {
      const session = getSession(id)
      const runningTasks = listRunningTasks(id)
      if (session && runningTasks.length > 0) {
        let execution
        try {
          execution = await resolveExecutionBackend(session)
        } catch {
          execution = undefined
        }
        for (const task of runningTasks) {
          await stopTask(id, task.id, execution).catch(() => {})
        }
      }
      await closeBrowser(id).catch(() => {})
      clearSessionTasks(id)
    }),
  )

  const deadline = Date.now() + 10_000
  while (
    sessionIds.some(id => getTurnAbortController(id)) &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (sessionIds.some(id => getTurnAbortController(id))) {
    throw new Error('Timed out waiting for active agent work to stop')
  }
}

export async function resetTenantWorkspace(
  workspace: string,
  ownerEmail: string,
): Promise<{ sessionsRemoved: number; scheduledTasksRemoved: number }> {
  assertSafeTenantWorkspace(workspace)
  const sessionIds = listSessions(ownerEmail).map(session => session.id)

  await stopSessionActivity(sessionIds)

  const foundRuntime = getExecutionPlane().runtimes.findByCwd(workspace)
  if (foundRuntime) {
    await getExecutionPlane().runtimes.close(foundRuntime.handle)
  }
  invalidateMCPManagersForCwd(workspace)

  const scheduledTasksRemoved = removeTasksForSessions(sessionIds, workspace)
  kickCronScheduler()
  for (const id of sessionIds) forgetSession(id)
  resetSettingsCache()

  const quarantine = path.join(
    path.dirname(workspace),
    `.${path.basename(workspace)}.reset-${randomUUID()}`,
  )
  assertSafeTenantWorkspace(workspace)
  fs.renameSync(workspace, quarantine)
  try {
    fs.mkdirSync(workspace, { recursive: true })
    seedUserWorkspaceIfNeeded(workspace)
    const seedDir = getWorkspaceSeedDir()
    if (
      seedDir &&
      !fs.existsSync(path.join(workspace, WORKSPACE_SEEDED_MARKER))
    ) {
      throw new Error('Workspace seed did not complete')
    }
  } catch (err) {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.renameSync(quarantine, workspace)
    throw err
  }

  fs.rmSync(quarantine, { recursive: true, force: true })
  return { sessionsRemoved: sessionIds.length, scheduledTasksRemoved }
}

export async function handleWorkspaceReset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST' || req.url !== '/workspace/reset') return false

  const authed = req as AuthedRequest
  if (!authed.userWorkspace || !authed.user?.email) {
    sendJSON(res, 403, { error: 'Workspace reset requires SSO authentication' })
    return true
  }

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendJSON(res, 400, { error: 'Invalid JSON' })
    return true
  }
  if (body.confirmation !== 'RESET') {
    sendJSON(res, 400, { error: 'Type RESET to confirm' })
    return true
  }

  const workspace = keyFor(authed.userWorkspace)
  if (resetting.has(workspace)) {
    sendJSON(res, 409, { error: 'Workspace reset already in progress' })
    return true
  }

  resetting.add(workspace)
  try {
    const result = await resetTenantWorkspace(workspace, authed.user.email)
    sendJSON(res, 200, { ok: true, ...result })
  } catch (err) {
    console.error(
      `[workspace-reset] ${workspace}: ${err instanceof Error ? err.message : err}`,
    )
    sendJSON(res, 500, {
      error: err instanceof Error ? err.message : 'Workspace reset failed',
    })
  } finally {
    resetting.delete(workspace)
  }
  return true
}
