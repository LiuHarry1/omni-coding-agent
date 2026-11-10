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
    {
      agentHome: location.agentHome,
      cwd: task.workspace?.cwd ?? task.cwd,
    },
    () => {
      const session = getSession(task.sessionId, {
        agentHome: location.agentHome,
      })
      if (!session) return null
      if (
        task.workspace &&
        session.workspace &&
        task.workspace.environmentId !== session.workspace.environmentId
      ) {
        throw new Error(
          `task workspace ${task.workspace.environmentId} does not match ` +
            `session workspace ${session.workspace.environmentId}`,
        )
      }
      if (
        task.workspace?.environmentId !== 'local' &&
        task.workspace &&
        !session.workspace
      ) {
        throw new Error(
          `task ${task.id} has no matching Session workspace binding`,
        )
      }
      if (
        task.environmentId &&
        session.workspace &&
        task.environmentId !== session.workspace.environmentId
      ) {
        throw new Error(
          `legacy task environment ${task.environmentId} does not match ` +
            `session workspace ${session.workspace.environmentId}`,
        )
      }
      const workspace = session.workspace ?? task.workspace
      const turnScope = resolveTurnWorkspaceScope(
        workspace,
        task.cwd,
        session.additionalWorkingDirectories,
      )
      return {
        agentHome: location.agentHome,
        session,
        cwd: turnScope.executionCwd,
        settingsCwd: turnScope.settingsCwd,
        enabled: isScheduledTasksEnabled(turnScope.settingsCwd, true),
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
