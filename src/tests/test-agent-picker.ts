/**
 * Unit checks for resolveAgentPicker allowlist semantics.
 * Run: npx tsx src/tests/test-agent-picker.ts
 */
import type { AgentDefinition } from '../core/types.js'
import {
  isAgentTypeAllowedByPicker,
  isModeAllowedByPicker,
  isSpecialistOnlyPicker,
  resolveAgentPicker,
} from '../server/agent-picker.js'

function primary(name: string): AgentDefinition {
  return {
    agentType: name,
    whenToUse: `${name} whenToUse`,
    description: name,
    systemPrompt: 'x',
    source: 'project',
    mode: 'primary',
  }
}

function sub(name: string): AgentDefinition {
  return {
    agentType: name,
    whenToUse: `${name} whenToUse`,
    description: name,
    systemPrompt: 'x',
    source: 'built-in',
    mode: 'subagent',
  }
}

const agents = [primary('browser'), primary('reviewer'), sub('Explore')]

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// Omit agents config → all modes + all primaries
{
  const r = resolveAgentPicker(undefined, agents)
  assert(r.modes.length === 3, 'default modes')
  assert(
    r.primaries.map(a => a.agentType).join(',') === 'browser,reviewer',
    'all primaries',
  )
  assert(
    r.default.mode === 'agent' && r.default.agentType === null,
    'default coding',
  )
}

// Browser-only
{
  const r = resolveAgentPicker(
    {
      picker: { modes: [], primaries: ['browser'] },
      default: { mode: 'agent', agentType: 'browser' },
    },
    agents,
  )
  assert(r.modes.length === 0, 'no mode rows')
  assert(
    r.primaries.length === 1 && r.primaries[0]!.agentType === 'browser',
    'browser only',
  )
  assert(r.default.agentType === 'browser', 'default browser')
  assert(isModeAllowedByPicker(r, 'agent'), 'agent still allowed')
  assert(!isModeAllowedByPicker(r, 'ask'), 'ask blocked')
  assert(isSpecialistOnlyPicker(r), 'specialist-only')
  assert(
    !isAgentTypeAllowedByPicker(r, null),
    'null blocked when specialist-only',
  )
  assert(isAgentTypeAllowedByPicker(r, 'browser'), 'browser allowed')
  assert(!isAgentTypeAllowedByPicker(r, 'reviewer'), 'reviewer blocked')
}

// Explicit modes + one primary
{
  const r = resolveAgentPicker(
    {
      picker: {
        modes: ['agent', 'ask', 'plan'],
        primaries: ['browser'],
      },
      default: { mode: 'agent', agentType: null },
    },
    agents,
  )
  assert(r.modes.length === 3, 'three modes')
  assert(r.primaries.length === 1, 'one primary')
  assert(isAgentTypeAllowedByPicker(r, null), 'null ok with agent mode')
}

// Invalid default agentType falls back
{
  const r = resolveAgentPicker(
    {
      picker: { primaries: ['browser'] },
      default: { agentType: 'missing' },
    },
    agents,
  )
  assert(r.default.agentType === null, 'invalid default cleared')
}

// Empty primaries
{
  const r = resolveAgentPicker({ picker: { primaries: [] } }, agents)
  assert(r.primaries.length === 0, 'no primaries')
}

console.log('ok agent-picker')
