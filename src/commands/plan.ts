/**
 * /plan slash command — commands/plan/plan.tsx equivalent.
 */
import type { Session } from '../core/types.js'
import {
  handlePlanModeTransition,
  prepareContextForPlanMode,
} from '../utils/permissions/permission-mode.js'
import { getPlan, getPlanFilePath } from '../utils/plans.js'

const PLAN_RE = /^\/plan(?:[ \t]+([\s\S]*))?$/i

export interface PlanSlashResult {
  handled: boolean
  immediateReply?: string
  effectiveMessage?: string
  modeChanged?: boolean
}

export function resolvePlanSlash(
  message: string,
  session: Session,
  cwd: string,
): PlanSlashResult {
  const trimmed = message.trim()
  const match = trimmed.match(PLAN_RE)
  if (!match) return { handled: false }

  const args = (match[1] ?? '').trim()
  const mode = session.permissionMode.mode

  if (mode !== 'plan') {
    handlePlanModeTransition(mode, 'plan', session)
    session.permissionMode = prepareContextForPlanMode(session.permissionMode)

    if (args && args.toLowerCase() !== 'open') {
      return {
        handled: true,
        modeChanged: true,
        effectiveMessage: args,
      }
    }
    if (!args) {
      return {
        handled: true,
        modeChanged: true,
        immediateReply:
          'Entered plan mode. Follow 5-phase workflow: Explore agents → Plan agents → Review/Ask → write plan file → ExitPlanMode.',
      }
    }
  }

  const filePath = getPlanFilePath(session, cwd)

  if (args.toLowerCase() === 'open') {
    return {
      handled: true,
      immediateReply: `Plan file: ${filePath}`,
    }
  }

  const plan = getPlan(session, cwd)
  if (!plan?.trim()) {
    return {
      handled: true,
      immediateReply: `Plan mode active. No plan written yet.\n\nPlan file: ${filePath}`,
    }
  }

  if (args) {
    return {
      handled: true,
      effectiveMessage: args,
    }
  }

  return {
    handled: true,
    immediateReply: `## Current Plan\n\n${plan}\n\n---\nPlan file: ${filePath}\nUse /plan open to get the file path.`,
  }
}
