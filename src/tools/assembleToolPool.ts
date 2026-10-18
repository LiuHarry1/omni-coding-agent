/**
 * Assemble the active / deferred / mode tool pool for one turn.
 * Built-ins + MCP live on the registry; Agent/Skill must be registered first.
 */
import { filterToolsByEnablement } from '../core/tool-enablement.js'
import {
  BROWSER_AGENT_TYPE,
  browserDenyGlobsForMainThread,
  isBrowserEnabledForMainThread,
} from '../browser/enablement.js'
import { createToolSearchDefinition } from './ToolSearchTool/ToolSearchTool.js'
import {
  BROWSER_TOOL_NAMES,
  CRON_TOOL_NAMES,
  ENTER_PLAN_MODE_TOOL_NAME,
  READ_ONLY_TOOLS,
  TOOL_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import { definition as enterPlanModeDef } from './EnterPlanModeTool/EnterPlanModeTool.js'
import { definition as exitPlanModeDef } from './ExitPlanModeTool/ExitPlanModeTool.js'
import { findPrimaryAgent } from './AgentTool/mergeAgents.js'
import {
  filterDeferredDefsByAllowList,
  filterDeferredDefsByDisallowedGlobs,
  filterToolsRecordByAllowList,
  filterToolsRecordByDisallowedGlobs,
} from './AgentTool/toolGlob.js'
import type {
  AgentDefinition,
  AnyTool,
  Session,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import type { ToolRegistry } from '../core/tool-registry.js'
import type { ToolEnablementSource } from '../core/tool-enablement.js'
import type { BrowserConfig } from '../browser/types.js'
import { isScheduledTasksEnabled } from '../services/cron/settings.js'

export interface AssembleToolPoolInput {
  registry: ToolRegistry
  cwd: string
  session: Session
  toolContext: ToolContext
  mcpTools: Record<string, AnyTool>
  activeAgents: AgentDefinition[]
  toolEnablement: ToolEnablementSource
  browserConfig?: BrowserConfig
}

export interface AssembleToolPoolResult {
  tools: Record<string, AnyTool>
  /** Tools before mode filtering -- used to refresh when mode changes mid-turn. */
  baseTools: Record<string, AnyTool>
  modeTools: Record<string, AnyTool>
  deferredToolPool?: Record<string, AnyTool>
  deferredDefs: Array<{ name: string; description: string; isMcp: boolean }>
  /**
   * Definitions built per turn instead of living on the registry (ToolSearch).
   * The executor needs them to reach `mapToolResultToToolResultBlockParam` /
   * `outputSchema`; a registry lookup alone would miss them.
   */
  dynamicDefs: Record<string, ToolDefinition>
  mainThreadProfile: AgentDefinition | null
  /** Re-applied after mid-turn mode refresh so ExitPlanMode cannot sneak back. */
  denyGlobs: string[] | undefined
}

export function assembleToolPool(
  input: AssembleToolPoolInput,
): AssembleToolPoolResult {
  const {
    registry,
    cwd,
    session,
    toolContext,
    mcpTools,
    activeAgents,
    toolEnablement,
    browserConfig,
  } = input

  let { active, deferred, deferredDefs } = registry.createSplit(
    cwd,
    toolContext,
    mcpTools,
    session.discoveredTools,
  )

  const mainThreadProfile = findPrimaryAgent(activeAgents, session.agentType)
  const mainAgentType =
    mainThreadProfile?.agentType ?? session.agentType ?? null
  const denyGlobs = [
    ...browserDenyGlobsForMainThread(mainAgentType, browserConfig),
    ...(mainThreadProfile?.disallowedTools ?? []),
    ...(!isScheduledTasksEnabled(cwd) ? CRON_TOOL_NAMES : []),
  ]
  if (denyGlobs.length > 0) {
    active = filterToolsRecordByDisallowedGlobs(active, denyGlobs)
    deferred = filterToolsRecordByDisallowedGlobs(deferred, denyGlobs)
    deferredDefs = filterDeferredDefsByDisallowedGlobs(deferredDefs, denyGlobs)
    if (
      mainThreadProfile ||
      !isBrowserEnabledForMainThread(mainAgentType, browserConfig)
    ) {
      console.log(
        `[server] agentType=${mainAgentType ?? 'default'} denied globs=[${denyGlobs.join(', ')}]`,
      )
    }
  }

  const allowList = mainThreadProfile?.tools
  if (allowList && allowList.length > 0) {
    active = filterToolsRecordByAllowList(active, allowList)
    deferred = filterToolsRecordByAllowList(deferred, allowList)
    deferredDefs = filterDeferredDefsByAllowList(deferredDefs, allowList)
    console.log(
      `[server] agentType=${mainThreadProfile!.agentType} allowed tools=[${allowList.join(', ')}]`,
    )
  }

  // A primary's allow-list is the job, not a deferred lookup.
  // Qwen (and others) call ToolSearch in parallel with browser_* and the
  // sibling calls fail because activation only happens on the next step.
  if (
    mainThreadProfile &&
    ((allowList && allowList.length > 0) ||
      mainThreadProfile.agentType === BROWSER_AGENT_TYPE)
  ) {
    const promote =
      allowList && allowList.length > 0 ? allowList : [...BROWSER_TOOL_NAMES]
    for (const name of promote) {
      if (deferred[name]) {
        active[name] = deferred[name]!
        delete deferred[name]
      }
    }
    deferredDefs = deferredDefs.filter(d => deferred[d.name])
  } else {
    deferredDefs = deferredDefs.filter(d => deferred[d.name])
  }

  const dynamicDefs: Record<string, ToolDefinition> = {}
  if (deferredDefs.length > 0 && session.permissionMode.mode !== 'ask') {
    const tsearchDef = createToolSearchDefinition(deferredDefs)
    active[TOOL_SEARCH_TOOL_NAME] = tsearchDef.create(cwd, toolContext)
    dynamicDefs[TOOL_SEARCH_TOOL_NAME] = tsearchDef
  }

  const enablementFiltered = filterToolsByEnablement(
    active,
    registry,
    toolEnablement,
  )

  const modeTools: Record<string, AnyTool> = {
    [enterPlanModeDef.name]: enterPlanModeDef.create(cwd, toolContext),
    [exitPlanModeDef.name]: exitPlanModeDef.create(cwd, toolContext),
  }

  // Ask mode: promote read-only deferred tools (LSP/WebSearch/…) into the
  // active set. Do not expose ToolSearch or mutating/MCP deferred tools.
  if (session.permissionMode.mode === 'ask') {
    const readOnly = new Set<string>(READ_ONLY_TOOLS)
    for (const name of READ_ONLY_TOOLS) {
      if (deferred[name] && !enablementFiltered[name]) {
        enablementFiltered[name] = deferred[name]!
      }
    }
    for (const name of Object.keys(deferred)) {
      if (!readOnly.has(name)) delete deferred[name]
    }
    // No ToolSearch in ask — mutating deferred tools stay withheld.
  }

  let tools = applyModeRestrictions(
    session.permissionMode.mode,
    enablementFiltered,
    modeTools,
  )
  if (denyGlobs.length > 0) {
    tools = filterToolsRecordByDisallowedGlobs(tools, denyGlobs)
  }
  // Browser specialist cannot edit code; plan mode is for implementation design.
  if (mainThreadProfile?.agentType === BROWSER_AGENT_TYPE) {
    delete tools[ENTER_PLAN_MODE_TOOL_NAME]
  }

  const askMode = session.permissionMode.mode === 'ask'
  const deferredForTurn = askMode ? {} : deferred
  const deferredDefsForTurn = askMode ? [] : deferredDefs

  return {
    tools,
    baseTools: enablementFiltered,
    modeTools,
    deferredToolPool:
      Object.keys(deferredForTurn).length > 0 ? deferredForTurn : undefined,
    deferredDefs: deferredDefsForTurn,
    dynamicDefs,
    mainThreadProfile,
    denyGlobs: denyGlobs.length > 0 ? denyGlobs : undefined,
  }
}
