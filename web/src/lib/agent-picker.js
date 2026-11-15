/**
 * Client-side picker allowlist — mirrors src/server/agent-picker.ts.
 * Trust GET /agents `picker` lists; do not re-discover primaries locally.
 */

const EXTERNAL_MODES = ['agent', 'ask', 'plan']

export function isModeAllowedByPicker(picker, mode) {
  if (!EXTERNAL_MODES.includes(mode)) return false
  if (!picker || !Array.isArray(picker.modes)) return true
  if (picker.modes.length === 0) return mode === 'agent'
  return picker.modes.includes(mode)
}

export function isAgentTypeAllowedByPicker(picker, agentType) {
  if (!picker) return true
  const modes = Array.isArray(picker.modes) ? picker.modes : EXTERNAL_MODES
  const primaries = Array.isArray(picker.primaries) ? picker.primaries : []
  if (agentType === null || agentType === undefined || agentType === '') {
    if (modes.includes('agent')) return true
    return modes.length === 0 && primaries.length === 0
  }
  return primaries.includes(agentType)
}

export function isSpecialistOnlyPicker(picker) {
  if (!picker) return false
  const modes = Array.isArray(picker.modes) ? picker.modes : EXTERNAL_MODES
  const primaries = Array.isArray(picker.primaries) ? picker.primaries : []
  return modes.length === 0 && primaries.length > 0
}

/** Short blurb for ModePicker hover tip. */
export function pickerBlurb(whenToUse, fallback = '') {
  const t = String(whenToUse || fallback || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  const m = t.match(/^(.+?[.!?])(?:\s|$)/)
  return m ? m[1] : t.length > 96 ? `${t.slice(0, 96)}…` : t
}
