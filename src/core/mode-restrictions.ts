/**
 * Filter active tools by session permission mode.
 */
import type { AnyTool } from './types.js'
import type { ExternalMode } from './permission-mode.js'
import {
  PLAN_MODE_DENIED_TOOLS,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
} from '../constants/tool_names.js'

function omitTools(
  tools: Record<string, AnyTool>,
  denied: Set<string>,
): Record<string, AnyTool> {
  const result: Record<string, AnyTool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (!denied.has(name)) result[name] = tool
  }
  return result
}

function pickTools(
  tools: Record<string, AnyTool>,
  keep: (name: string) => boolean,
): Record<string, AnyTool> {
  const result: Record<string, AnyTool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (keep(name)) result[name] = tool
  }
  return result
}

export type ModeRestrictionOptions = {
  /** Mode-switch tools, added or withheld depending on the mode. */
  extra?: Record<string, AnyTool>
  /**
   * Whether every call the named tool can make is read-only, as its
   * definition declares. Tools without a definition (MCP) are not.
   */
  isReadOnly: (toolName: string) => boolean
}

export function applyModeRestrictions(
  mode: ExternalMode,
  tools: Record<string, AnyTool>,
  options: ModeRestrictionOptions,
): Record<string, AnyTool> {
  const { extra, isReadOnly } = options
  const merged = { ...tools, ...extra }

  switch (mode) {
    case 'ask': {
      // Read-only only. ToolSearch does not declare itself read-only, so it
      // stays out: discovering deferred write/shell/MCP tools would bypass
      // this filter mid-turn (activateDeferredTools mutates activeTools).
      return pickTools(merged, isReadOnly)
    }
    case 'plan': {
      const denied = new Set([
        ...PLAN_MODE_DENIED_TOOLS,
        ENTER_PLAN_MODE_TOOL_NAME,
      ])
      const filtered = omitTools(merged, denied)
      // Ensure ExitPlanMode and AskUserQuestion are present
      if (extra?.[EXIT_PLAN_MODE_TOOL_NAME]) {
        filtered[EXIT_PLAN_MODE_TOOL_NAME] = extra[EXIT_PLAN_MODE_TOOL_NAME]
      }
      if (merged[ASK_USER_QUESTION_TOOL_NAME]) {
        filtered[ASK_USER_QUESTION_TOOL_NAME] =
          merged[ASK_USER_QUESTION_TOOL_NAME]
      }
      return filtered
    }
    case 'agent':
    default: {
      const filtered = { ...merged }
      delete filtered[EXIT_PLAN_MODE_TOOL_NAME]
      if (extra?.[ENTER_PLAN_MODE_TOOL_NAME]) {
        filtered[ENTER_PLAN_MODE_TOOL_NAME] = extra[ENTER_PLAN_MODE_TOOL_NAME]
      }
      return filtered
    }
  }
}
