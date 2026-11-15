/**
 * What each permission mode lets the main thread run. The tool list sent to
 * the model is the same in every mode, so switching modes keeps the prompt
 * cache; the mode is enforced per call instead.
 */
import type { CanUseToolFn } from './can-use-tool.js'
import type { ExternalMode } from './permission-mode.js'
import {
  PLAN_MODE_DENIED_TOOLS,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'

const PLAN_MODE_DENIED = new Set(PLAN_MODE_DENIED_TOOLS)

/**
 * Why `toolName` may not run in `mode`, or undefined when it may.
 * `isReadOnly` says whether every call the tool can make is read-only, as
 * its definition declares; tools without a definition (MCP) are not.
 */
export function modeDenial(
  mode: ExternalMode,
  toolName: string,
  isReadOnly: (toolName: string) => boolean,
): string | undefined {
  switch (mode) {
    case 'ask':
      // ToolSearch only loads schemas; what it finds is checked here when called.
      if (toolName === TOOL_SEARCH_TOOL_NAME || isReadOnly(toolName)) {
        return undefined
      }
      return `${toolName} is not available in Ask mode, which only allows read-only tools. Answer from what you can read, or tell the user to switch to Agent mode to make changes.`
    case 'plan':
      if (toolName === ENTER_PLAN_MODE_TOOL_NAME) {
        return 'Plan mode is already active.'
      }
      if (PLAN_MODE_DENIED.has(toolName)) {
        return `${toolName} is not available in Plan mode. Explore with read-only tools, write the plan file, and call ${EXIT_PLAN_MODE_TOOL_NAME} for approval.`
      }
      return undefined
    case 'agent':
    default:
      if (toolName === EXIT_PLAN_MODE_TOOL_NAME) {
        return `${EXIT_PLAN_MODE_TOOL_NAME} is only available in Plan mode.`
      }
      return undefined
  }
}

/** `canUseTool` that first refuses what the current mode does not allow. */
export function withModeGate(
  canUseTool: CanUseToolFn,
  getMode: () => ExternalMode,
  isReadOnly: (toolName: string) => boolean,
): CanUseToolFn {
  return async (toolName, input, meta) => {
    const denial = modeDenial(getMode(), toolName, isReadOnly)
    if (denial) return { behavior: 'deny', message: denial }
    return canUseTool(toolName, input, meta)
  }
}
