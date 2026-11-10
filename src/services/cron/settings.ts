import { resolveSettings } from '../../core/settings-manager.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import type { Session } from '../../core/types.js'
import { getSession } from '../../session/store.js'
import { findSessionLocation } from '../../session/session-index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import {
  resolveWorkspaceContext,
  type WorkspaceContext,
} from '../cloud-workspaces/turn-scope.js'
import type { ScheduledTask } from './types.js'

/** Project/user settings: `scheduledTasks.enabled`. Omitted = on. */
export function isScheduledTasksEnabled(
  cwd?: string,
  failClosed = false,
): boolean {
  try {
    const dir = cwd && cwd.trim() ? cwd : getDefaultWorkspace()
    return resolveSettings(dir).config.scheduledTasks?.enabled !== false
  } catch {
    return !failClosed
  }
}

export type ScheduledTaskContext = {
  agentHome: string
  session: Session
  workspace: WorkspaceContext
  enabled: boolean
}

function workspaceMismatch(
  task: ScheduledTask,
  bound: Session['workspace'],
): string | null {
  if (
    task.workspace &&
    bound &&
    task.workspace.environmentId !== bound.environmentId
  ) {
    return `task workspace ${task.workspace.environmentId} does not match session workspace ${bound.environmentId}`
  }
  if (task.workspace && task.workspace.environmentId !== 'local' && !bound) {
    return `session has no binding for task workspace ${task.workspace.environmentId}`
  }
  if (
    task.environmentId &&
    bound &&
    task.environmentId !== bound.environmentId
  ) {
    return `legacy task environment ${task.environmentId} does not match session workspace ${bound.environmentId}`
  }
  return null
}

/**
 * Resolve a persisted task through its owning session before reading settings.
 * This is safe to call from the process-level scheduler where no request ALS
 * exists yet. Returns null for an orphaned task: its session is gone or now
 * bound to a different workspace, so the task can never fire again.
 */
export function resolveScheduledTaskContext(
  task: ScheduledTask,
): ScheduledTaskContext | null {
  const location = findSessionLocation(task.sessionId)
  if (!location) return null

  return runWithRequestScope(
    {
      agentHome: location.agentHome,
      cwd: task.workspace?.cwd ?? task.cwd,
    },
    () => {
      const session = getSession(task.sessionId, {
        agentHome: location.agentHome,
      })
      if (!session) return null
      const mismatch = workspaceMismatch(task, session.workspace)
      if (mismatch) {
        console.warn(`[cron] task ${task.id} is orphaned: ${mismatch}`)
        return null
      }
      const workspace = resolveWorkspaceContext(
        session.workspace ?? task.workspace,
        task.cwd,
      )
      return {
        agentHome: location.agentHome,
        session,
        workspace,
        enabled: isScheduledTasksEnabled(workspace.settingsCwd, true),
      }
    },
  )
}

/** Scheduler-safe settings gate with legacy local-task compatibility. */
export function isScheduledTaskEnabled(task: ScheduledTask): boolean {
  try {
    const context = resolveScheduledTaskContext(task)
    if (context) return context.enabled
    return isScheduledTasksEnabled(task.cwd)
  } catch (error) {
    console.warn(
      `[cron] settings check failed for ${task.id}: ${
        error instanceof Error ? error.message : error
      }`,
    )
    return false
  }
}
