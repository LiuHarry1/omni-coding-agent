import { resolveSettings } from '../../core/settings-manager.js'
import { getDefaultWorkspace } from '../../core/workspace.js'
import type { Session } from '../../core/types.js'
import { getSession } from '../../session/store.js'
import { findSessionLocation } from '../../session/session-index.js'
import { runWithRequestScope } from '../../utils/request-scope.js'
import { resolveTurnWorkspaceScope } from '../cloud-workspaces/turn-scope.js'
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
  cwd: string
  settingsCwd: string
  enabled: boolean
}

/**
 * Resolve a persisted task through its owning session before reading settings.
 * This is safe to call from the process-level scheduler where no request ALS
 * exists yet.
 */
export function resolveScheduledTaskContext(
  task: ScheduledTask,
): ScheduledTaskContext | null {
  const location = findSessionLocation(task.sessionId)
  if (!location) return null

  return runWithRequestScope(
    { agentHome: location.agentHome, cwd: task.cwd },
    () => {
      const session = getSession(task.sessionId, {
        agentHome: location.agentHome,
      })
      if (!session) return null
      const cwd = session.workspace?.cwd ?? task.cwd
      const settingsCwd = resolveTurnWorkspaceScope(
        session.workspace,
        cwd,
      ).settingsCwd
      return {
        agentHome: location.agentHome,
        session,
        cwd,
        settingsCwd,
        enabled: isScheduledTasksEnabled(settingsCwd, true),
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
