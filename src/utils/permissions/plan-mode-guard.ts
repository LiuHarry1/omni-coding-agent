/**
 * Hard enforcement for plan/ask modes — blocks mutating tools before execute.
 */
import * as path from 'path'
import type { Session } from '../../core/types.js'
import type { MiddlewareHandler } from '../../core/types.js'
import { isSessionPlanFile } from '../plans.js'
import {
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  AGENT_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
} from '../../constants/tool_names.js'

const SHELL_TOOLS = new Set([
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
])
const FILE_MUTATING = new Set([WRITE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME])

export class PlanModeGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanModeGuardError'
  }
}

function extractFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const fp = record.file_path ?? record.path
  return typeof fp === 'string' ? fp : null
}

export function createPlanModeGuardMiddleware(
  session: Session,
  cwd: string,
): MiddlewareHandler {
  return async ctx => {
    const mode = session.permissionMode.mode
    if (mode === 'agent') return

    if (mode === 'ask') {
      if (
        SHELL_TOOLS.has(ctx.name) ||
        FILE_MUTATING.has(ctx.name) ||
        ctx.name === AGENT_TOOL_NAME ||
        ctx.name === TODO_WRITE_TOOL_NAME
      ) {
        throw new PlanModeGuardError(
          `Ask mode: "${ctx.name}" is disabled. Switch to Agent mode to make changes.`,
        )
      }
      return
    }

    // plan mode
    if (SHELL_TOOLS.has(ctx.name)) {
      throw new PlanModeGuardError(
        'Plan mode: shell execution is disabled. Finish planning and call ExitPlanMode.',
      )
    }
    if (FILE_MUTATING.has(ctx.name)) {
      const rel = extractFilePath(ctx.args)
      if (!rel) {
        throw new PlanModeGuardError(
          'Plan mode: only the session plan file can be written.',
        )
      }
      const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel)
      if (!isSessionPlanFile(abs, session, cwd)) {
        throw new PlanModeGuardError(
          `Plan mode: writes are restricted to the plan file. Use ExitPlanMode when the plan is ready.`,
        )
      }
    }
  }
}
