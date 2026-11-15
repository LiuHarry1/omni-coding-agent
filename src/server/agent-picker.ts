/**
 * Resolve ModePicker visibility + session defaults from AppConfig.agents
 * and discovered agent definitions.
 *
 * Semantics:
 * - picker.modes omitted → all external modes; [] → hide mode rows (agent
 *   permission still allowed for specialists)
 * - picker.primaries omitted → all mode:primary agents; [] → none
 * - default.agentType must be a visible primary or falls back to null
 *
 * Client store should treat GET /agents `picker` as source of truth and only
 * check membership in the returned lists (plus modes=[] → agent-only).
 */
import type { AgentDefinition, AppConfig } from '../core/types.js'
import {
  EXTERNAL_MODES,
  isValidExternalMode,
  type ExternalMode,
} from '../utils/permissions/permission-mode.js'

export interface ResolvedAgentPicker {
  modes: ExternalMode[]
  primaries: AgentDefinition[]
  default: {
    mode: ExternalMode
    agentType: string | null
  }
}

/** Lightweight shape shared with clients (ids only for primaries). */
export interface AgentPickerAllowlist {
  modes: readonly string[]
  primaries: readonly string[]
}

function allPrimaryAgents(
  agents: readonly AgentDefinition[],
): AgentDefinition[] {
  return agents.filter(a => a.mode === 'primary')
}

export function resolveAgentPicker(
  agentsConfig: AppConfig['agents'] | undefined,
  agents: readonly AgentDefinition[],
): ResolvedAgentPicker {
  const primaryPool = allPrimaryAgents(agents)
  const picker = agentsConfig?.picker
  const def = agentsConfig?.default

  const modes: ExternalMode[] =
    picker?.modes === undefined
      ? [...EXTERNAL_MODES]
      : picker.modes.filter(isValidExternalMode)

  let primaries: AgentDefinition[]
  if (picker?.primaries === undefined) {
    primaries = primaryPool
  } else {
    const allow = new Set(picker.primaries)
    primaries = primaryPool.filter(a => allow.has(a.agentType))
  }

  const visibleTypes = new Set(primaries.map(a => a.agentType))

  let mode: ExternalMode =
    def?.mode && isValidExternalMode(def.mode) ? def.mode : 'agent'
  if (modes.length > 0 && !modes.includes(mode)) {
    mode = modes[0]!
  }

  let agentType: string | null =
    def?.agentType === undefined ? null : def.agentType
  if (agentType !== null && !visibleTypes.has(agentType)) {
    agentType = null
  }
  if (agentType !== null) {
    mode = 'agent'
  }

  return {
    modes,
    primaries,
    default: { mode, agentType },
  }
}

/** True when mode may appear in the picker / be set via API. */
export function isModeAllowedByPicker(
  resolved: Pick<ResolvedAgentPicker, 'modes'> | AgentPickerAllowlist,
  mode: string,
): boolean {
  if (!isValidExternalMode(mode)) return false
  if (resolved.modes.length === 0) return mode === 'agent'
  return (resolved.modes as readonly string[]).includes(mode)
}

function primaryIds(
  resolved: ResolvedAgentPicker | AgentPickerAllowlist,
): readonly string[] {
  if (resolved.primaries.length === 0) return []
  const first = resolved.primaries[0]
  if (typeof first === 'string') {
    return resolved.primaries as readonly string[]
  }
  return (resolved.primaries as AgentDefinition[]).map(a => a.agentType)
}

/**
 * True when agentType may be selected.
 * null (default coding) only when the Agent mode row is visible, or when
 * there are no primaries at all. Specialist-only (modes=[], primaries>0)
 * rejects null.
 */
export function isAgentTypeAllowedByPicker(
  resolved: ResolvedAgentPicker | AgentPickerAllowlist,
  agentType: string | null,
): boolean {
  const ids = primaryIds(resolved)
  if (agentType === null) {
    if ((resolved.modes as readonly string[]).includes('agent')) return true
    return resolved.modes.length === 0 && ids.length === 0
  }
  return ids.includes(agentType)
}

/** Specialist-only product: no mode rows, at least one primary. */
export function isSpecialistOnlyPicker(
  resolved: ResolvedAgentPicker | AgentPickerAllowlist,
): boolean {
  return resolved.modes.length === 0 && primaryIds(resolved).length > 0
}
