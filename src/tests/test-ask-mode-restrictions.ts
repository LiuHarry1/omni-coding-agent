/**
 * Ask mode must not expose ToolSearch / deferred mutating tools.
 */
import '../tools.js'
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import { isToolReadOnly } from '../core/tool-definition.js'
import { defaultRegistry } from '../core/tool-registry.js'
import { filterToolsRecordByDisallowedGlobs } from '../tools/AgentTool/toolGlob.js'
import {
  BASH_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const fake = (name: string) => ({ name, description: name }) as never

const isReadOnly = (name: string) => isToolReadOnly(defaultRegistry.get(name))

const tools = {
  [FILE_READ_TOOL_NAME]: fake(FILE_READ_TOOL_NAME),
  [GREP_TOOL_NAME]: fake(GREP_TOOL_NAME),
  mcp__docs__search: fake('mcp__docs__search'),
  [WRITE_FILE_TOOL_NAME]: fake(WRITE_FILE_TOOL_NAME),
  [BASH_TOOL_NAME]: fake(BASH_TOOL_NAME),
  [TOOL_SEARCH_TOOL_NAME]: fake(TOOL_SEARCH_TOOL_NAME),
}

const ask = applyModeRestrictions('ask', tools, { isReadOnly })
assert(!ask[WRITE_FILE_TOOL_NAME], 'ask drops Write')
assert(!ask[BASH_TOOL_NAME], 'ask drops Bash')
assert(!ask[TOOL_SEARCH_TOOL_NAME], 'ask drops ToolSearch')
assert(!ask.mcp__docs__search, 'ask drops tools without a definition')
for (const name of [FILE_READ_TOOL_NAME, GREP_TOOL_NAME]) {
  assert(ask[name], `ask keeps ${name}`)
}

const agent = applyModeRestrictions('agent', tools, { isReadOnly })
assert(agent[WRITE_FILE_TOOL_NAME], 'agent keeps Write')
assert(agent[TOOL_SEARCH_TOOL_NAME], 'agent keeps ToolSearch')

const extra = {
  [EXIT_PLAN_MODE_TOOL_NAME]: fake(EXIT_PLAN_MODE_TOOL_NAME),
}
const planPool = {
  [EDIT_FILE_TOOL_NAME]: fake(EDIT_FILE_TOOL_NAME),
  [WRITE_FILE_TOOL_NAME]: fake(WRITE_FILE_TOOL_NAME),
  [EXIT_PLAN_MODE_TOOL_NAME]: extra[EXIT_PLAN_MODE_TOOL_NAME],
}
const plan = applyModeRestrictions('plan', planPool, { extra, isReadOnly })
assert(plan[EXIT_PLAN_MODE_TOOL_NAME], 'plan injects ExitPlanMode')
const afterDeny = filterToolsRecordByDisallowedGlobs(plan, [
  'Agent',
  'ExitPlanMode',
  'Edit',
  'Write',
])
assert(
  !afterDeny[EXIT_PLAN_MODE_TOOL_NAME],
  'deny after mode drops ExitPlanMode',
)
assert(!afterDeny[EDIT_FILE_TOOL_NAME], 'deny after mode drops Edit')
assert(!afterDeny[WRITE_FILE_TOOL_NAME], 'deny after mode drops Write')

console.log('ask-mode restriction tests OK')
